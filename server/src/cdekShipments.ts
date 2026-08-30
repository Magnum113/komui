import type { FastifyReply, FastifyRequest } from "fastify";
import type { QueryResultRow } from "pg";
import { auditAdminEvent } from "./audit";
import {
  buildCdekOrderRequest,
  buildCdekPackages,
  cdekFirstError,
  cdekNumberFromResponse,
  cdekRequestState,
  createCdekOrder,
  getCdekOrder,
  getCdekOrderByImNumber,
  quoteCdekDelivery,
  type CdekOrderResponse,
} from "./cdek";
import { text } from "./checkout";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { HttpError, errorMessage } from "./errors";

type ShipmentStatus =
  | "pending"
  | "creating"
  | "accepted"
  | "created"
  | "invalid"
  | "failed"
  | "deleting"
  | "deleted"
  | "unknown";

type ShipmentRow = QueryResultRow & {
  id: number;
  order_id: string;
  status: ShipmentStatus;
  cdek_uuid: string | null;
  cdek_number: string | null;
};

type OrderRow = QueryResultRow & {
  id: string;
  order_number: string;
  status: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_phone: string | null;
  delivery_point_code: string | null;
  delivery_city: string | null;
  delivery_address: string | null;
  metadata: unknown;
};

type OrderItemRow = QueryResultRow & {
  product_id: string | null;
  offer_id: string | null;
  sku: string | null;
  product_name: string;
  size: string | null;
  quantity: number;
  unit_price_amount: number;
  product_snapshot: unknown;
};

type CreateShipmentInput = {
  orderId?: string;
  orderNumber?: string;
};

type HandlerContext = {
  config: AppConfig;
  db: Db;
  logger?: Pick<FastifyRequest["log"], "info" | "warn" | "error">;
  provider?: {
    createOrder?: typeof createCdekOrder;
    getOrderByUuid?: typeof getCdekOrder;
    getOrderByImNumber?: typeof getCdekOrderByImNumber;
  };
};

