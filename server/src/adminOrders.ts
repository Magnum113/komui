import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import { auditAdminEvent } from "./audit";
import { text } from "./checkout";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { HttpError } from "./errors";

const ORDER_COLUMNS = `
  id,
  order_number,
  status,
  fulfillment_status,
  fulfillment_note,
  customer_first_name,
  customer_last_name,
  customer_phone,
  marketing_consent,
  legal_accepted_at,
  delivery_provider,
  delivery_point_code,
  delivery_city,
  delivery_address,
  delivery_hours,
  delivery_eta,
  delivery_amount,
  subtotal_amount,
  discount_amount,
  total_amount,
  currency,
  promo_code,
  source,
  metadata,
  paid_at,
  shipped_at,
  delivered_at,
  created_at,
  updated_at
`;

const paymentStatuses = [
  "created",
  "pending_payment",
  "authorized",
  "paid",
  "payment_failed",
  "payment_review",
  "canceled",
  "partially_refunded",
  "refunded",
] as const;

const fulfillmentStatuses = [
  "new",
  "processing",
  "shipped",
  "delivered",
  "canceled",
  "returned",
] as const;

const listOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  q: z.string().trim().max(120).optional(),
  paymentStatus: z.enum(paymentStatuses).optional(),
  status: z.enum(paymentStatuses).optional(),
  fulfillmentStatus: z.enum(fulfillmentStatuses).optional(),
  dateFrom: z.string().trim().max(40).optional(),
  dateTo: z.string().trim().max(40).optional(),
});

const updateFulfillmentSchema = z
  .object({
    status: z.enum(fulfillmentStatuses),
    note: z.string().max(2_000).nullable().optional(),
  })
  .strict();

const markShippedSchema = z
  .object({
    note: z.string().max(2_000).nullable().optional(),
  })
  .strict()
  .default({});

const orderIdSchema = z.string().uuid();

type AdminOrdersContext = {
  config: AppConfig;
  db: Db;
};

