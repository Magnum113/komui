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
  quoteCdekDelivery,
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
};

const retryableShipmentStatuses = new Set<ShipmentStatus>([
  "failed",
  "invalid",
]);

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

async function syncCdekOrderNumberAfterAccepted(
  context: HandlerContext,
  order: OrderRow,
  shipmentId: number,
  response: Awaited<ReturnType<typeof createCdekOrder>>,
) {
  const uuid = text(response.entity?.uuid, 80);
  if (!uuid || cdekNumberFromResponse(response)) return response;

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
      latest = await getCdekOrder(context.config, uuid);
      const cdekNumber = cdekNumberFromResponse(latest);
      context.logger?.info(
        {
          orderId: order.id,
          orderNumber: order.order_number,
          shipmentId,
          cdekUuid: uuid,
          cdekNumber,
          requestState: latest.requests?.[0]?.state ?? null,
        },
        "CDEK order follow-up sync finished",
      );
      if (cdekNumber || cdekRequestState(latest) === "created") return latest;
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
): Promise<void> {
  const { db } = context;
  const { order, tariffCode, tariffName, packages, requestPayload } = input;
  await db.query(
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
}

async function markShipmentResult(
  context: HandlerContext,
  shipmentId: number,
  response: Awaited<ReturnType<typeof createCdekOrder>>,
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
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [
      shipmentId,
      cdekRequestState(response),
      response.entity?.uuid ?? null,
      cdekNumberFromResponse(response),
      firstRequest.request_uuid ?? null,
      JSON.stringify(response),
      firstError?.code ?? null,
      firstError?.message ?? null,
    ],
  );
  return result.rows[0];
}

async function markShipmentFailed(
  context: HandlerContext,
  shipmentId: number,
  error: unknown,
): Promise<void> {
  await context.db.query(
    `
      update public.merch_cdek_shipments
      set
        status = 'failed',
        error_message = $2,
        synced_at = now()
      where id = $1
    `,
    [shipmentId, errorMessage(error).slice(0, 500)],
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

  if (!["paid", "authorized"].includes(order.status)) {
    context.logger?.warn(
      {
        orderId: order.id,
        orderNumber: order.order_number,
        orderStatus: order.status,
        reason: "order_not_paid_or_authorized",
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
    }
  } else {
    await resetFailedShipment(context, shipment.id, {
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
        previousShipmentStatus: found?.status ?? null,
      },
      "CDEK failed shipment DB row reset for retry",
    );
  }

  try {
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
    const response = await createCdekOrder(context.config, payload);
    const syncedResponse = await syncCdekOrderNumberAfterAccepted(
      context,
      order,
      shipment.id,
      response,
    );
    const updated = await markShipmentResult(context, shipment.id, syncedResponse);
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
    await markShipmentFailed(context, shipment.id, error).catch(() => undefined);
    context.logger?.error(
      {
        err: error,
        orderId: order.id,
        orderNumber: order.order_number,
        shipmentId: shipment.id,
      },
      "CDEK order API request failed",
    );
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
      "order_not_paid",
      "CDEK shipment can be created only for paid or authorized orders",
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