const retryableShipmentStatuses = new Set<ShipmentStatus>([
  "pending",
  "creating",
  "accepted",
  "failed",
  "invalid",
]);
const fulfillableOrderStatuses = new Set(["paid", "partially_refunded"]);

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedMetadata(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return metadataObject(source[key]);
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cdekMerchantOrderNumber(response: CdekOrderResponse): string {
  return (
    text(response.entity?.number, 36) ||
    text(response.entity?.im_number, 36)
  );
}

function freshShipmentStatus(
  response: CdekOrderResponse,
  order: OrderRow,
  expectedUuid = "",
): ShipmentStatus {
  const providerUuid = text(response.entity?.uuid, 80);
  const providerOrderNumber = cdekMerchantOrderNumber(response);
  if (expectedUuid && providerUuid && providerUuid !== expectedUuid) {
    throw new HttpError(
      409,
      "cdek_create_identity_mismatch",
      "CDEK create follow-up returned a different provider UUID",
      {
        uuidMatches: false,
        merchantOrderMatches:
          !providerOrderNumber || providerOrderNumber === order.order_number,
      },
    );
  }
  if (providerOrderNumber && providerOrderNumber !== order.order_number) {
    throw new HttpError(
      409,
      "cdek_create_identity_mismatch",
      "CDEK create response belongs to a different merchant order",
      {
        hasUuid: Boolean(providerUuid),
        merchantOrderMatches: false,
      },
    );
  }

  const providerState = cdekRequestState(response) as ShipmentStatus;
  if (
    providerState === "created" &&
    (!providerUuid || !providerOrderNumber)
  ) {
    return "accepted";
  }
  return providerState;
}

async function syncCdekOrderIdentityAfterCreate(
  context: HandlerContext,
  order: OrderRow,
  shipmentId: number,
  response: Awaited<ReturnType<typeof createCdekOrder>>,
) {
  const uuid = text(response.entity?.uuid, 80);
  if (!uuid) return response;
  if (
    cdekRequestState(response) === "created" &&
    cdekMerchantOrderNumber(response) === order.order_number
  ) {
    return response;
  }

  let latest = response;
  for (const delayMs of [500, 1_500]) {
    await sleep(delayMs);
    context.logger?.info(
      {
        orderId: order.id,
        orderNumber: order.order_number,
        shipmentId,
        cdekUuid: uuid,
        delayMs,
      },
      "CDEK order follow-up sync started",
    );
    try {
      latest = await (
        context.provider?.getOrderByUuid ?? getCdekOrder
      )(context.config, uuid);
      const cdekNumber = cdekNumberFromResponse(latest);
      const latestUuid = text(latest.entity?.uuid, 80);
      const merchantOrderNumber = cdekMerchantOrderNumber(latest);
      const requestState = cdekRequestState(latest);
      context.logger?.info(
        {
          orderId: order.id,
          orderNumber: order.order_number,
          shipmentId,
          cdekUuid: uuid,
          cdekNumber,
          requestState: latest.requests?.[0]?.state ?? null,
          uuidMatches: !latestUuid || latestUuid === uuid,
          merchantOrderMatches:
            merchantOrderNumber === order.order_number,
        },
        "CDEK order follow-up sync finished",
      );
      if (
        latestUuid &&
        latestUuid !== uuid
      ) {
        return latest;
      }
      if (
        merchantOrderNumber &&
        merchantOrderNumber !== order.order_number
      ) {
        return latest;
      }
      if (requestState === "invalid") return latest;
      if (
        requestState === "created" &&
        text(latest.entity?.uuid, 80) &&
        merchantOrderNumber === order.order_number
      ) {
        return latest;
      }
    } catch (error) {
      context.logger?.warn(
        {
          err: error,
          orderId: order.id,
          orderNumber: order.order_number,
          shipmentId,
          cdekUuid: uuid,
        },
        "CDEK order follow-up sync failed",
      );
    }
  }
  return latest;
}

async function existingShipment(
  db: Db,
  orderId: string,
): Promise<ShipmentRow | null> {
  const result = await db.query<ShipmentRow>(
    `
      select id, order_id, status, cdek_uuid, cdek_number
      from public.merch_cdek_shipments
      where order_id = $1::uuid
      limit 1
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

async function loadOrder(
  db: Db,
  input: CreateShipmentInput,
): Promise<OrderRow> {
  const orderId = text(input.orderId, 36);
  const orderNumber = text(input.orderNumber, 36);

  if (!orderId && !orderNumber) {
    throw new HttpError(
      400,
      "order_identifier_required",
      "orderId or orderNumber is required",
    );
  }

  const whereSql = orderId ? "id = $1::uuid" : "order_number = $1";
  const whereValue = orderId || orderNumber;
  const result = await db.query<OrderRow>(
    `
      select
        id,
        order_number,
        status,
        customer_first_name,
        customer_last_name,
        customer_phone,
        delivery_point_code,
        delivery_city,
        delivery_address,
        metadata
      from public.merch_customer_orders
      where ${whereSql}
      limit 1
    `,
    [whereValue],
  );

  const order = result.rows[0];
  if (!order) {
    throw new HttpError(
      404,
      "order_not_found",
      "Order not found for CDEK shipment",
    );
  }
  return order;
}

async function loadOrderItems(db: Db, orderId: string): Promise<OrderItemRow[]> {
  const result = await db.query<OrderItemRow>(
    `
      select
        product_id,
        offer_id,
        sku,
        product_name,
        size,
        quantity,
        unit_price_amount,
        product_snapshot
      from public.merch_customer_order_items
      where order_id = $1::uuid
      order by id asc
    `,
    [orderId],
  );
  return result.rows;
}

function recipientName(order: OrderRow): string {
  return (
    `${text(order.customer_last_name, 120)} ${text(
      order.customer_first_name,
      120,
    )}`.trim() || "Получатель KOMUI"
  );
}

function recipientPhone(order: OrderRow): string {
  const phone = text(order.customer_phone, 32);
  if (!phone) {
    throw new HttpError(
      400,
      "cdek_recipient_phone_missing",
      "Order recipient phone is missing",
    );
  }
  return phone;
}

function deliveryPoint(order: OrderRow): string {
  const point = text(order.delivery_point_code, 40);
  if (!point) {
    throw new HttpError(
      400,
      "cdek_delivery_point_missing",
      "Order delivery point is missing",
    );
  }
  return point;
}

async function insertCreatingShipment(
  context: HandlerContext,
  input: {
    order: OrderRow;
    tariffCode: number;
    tariffName: string | null;
    packages: ReturnType<typeof buildCdekPackages>;
    requestPayload: ReturnType<typeof buildCdekOrderRequest>;
  },
): Promise<ShipmentRow> {
  const { db } = context;
  const { order, tariffCode, tariffName, packages, requestPayload } = input;
  const result = await db.query<ShipmentRow>(
    `
      insert into public.merch_cdek_shipments (
        order_id,
        status,
        tariff_code,
        tariff_name,
        shipment_point,
        delivery_point,
        delivery_city,
        delivery_address,
        package_snapshot,
        request_payload
      )
      values (
        $1::uuid,
        'creating',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9::jsonb
      )
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [
      order.id,
      tariffCode,
      tariffName,
      requestPayload.shipment_point,
      requestPayload.delivery_point,
      order.delivery_city,
      order.delivery_address,
      JSON.stringify(packages),
      JSON.stringify(requestPayload),
    ],
  );
  return result.rows[0];
}

async function resetFailedShipment(
  context: HandlerContext,
  shipmentId: number,
  input: {
    order: OrderRow;
    tariffCode: number;
    tariffName: string | null;
    packages: ReturnType<typeof buildCdekPackages>;
    requestPayload: ReturnType<typeof buildCdekOrderRequest>;
  },
): Promise<boolean> {
  const { db } = context;
  const { order, tariffCode, tariffName, packages, requestPayload } = input;
  const result = await db.query<{ id: number }>(
    `
      update public.merch_cdek_shipments
      set
        status = 'creating',
        tariff_code = $2,
        tariff_name = $3,
        shipment_point = $4,
        delivery_point = $5,
        delivery_city = $6,
        delivery_address = $7,
        package_snapshot = $8::jsonb,
        request_payload = $9::jsonb,
        error_code = null,
        error_message = null
      where id = $1
        and (
          status in ('pending', 'failed', 'invalid')
          or (
            status = 'creating'
            and updated_at < now() - interval '2 minutes'
          )
        )
      returning id
    `,
    [
      shipmentId,
      tariffCode,
      tariffName,
      requestPayload.shipment_point,
      requestPayload.delivery_point,
      order.delivery_city,
      order.delivery_address,
      JSON.stringify(packages),
      JSON.stringify(requestPayload),
    ],
  );
  return Boolean(result.rows[0]);
}

async function markShipmentResult(
  context: HandlerContext,
  shipmentId: number,
  response: Awaited<ReturnType<typeof createCdekOrder>>,
  expectedStatuses: readonly ShipmentStatus[],
  statusOverride?: ShipmentStatus,
): Promise<ShipmentRow> {
  const { db } = context;
  const firstRequest = response.requests?.[0] ?? {};
  const firstError = cdekFirstError(response);
  const result = await db.query<ShipmentRow>(
    `
      update public.merch_cdek_shipments
      set
        status = $2,
        cdek_uuid = $3,
        cdek_number = $4,
        request_uuid = $5,
        response_payload = $6::jsonb,
        error_code = $7,
        error_message = $8,
        synced_at = now()
      where id = $1
        and status = any($9::text[])
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [
      shipmentId,
      statusOverride ?? cdekRequestState(response),
      response.entity?.uuid ?? null,
      cdekNumberFromResponse(response),
      firstRequest.request_uuid ?? null,
      JSON.stringify(response),
      firstError?.code ?? null,
      firstError?.message ?? null,
      expectedStatuses,
    ],
  );
  if (result.rows[0]) return result.rows[0];
  return loadShipmentAfterCasMiss(context, shipmentId, "persist provider result");
}

async function markShipmentFailed(
  context: HandlerContext,
  shipmentId: number,
  error: unknown,
  expectedStatuses: readonly ShipmentStatus[],
): Promise<ShipmentRow> {
  const result = await context.db.query<ShipmentRow>(
    `
      update public.merch_cdek_shipments
      set
        status = 'failed',
        error_message = $2,
        synced_at = now()
      where id = $1
        and status = any($3::text[])
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [shipmentId, errorMessage(error).slice(0, 500), expectedStatuses],
  );
  if (result.rows[0]) return result.rows[0];
  return loadShipmentAfterCasMiss(context, shipmentId, "mark provider request failed");
}

async function currentOrderStatus(db: Db, orderId: string): Promise<string> {
  const result = await db.query<{ status: string }>(
    `
      select status
      from public.merch_customer_orders
      where id = $1::uuid
      limit 1
    `,
    [orderId],
  );
  return result.rows[0]?.status ?? "missing";
}

async function markShipmentCreationCanceled(
  context: HandlerContext,
  shipmentId: number,
): Promise<ShipmentRow> {
  const result = await context.db.query<ShipmentRow>(
    `
      update public.merch_cdek_shipments
      set
        status = 'deleted',
        error_code = 'order_not_fulfillable',
        error_message = 'Shipment creation canceled because order is not fulfillable',
        synced_at = now()
      where id = $1
        and status = 'creating'
        and cdek_uuid is null
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [shipmentId],
  );
  if (result.rows[0]) return result.rows[0];
  return loadShipmentAfterCasMiss(context, shipmentId, "cancel local-only creation");
}

async function loadShipmentAfterCasMiss(
  context: HandlerContext,
  shipmentId: number,
  operation: string,
): Promise<ShipmentRow> {
  const result = await context.db.query<ShipmentRow>(
    `
      /* cdek_shipment:load_after_cas */
      select id, order_id, status, cdek_uuid, cdek_number
      from public.merch_cdek_shipments
      where id = $1
      limit 1
    `,
    [shipmentId],
  );
  const current = result.rows[0];
  if (!current) {
    throw new Error(`CDEK shipment disappeared while attempting to ${operation}`);
  }
  context.logger?.warn(
    {
      shipmentId,
      shipmentStatus: current.status,
      operation,
    },
    "CDEK shipment compare-and-set skipped after concurrent state change",
  );
  return current;
}

function assertReconciledCdekOrder(
  response: CdekOrderResponse,
  order: OrderRow,
  shipment: ShipmentRow,
): void {
  const providerUuid = text(response.entity?.uuid, 80);
  const providerOrderNumber =
    text(response.entity?.number, 36) ||
    text(response.entity?.im_number, 36);
  const providerError = cdekFirstError(response);
  const providerState = cdekRequestState(response);

  if (providerState === "unknown") {
    throw new HttpError(
      409,
      "cdek_reconciliation_rejected",
      "CDEK reconciliation returned an unknown state",
      { providerErrorCode: providerError?.code ?? null },
    );
  }

  if (
    (providerOrderNumber && providerOrderNumber !== order.order_number) ||
    (shipment.cdek_uuid &&
      providerUuid &&
      shipment.cdek_uuid !== providerUuid)
  ) {
    throw new HttpError(
      409,
      "cdek_reconciliation_mismatch",
      "CDEK lookup returned a different merchant order",
      {
        merchantOrderMatches:
          !providerOrderNumber || providerOrderNumber === order.order_number,
        existingUuidMatches:
          !shipment.cdek_uuid ||
          !providerUuid ||
          shipment.cdek_uuid === providerUuid,
      },
    );
  }

  if (providerState === "invalid") return;
  if (providerError) {
    throw new HttpError(
      409,
      "cdek_reconciliation_rejected",
      providerError.message || "CDEK reconciliation was rejected",
      { providerErrorCode: providerError.code ?? null },
    );
  }

  if (!providerUuid || !providerOrderNumber) {
    throw new HttpError(
      503,
      "cdek_reconciliation_pending",
      "CDEK lookup has not returned a complete order identity yet",
      {
        hasUuid: Boolean(providerUuid),
        hasMerchantOrderNumber: Boolean(providerOrderNumber),
      },
    );
  }

}

function isCdekNotFound(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.code === "cdek_request_failed" &&
    error.details.providerStatus === 404
  );
}

export async function createCdekShipmentForOrder(
  context: HandlerContext,
  input: CreateShipmentInput,
): Promise<ShipmentRow | null> {
  const order = await loadOrder(context.db, input);
  context.logger?.info(
    {
      orderId: order.id,
      orderNumber: order.order_number,
      orderStatus: order.status,
      inputOrderId: input.orderId ?? null,
      inputOrderNumber: input.orderNumber ?? null,
      cdekCreateShipments: context.config.CDEK_CREATE_SHIPMENTS,
      cdekMock: context.config.CDEK_MOCK,
    },
    "CDEK shipment flow loaded order",
  );

  const found = await existingShipment(context.db, order.id);
  if (found && !retryableShipmentStatuses.has(found.status)) {
    context.logger?.info(
      {
        orderId: order.id,
        orderNumber: order.order_number,
        shipmentId: found.id,
        shipmentStatus: found.status,
        cdekNumber: found.cdek_number,
        reason: "existing_non_retryable_shipment",
      },
      "CDEK shipment flow returning existing shipment",
    );
    return found;
  }

  if (!fulfillableOrderStatuses.has(order.status)) {
    context.logger?.warn(
      {
        orderId: order.id,
        orderNumber: order.order_number,
        orderStatus: order.status,
        reason: "order_not_fulfillable",
      },
      "CDEK shipment flow skipped",
    );
    return null;
  }

  const items = await loadOrderItems(context.db, order.id);
  const packages = buildCdekPackages(
    order.order_number,
    items.map((item) => {
      const productSnapshot = metadataObject(item.product_snapshot);
      return {
        productId: item.product_id,
        offerId: item.offer_id,
        sku: item.sku,
        productName: item.product_name,
        size: item.size,
        quantity: Number(item.quantity),
        unitPriceAmount: Number(item.unit_price_amount),
        productTypeSlug: text(productSnapshot.product_type_slug, 80),
        categorySlug: text(productSnapshot.category_slug, 80),
        profileKey: text(productSnapshot.cdek_profile, 40),
      };
    }),
    context.config.CDEK_PACKING_HEIGHT_EXTRA_CM,
  );
  context.logger?.info(
    {
      orderId: order.id,
      orderNumber: order.order_number,
      itemCount: items.length,
      packageCount: packages.length,
      totalPackageWeight: packages.reduce((sum, pack) => sum + pack.weight, 0),
    },
    "CDEK shipment package snapshot built",
  );

  const cdekMetadata = nestedMetadata(metadataObject(order.metadata), "cdek");
  let tariffCode =
    numberValue(cdekMetadata.tariff_code) ??
    numberValue(context.config.CDEK_TARIFF_CODE);
  let tariffName = text(cdekMetadata.tariff_name, 160) || null;

  if (!tariffCode) {
    const deliveryCityCode = numberValue(cdekMetadata.delivery_city_code);
    if (!deliveryCityCode) {
      context.logger?.error(
        {
          orderId: order.id,
          orderNumber: order.order_number,
          reason: "delivery_city_code_missing",
        },
        "CDEK shipment flow cannot resolve tariff",
      );
      throw new HttpError(
        400,
        "cdek_delivery_city_code_missing",
        "CDEK delivery city code is missing",
      );
    }
    const quote = await quoteCdekDelivery(context.config, {
      deliveryCityCode,
      packages,
    });
    tariffCode = quote.tariffCode;
    tariffName = quote.tariffName;
  }

  const payload = {
    number: order.order_number,
    tariffCode,
    deliveryPoint: deliveryPoint(order),
    recipientName: recipientName(order),
    recipientPhone: recipientPhone(order),
    packages,
    comment: `KOMUI ${order.order_number}`,
  };
  const requestPayload = buildCdekOrderRequest(context.config, payload);
  context.logger?.info(
    {
      orderId: order.id,
      orderNumber: order.order_number,
      tariffCode,
      tariffName,
      shipmentPoint: requestPayload.shipment_point,
      deliveryPoint: requestPayload.delivery_point,
      packageCount: packages.length,
      retryingShipmentId: found?.id ?? null,
    },
    "CDEK shipment request prepared",
  );

  let shipment = found;
  let reconcileBeforeCreate = Boolean(found);
  if (!shipment) {
    try {
      context.logger?.info(
        {
          orderId: order.id,
          orderNumber: order.order_number,
          tariffCode,
          deliveryPoint: requestPayload.delivery_point,
        },
        "CDEK shipment DB row insert started",
      );
      shipment = await insertCreatingShipment(context, {
        order,
        tariffCode,
        tariffName,
        packages,
        requestPayload,
      });
      context.logger?.info(
        {
          orderId: order.id,
          orderNumber: order.order_number,
          shipmentId: shipment.id,
          shipmentStatus: shipment.status,
        },
        "CDEK shipment DB row inserted",
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      shipment = await existingShipment(context.db, order.id);
      if (shipment && !retryableShipmentStatuses.has(shipment.status)) {
        context.logger?.info(
          {
            orderId: order.id,
            orderNumber: order.order_number,
            shipmentId: shipment.id,
            shipmentStatus: shipment.status,
            reason: "unique_violation_existing_non_retryable_shipment",
          },
          "CDEK shipment flow returning existing shipment after unique violation",
        );
        return shipment;
      }
      if (!shipment) throw error;
      reconcileBeforeCreate = true;
    }
  }

  let resultExpectedStatuses: readonly ShipmentStatus[] = ["creating"];
  try {
    const latestOrderStatus = await currentOrderStatus(context.db, order.id);
    if (!fulfillableOrderStatuses.has(latestOrderStatus)) {
      if (reconcileBeforeCreate) {
        context.logger?.warn(
          {
            orderId: order.id,
            orderNumber: order.order_number,
            shipmentId: shipment.id,
            shipmentStatus: shipment.status,
            latestOrderStatus,
            reason: "ambiguous_shipment_requires_cancellation_reconciliation",
          },
          "CDEK ambiguous shipment preserved after financial cancellation",
        );
        return null;
      }
      const canceled = await markShipmentCreationCanceled(context, shipment.id);
      context.logger?.warn(
        {
          orderId: order.id,
          orderNumber: order.order_number,
          shipmentId: shipment.id,
          latestOrderStatus,
          reason: "order_no_longer_paid",
        },
        "CDEK shipment creation canceled before provider request",
      );
      return canceled;
    }

    if (reconcileBeforeCreate) {
      if (shipment.status === "accepted") {
        resultExpectedStatuses = ["accepted"];
      } else {
        const retryClaimed = await resetFailedShipment(context, shipment.id, {
          order,
          tariffCode,
          tariffName,
          packages,
          requestPayload,
        });
        if (!retryClaimed) {
          const current = await existingShipment(context.db, order.id);
          if (!current) {
            throw new Error("CDEK shipment disappeared while claiming retry");
          }
          if (retryableShipmentStatuses.has(current.status)) {
            throw new HttpError(
              503,
              "cdek_retry_in_progress",
              "CDEK shipment reconciliation is already being processed",
            );
          }
          context.logger?.info(
            {
              orderId: order.id,
              orderNumber: order.order_number,
              shipmentId: current.id,
              shipmentStatus: current.status,
              reason: "reconciliation_claim_not_acquired",
            },
            "CDEK shipment reconciliation is already being processed",
          );
          return current;
        }
      }

      context.logger?.info(
        {
          orderId: order.id,
          orderNumber: order.order_number,
          shipmentId: shipment.id,
          previousShipmentStatus: shipment.status,
        },
        "CDEK ambiguous create reconciliation started",
      );
      let reconciled: CdekOrderResponse | null = null;
      let knownUuidNotFound = false;
      if (shipment.cdek_uuid) {
        try {
          reconciled = await (
            context.provider?.getOrderByUuid ?? getCdekOrder
          )(context.config, shipment.cdek_uuid);
        } catch (error) {
          if (!isCdekNotFound(error)) throw error;
          knownUuidNotFound = true;
        }
      }
      if (!reconciled) {
        reconciled = await (
          context.provider?.getOrderByImNumber ?? getCdekOrderByImNumber
        )(context.config, order.order_number);
      }
      if (reconciled) {
        assertReconciledCdekOrder(reconciled, order, shipment);
        const adopted = await markShipmentResult(
          context,
          shipment.id,
          reconciled,
          resultExpectedStatuses,
        );
        context.logger?.info(
          {
            orderId: order.id,
            orderNumber: order.order_number,
            shipmentId: adopted.id,
            shipmentStatus: adopted.status,
            cdekUuid: adopted.cdek_uuid,
            cdekNumber: adopted.cdek_number,
          },
          "CDEK existing provider order adopted after ambiguous create",
        );
        return adopted;
      }

      throw new HttpError(
        503,
        "cdek_reconciliation_pending",
        "Existing CDEK shipment was not found during reconciliation; automatic create retry is forbidden",
        {
          knownUuidPresent: Boolean(shipment.cdek_uuid),
          knownUuidNotFound,
        },
      );
    }

    context.logger?.info(
      {
        orderId: order.id,
        orderNumber: order.order_number,
        shipmentId: shipment.id,
        tariffCode,
        shipmentPoint: requestPayload.shipment_point,
        deliveryPoint: requestPayload.delivery_point,
        cdekMock: context.config.CDEK_MOCK,
      },
      "CDEK order API request started",
    );
    const response = await (
      context.provider?.createOrder ?? createCdekOrder
    )(context.config, payload);
    // Reject an explicit foreign merchant identity before following any UUID.
    freshShipmentStatus(response, order);
    const syncedResponse = await syncCdekOrderIdentityAfterCreate(
      context,
      order,
      shipment.id,
      response,
    );
    const persistedStatus = freshShipmentStatus(
      syncedResponse,
      order,
      text(response.entity?.uuid, 80),
    );
    const updated = await markShipmentResult(
      context,
      shipment.id,
      syncedResponse,
      ["creating"],
      persistedStatus,
    );
    context.logger?.info(
      {
        orderId: order.id,
        orderNumber: order.order_number,
        shipmentId: updated.id,
        shipmentStatus: updated.status,
        cdekNumber: updated.cdek_number,
        cdekUuid: updated.cdek_uuid,
        requestState: syncedResponse.requests?.[0]?.state ?? null,
        requestUuid: syncedResponse.requests?.[0]?.request_uuid ?? null,
        cdekError: cdekFirstError(syncedResponse)?.message ?? null,
      },
      "CDEK order API request finished",
    );
    return updated;
  } catch (error) {
    const current = await markShipmentFailed(
      context,
      shipment.id,
      error,
      ["creating"],
    ).catch(() => undefined);
    context.logger?.error(
      {
        err: error,
        orderId: order.id,
        orderNumber: order.order_number,
        shipmentId: shipment.id,
      },
      "CDEK order API request failed",
    );
    if (current && ["deleting", "deleted"].includes(current.status)) {
      return current;
    }
    throw error;
  }
}

export async function handleAdminCreateCdekShipment(
  request: FastifyRequest,
  reply: FastifyReply,
  context: HandlerContext,
) {
  const body = bodyObject(request);
  const orderId = text(body.orderId, 36);
  const orderNumber = text(body.orderNumber, 36);
  const confirm = body.confirm === true;

  if (!confirm) {
    throw new HttpError(
      400,
      "confirmation_required",
      "Pass confirm: true to create or retry a real CDEK shipment",
    );
  }

  request.log.info(
    {
      orderId: orderId || null,
      orderNumber: orderNumber || null,
      cdekCreateShipments: context.config.CDEK_CREATE_SHIPMENTS,
      cdekMock: context.config.CDEK_MOCK,
    },
    "Admin CDEK shipment create requested",
  );

  const shipment = await createCdekShipmentForOrder(
    { ...context, logger: request.log },
    {
    orderId: orderId || undefined,
    orderNumber: orderNumber || undefined,
    },
  );

  if (!shipment) {
    throw new HttpError(
      409,
      "order_not_fulfillable",
      "CDEK shipment can be created only for paid or partially refunded orders",
    );
  }

  await auditAdminEvent(
    context.config,
    request,
    "admin.cdek.shipment_create",
    "allowed",
    {
      orderId: shipment.order_id,
      shipmentId: shipment.id,
      status: shipment.status,
      cdekNumber: shipment.cdek_number,
    },
  ).catch(() => undefined);

  return reply.send({
    shipment,
    autoCreateEnabled: context.config.CDEK_CREATE_SHIPMENTS,
  });
}