type Queryable = {
  query: <T extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

type PaymentStatus = (typeof paymentStatuses)[number];
type FulfillmentStatus = (typeof fulfillmentStatuses)[number];

type OrderRow = QueryResultRow & {
  id: string;
  order_number: string;
  status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  fulfillment_note: string | null;
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  marketing_consent: boolean;
  legal_accepted_at: Date | string;
  delivery_provider: string;
  delivery_point_code: string;
  delivery_city: string;
  delivery_address: string;
  delivery_hours: string | null;
  delivery_eta: string | null;
  delivery_amount: number;
  subtotal_amount: number;
  discount_amount: number;
  total_amount: number;
  currency: string;
  promo_code: string | null;
  source: string;
  metadata: unknown;
  paid_at: Date | string | null;
  shipped_at: Date | string | null;
  delivered_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type OrderListRow = OrderRow & {
  item_count: string | number | null;
  line_count: string | number | null;
  latest_provider_status: string | null;
  latest_payment_error_code: string | null;
  latest_payment_error_message: string | null;
  cdek_status: string | null;
  cdek_uuid: string | null;
  cdek_number: string | null;
  cdek_error_message: string | null;
};

type OrderItemRow = QueryResultRow & {
  id: string | number;
  product_id: string | null;
  offer_id: string | null;
  sku: string | null;
  product_name: string;
  size: string;
  quantity: number;
  unit_price_amount: number;
  line_total_amount: number;
  image_url: string | null;
  product_snapshot: unknown;
  created_at: Date | string;
};

type PaymentAttemptRow = QueryResultRow & {
  id: string | number;
  provider: string;
  terminal_key: string;
  external_payment_id: string | null;
  provider_status: string;
  amount: number;
  payment_url: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  confirmed_at: Date | string | null;
};

type PaymentEventRow = QueryResultRow & {
  id: string | number;
  external_payment_id: string | null;
  provider_status: string | null;
  amount: number | null;
  received_at: Date | string;
};

type CdekShipmentRow = QueryResultRow & {
  id: string | number;
  status: string;
  cdek_uuid: string | null;
  cdek_number: string | null;
  request_uuid: string | null;
  tariff_code: number;
  tariff_name: string | null;
  shipment_point: string;
  delivery_point: string;
  delivery_city: string | null;
  delivery_address: string | null;
  package_snapshot: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  synced_at: Date | string | null;
};

type CdekEventRow = QueryResultRow & {
  id: string | number;
  event_type: string | null;
  status_code: string | null;
  status_name: string | null;
  received_at: Date | string;
};

export type AdminOrderSummary = {
  id: string;
  orderNumber: string;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  fulfillmentNote: string | null;
  customer: {
    firstName: string;
    lastName: string;
    phone: string;
    marketingConsent: boolean;
  };
  delivery: {
    provider: string;
    pointCode: string;
    city: string;
    address: string;
    hours: string | null;
    eta: string | null;
  };
  amounts: {
    subtotal: number;
    discount: number;
    delivery: number;
    total: number;
    currency: string;
  };
  promoCode: string | null;
  source: string;
  itemCount: number;
  lineCount: number;
  latestPayment: {
    providerStatus: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  cdek: {
    status: string | null;
    uuid: string | null;
    number: string | null;
    errorMessage: string | null;
  };
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function isoDate(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (item) => `\\${item}`);
}

function orderIdFromRequest(request: FastifyRequest) {
  const params = request.params as { orderId?: unknown };
  return orderIdSchema.parse(params.orderId);
}

export function toAdminOrderSummary(row: OrderListRow): AdminOrderSummary {
  return {
    id: row.id,
    orderNumber: row.order_number,
    paymentStatus: row.status,
    fulfillmentStatus: row.fulfillment_status,
    fulfillmentNote: row.fulfillment_note,
    customer: {
      firstName: row.customer_first_name,
      lastName: row.customer_last_name,
      phone: row.customer_phone,
      marketingConsent: row.marketing_consent,
    },
    delivery: {
      provider: row.delivery_provider,
      pointCode: row.delivery_point_code,
      city: row.delivery_city,
      address: row.delivery_address,
      hours: row.delivery_hours,
      eta: row.delivery_eta,
    },
    amounts: {
      subtotal: numberValue(row.subtotal_amount),
      discount: numberValue(row.discount_amount),
      delivery: numberValue(row.delivery_amount),
      total: numberValue(row.total_amount),
      currency: row.currency,
    },
    promoCode: row.promo_code,
    source: row.source,
    itemCount: numberValue(row.item_count),
    lineCount: numberValue(row.line_count),
    latestPayment: {
      providerStatus: row.latest_provider_status,
      errorCode: row.latest_payment_error_code,
      errorMessage: row.latest_payment_error_message,
    },
    cdek: {
      status: row.cdek_status,
      uuid: row.cdek_uuid,
      number: row.cdek_number,
      errorMessage: row.cdek_error_message,
    },
    paidAt: isoDate(row.paid_at),
    shippedAt: isoDate(row.shipped_at),
    deliveredAt: isoDate(row.delivered_at),
    createdAt: isoDate(row.created_at) ?? "",
    updatedAt: isoDate(row.updated_at) ?? "",
  };
}

function toAdminOrderItem(row: OrderItemRow) {
  return {
    id: Number(row.id),
    productId: row.product_id,
    offerId: row.offer_id,
    sku: row.sku,
    productName: row.product_name,
    size: row.size,
    quantity: Number(row.quantity),
    unitPriceAmount: Number(row.unit_price_amount),
    lineTotalAmount: Number(row.line_total_amount),
    imageUrl: row.image_url,
    productSnapshot: metadataObject(row.product_snapshot),
    createdAt: isoDate(row.created_at),
  };
}

function toPaymentAttempt(row: PaymentAttemptRow) {
  return {
    id: Number(row.id),
    provider: row.provider,
    terminalKey: row.terminal_key,
    externalPaymentId: row.external_payment_id,
    providerStatus: row.provider_status,
    amount: Number(row.amount),
    paymentUrl: row.payment_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    confirmedAt: isoDate(row.confirmed_at),
  };
}

function toPaymentEvent(row: PaymentEventRow) {
  return {
    id: Number(row.id),
    externalPaymentId: row.external_payment_id,
    providerStatus: row.provider_status,
    amount: row.amount === null ? null : Number(row.amount),
    receivedAt: isoDate(row.received_at),
  };
}

function toCdekShipment(row: CdekShipmentRow | undefined) {
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    uuid: row.cdek_uuid,
    number: row.cdek_number,
    requestUuid: row.request_uuid,
    tariffCode: Number(row.tariff_code),
    tariffName: row.tariff_name,
    shipmentPoint: row.shipment_point,
    deliveryPoint: row.delivery_point,
    deliveryCity: row.delivery_city,
    deliveryAddress: row.delivery_address,
    packageSnapshot: Array.isArray(row.package_snapshot)
      ? row.package_snapshot
      : [],
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    syncedAt: isoDate(row.synced_at),
  };
}

function toCdekEvent(row: CdekEventRow) {
  return {
    id: Number(row.id),
    eventType: row.event_type,
    statusCode: row.status_code,
    statusName: row.status_name,
    receivedAt: isoDate(row.received_at),
  };
}

function orderSelectSql() {
  return `
    select
      o.${ORDER_COLUMNS.trim().replaceAll("\n  ", "\n      o.")},
      coalesce(items.item_count, 0)::text as item_count,
      coalesce(items.line_count, 0)::text as line_count,
      payment.provider_status as latest_provider_status,
      payment.error_code as latest_payment_error_code,
      payment.error_message as latest_payment_error_message,
      shipment.status as cdek_status,
      shipment.cdek_uuid,
      shipment.cdek_number,
      shipment.error_message as cdek_error_message
    from public.merch_customer_orders o
    left join lateral (
      select
        coalesce(sum(quantity), 0)::integer as item_count,
        count(*)::integer as line_count
      from public.merch_customer_order_items
      where order_id = o.id
    ) items on true
    left join lateral (
      select provider_status, error_code, error_message
      from public.merch_payment_attempts
      where order_id = o.id
      order by created_at desc
      limit 1
    ) payment on true
    left join public.merch_cdek_shipments shipment
      on shipment.order_id = o.id
  `;
}

function listWhere(
  query: z.infer<typeof listOrdersQuerySchema>,
  values: unknown[],
) {
  const where: string[] = [];
  const paymentStatus = query.paymentStatus ?? query.status;
  if (paymentStatus) {
    values.push(paymentStatus);
    where.push(`o.status = $${values.length}`);
  }
  if (query.fulfillmentStatus) {
    values.push(query.fulfillmentStatus);
    where.push(`o.fulfillment_status = $${values.length}`);
  }
  if (query.dateFrom) {
    values.push(query.dateFrom);
    where.push(`o.created_at >= $${values.length}::timestamptz`);
  }
  if (query.dateTo) {
    values.push(query.dateTo);
    where.push(`o.created_at <= $${values.length}::timestamptz`);
  }
  if (query.q) {
    values.push(`%${escapeLike(query.q)}%`);
    const index = values.length;
    where.push(`
      (
        o.order_number ilike $${index} escape '\\'
        or o.customer_phone ilike $${index} escape '\\'
        or o.customer_first_name ilike $${index} escape '\\'
        or o.customer_last_name ilike $${index} escape '\\'
        or o.delivery_city ilike $${index} escape '\\'
        or o.delivery_point_code ilike $${index} escape '\\'
      )
    `);
  }
  return where.length ? `where ${where.join(" and ")}` : "";
}

async function loadOrderSummary(
  client: Queryable,
  orderId: string,
  forUpdate = false,
) {
  const result = await client.query<OrderListRow>(
    `
      ${orderSelectSql()}
      where o.id = $1::uuid
      ${forUpdate ? "for update of o" : ""}
    `,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "order_not_found", "Order not found");
  return row;
}

async function loadOrderDetails(db: Db, orderId: string) {
  const [items, paymentAttempts, paymentEvents, shipments, cdekEvents] =
    await Promise.all([
      db.query<OrderItemRow>(
        `
          select
            id,
            product_id,
            offer_id,
            sku,
            product_name,
            size,
            quantity,
            unit_price_amount,
            line_total_amount,
            image_url,
            product_snapshot,
            created_at
          from public.merch_customer_order_items
          where order_id = $1::uuid
          order by id asc
        `,
        [orderId],
      ),
      db.query<PaymentAttemptRow>(
        `
          select
            id,
            provider,
            terminal_key,
            external_payment_id,
            provider_status,
            amount,
            payment_url,
            error_code,
            error_message,
            created_at,
            updated_at,
            confirmed_at
          from public.merch_payment_attempts
          where order_id = $1::uuid
          order by created_at desc
        `,
        [orderId],
      ),
      db.query<PaymentEventRow>(
        `
          select id, external_payment_id, provider_status, amount, received_at
          from public.merch_payment_events
          where order_id = $1::uuid
          order by received_at desc
          limit 50
        `,
        [orderId],
      ),
      db.query<CdekShipmentRow>(
        `
          select
            id,
            status,
            cdek_uuid,
            cdek_number,
            request_uuid,
            tariff_code,
            tariff_name,
            shipment_point,
            delivery_point,
            delivery_city,
            delivery_address,
            package_snapshot,
            error_code,
            error_message,
            created_at,
            updated_at,
            synced_at
          from public.merch_cdek_shipments
          where order_id = $1::uuid
          limit 1
        `,
        [orderId],
      ),
      db.query<CdekEventRow>(
        `
          select id, event_type, status_code, status_name, received_at
          from public.merch_cdek_events
          where order_id = $1::uuid
          order by received_at desc
          limit 50
        `,
        [orderId],
      ),
    ]);

  return {
    items: items.rows.map(toAdminOrderItem),
    paymentAttempts: paymentAttempts.rows.map(toPaymentAttempt),
    paymentEvents: paymentEvents.rows.map(toPaymentEvent),
    cdekShipment: toCdekShipment(shipments.rows[0]),
    cdekEvents: cdekEvents.rows.map(toCdekEvent),
  };
}

function ensureCanShip(order: OrderListRow) {
  if (order.fulfillment_status === "shipped") return;
  if (order.fulfillment_status === "delivered") {
    throw new HttpError(
      409,
      "order_already_delivered",
      "Order is already marked as delivered",
    );
  }
  if (["canceled", "returned"].includes(order.fulfillment_status)) {
    throw new HttpError(
      409,
      "order_fulfillment_closed",
      "Order fulfillment is already closed",
    );
  }
  if (!["paid", "authorized"].includes(order.status)) {
    throw new HttpError(
      409,
      "order_not_ready_to_ship",
      "Only paid or authorized orders can be marked as shipped",
      { paymentStatus: order.status },
    );
  }
}

async function setFulfillmentStatus(
  client: PoolClient,
  order: OrderListRow,
  input: {
    status: FulfillmentStatus;
    note?: string | null;
  },
) {
  if (input.status === "shipped") ensureCanShip(order);
  if (input.status === "delivered" && !["shipped", "delivered"].includes(order.fulfillment_status)) {
    ensureCanShip(order);
  }

  const note = nullableText(input.note);
  const result = await client.query<OrderListRow>(
    `
      update public.merch_customer_orders
      set
        fulfillment_status = $2,
        fulfillment_note = case when $3::boolean then $4 else fulfillment_note end,
        shipped_at = case
          when $2 in ('shipped', 'delivered') then coalesce(shipped_at, now())
          else shipped_at
        end,
        delivered_at = case
          when $2 = 'delivered' then coalesce(delivered_at, now())
          else delivered_at
        end
      where id = $1::uuid
      returning ${ORDER_COLUMNS}
    `,
    [order.id, input.status, note !== undefined, note ?? null],
  );

  const updated = result.rows[0];
  if (!updated) throw new HttpError(404, "order_not_found", "Order not found");
  return loadOrderSummary(client, updated.id);
}

export async function handleAdminListOrders(
  request: FastifyRequest,
  _reply: FastifyReply,
  { db }: AdminOrdersContext,
) {
  const query = listOrdersQuerySchema.parse(request.query);
  const values: unknown[] = [];
  const whereSql = listWhere(query, values);

  const listValues = [...values, query.limit, query.offset];
  const [orders, count] = await Promise.all([
    db.query<OrderListRow>(
      `
        ${orderSelectSql()}
        ${whereSql}
        order by o.created_at desc, o.id desc
        limit $${values.length + 1}
        offset $${values.length + 2}
      `,
      listValues,
    ),
    db.query<{ total: string }>(
      `
        select count(*)::text as total
        from public.merch_customer_orders o
        ${whereSql}
      `,
      values,
    ),
  ]);

  return {
    orders: orders.rows.map(toAdminOrderSummary),
    pagination: {
      limit: query.limit,
      offset: query.offset,
      total: Number(count.rows[0]?.total ?? 0),
    },
    statuses: {
      payment: paymentStatuses,
      fulfillment: fulfillmentStatuses,
    },
  };
}

export async function handleAdminGetOrder(
  request: FastifyRequest,
  _reply: FastifyReply,
  { db }: AdminOrdersContext,
) {
  const orderId = orderIdFromRequest(request);
  const order = await loadOrderSummary(db, orderId);
  const details = await loadOrderDetails(db, orderId);
  return {
    order: toAdminOrderSummary(order),
    ...details,
  };
}

export async function handleAdminUpdateOrderFulfillment(
  request: FastifyRequest,
  _reply: FastifyReply,
  { config, db }: AdminOrdersContext,
) {
  const orderId = orderIdFromRequest(request);
  const payload = updateFulfillmentSchema.parse(request.body);
  const updated = await db.withTransaction(async (client) => {
    const order = await loadOrderSummary(client, orderId, true);
    return setFulfillmentStatus(client, order, {
      status: payload.status,
      note: payload.note,
    });
  });

  await auditAdminEvent(
    config,
    request,
    "admin.storefront_order.fulfillment_update",
    "allowed",
    {
      orderId,
      orderNumber: updated.order_number,
      paymentStatus: updated.status,
      fulfillmentStatus: updated.fulfillment_status,
    },
  ).catch(() => undefined);

  return { order: toAdminOrderSummary(updated) };
}

export async function handleAdminMarkOrderShipped(
  request: FastifyRequest,
  _reply: FastifyReply,
  { config, db }: AdminOrdersContext,
) {
  const orderId = orderIdFromRequest(request);
  const payload = markShippedSchema.parse(request.body ?? {});
  const updated = await db.withTransaction(async (client) => {
    const order = await loadOrderSummary(client, orderId, true);
    return setFulfillmentStatus(client, order, {
      status: "shipped",
      note: payload.note,
    });
  });

  await auditAdminEvent(
    config,
    request,
    "admin.storefront_order.mark_shipped",
    "allowed",
    {
      orderId,
      orderNumber: updated.order_number,
      paymentStatus: updated.status,
      fulfillmentStatus: updated.fulfillment_status,
      shippedAt: isoDate(updated.shipped_at),
    },
  ).catch(() => undefined);

  return { order: toAdminOrderSummary(updated) };
}
