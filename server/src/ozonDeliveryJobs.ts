import { enqueueOzonShippingEmail } from "./email/ozonShipment";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { auditAdminEvent } from "./audit";
import {
  ozonClient,
  ozonConfigured,
  OzonApiError,
  refreshOzonPointsPage,
  type OzonPosting,
  type OzonSnapshot,
} from "./ozonDelivery";

type Context = {
  config: AppConfig;
  db: Db;
  logger?: {
    error: (data: unknown, message?: string) => void;
    warn: (data: unknown, message?: string) => void;
  };
};
type Queryable = Pick<PoolClient, "query">;
export type OzonEffectType = "ozon_create" | "ozon_approve" | "ozon_cancel";
type Effect = QueryResultRow & {
  id: string;
  order_id: string;
  effect_type: OzonEffectType;
  attempts: number;
  payload: Record<string, unknown>;
};
export type OzonShipment = QueryResultRow & {
  id: string;
  order_id: string;
  posting_number: string;
  external_order_number: string;
  status: string;
  status_at: string | null;
  error_message: string | null;
  synced_at: string | null;
  updated_at: string;
  raw: Record<string, unknown>;
  return_data?: Record<string, unknown> | null;
};
const names: Record<string, string> = {
  created: "Ожидает сборки",
  forming: "Подтверждается",
  forming_failed: "Ошибка подтверждения",
  ready_for_shipping: "Готово к передаче Ozon",
  in_container: "В грузоместе",
  acceptance_in_progress: "Приёмка Ozon",
  on_way: "В пути",
  not_accepted_to_delivery: "Не принято Ozon",
  in_delivery_point: "Готово к выдаче",
  in_courier_service: "У курьера",
  delivered: "Получено",
  canceled: "Отменено",
};
const returnNames: Record<string, string> = {
  moving: "Возвращается в магазин",
  at_pickup_point: "Возврат ожидает в ПВЗ",
  received: "Возврат получен магазином",
  utilization: "Передано на утилизацию",
  utilized: "Утилизировано",
  written_off: "Списано Ozon",
  looking_for: "Поиск возврата",
};
const receivedStatuses = new Set([
  "on_way",
  "in_delivery_point",
  "in_courier_service",
  "delivered",
]);
export function ozonActions(status: string, paid: boolean): string[] {
  return [
    "sync",
    ...(paid && ["created", "forming_failed"].includes(status)
      ? ["approve"]
      : []),
    ...(["ready_for_shipping", "in_container"].includes(status)
      ? ["label"]
      : []),
    ...(!["delivered", "canceled"].includes(status) ? ["cancel"] : []),
  ];
}
export async function enqueueOzonEffect(
  q: Queryable,
  type: OzonEffectType,
  orderId: string,
  payload: Record<string, unknown> = {},
) {
  const key = `${type}:${orderId}:${payload.shipmentId ?? "all"}`;
  if (type === "ozon_cancel")
    await q.query(
      `update public.merch_order_effects set status='canceled',updated_at=now() where order_id=$1 and effect_type='ozon_approve' and status in ('pending','retry')`,
      [orderId],
    );
  const result = await q.query(
    `insert into public.merch_order_effects(order_id,effect_type,dedupe_key,payload) values($1,$2,$3,$4::jsonb) on conflict(dedupe_key) do update set payload=merch_order_effects.payload||excluded.payload,status=case when merch_order_effects.status in ('completed','needs_review','canceled') then 'pending' else merch_order_effects.status end, attempts=case when merch_order_effects.status in ('completed','needs_review','canceled') then 0 else merch_order_effects.attempts end,available_at=now(),updated_at=now() returning *`,
    [orderId, type, key, JSON.stringify(payload)],
  );
  return result.rows[0];
}
export async function loadOzonShipping(db: Db, orderId: string, paid: boolean) {
  const shipments = (
    await db.query<OzonShipment>(
      `select * from public.merch_ozon_delivery_shipments where order_id=$1 order by id`,
      [orderId],
    )
  ).rows;
  const order = (
    await db.query<{ metadata: Record<string, unknown> }>(
      `select metadata from public.merch_customer_orders where id=$1`,
      [orderId],
    )
  ).rows[0];
  const canceled = order?.metadata?.ozon_cancel_requested === true;
  const effects = (
    await db.query<{ last_error: string | null; status: string }>(
      `select last_error,status from public.merch_order_effects where order_id=$1 and effect_type like 'ozon_%' and status in ('pending','retry','processing','needs_review') order by id desc limit 1`,
      [orderId],
    )
  ).rows;
  const first = shipments[0];
  return {
    provider: "ozon",
    package:
      (order?.metadata?.ozon as OzonSnapshot | undefined)?.posting
        ?.dimensions ?? null,
    status:
      canceled && !first
        ? "canceled"
        : (first?.status ??
          (effects[0]?.status === "needs_review" ? "needs_review" : "pending")),
    statusName:
      canceled && !first
        ? "Доставка отменена"
        : first
          ? first.return_data?.status
            ? (returnNames[String(first.return_data.status)] ??
              String(first.return_data.status))
            : (names[first.status] ?? first.status)
          : "Подготавливаем отправление",
    number: first?.posting_number ?? null,
    orderNumber: first?.external_order_number ?? null,
    updatedAt: first?.synced_at ?? null,
    error: effects[0]?.last_error ?? first?.error_message ?? null,
    availableActions: canceled
      ? [
          ...(first ? ["sync"] : []),
          ...(effects[0]?.status === "needs_review" ? ["cancel"] : []),
        ]
      : effects.some((e) => e.status === "processing")
        ? []
        : first
          ? ozonActions(first.status, paid)
          : paid
            ? ["retry", "cancel"]
            : [],
    shipments: shipments.map((s) => ({
      id: String(s.id),
      number: s.posting_number,
      orderNumber: s.external_order_number,
      status: s.status,
      statusName: s.return_data?.status
        ? (returnNames[String(s.return_data.status)] ??
          String(s.return_data.status))
        : (names[s.status] ?? s.status),
      returnInfo: s.return_data
        ? {
            number: s.return_data.return_number,
            status: s.return_data.status,
            statusName:
              returnNames[String(s.return_data.status)] ?? s.return_data.status,
            updatedAt: s.return_data.status_changed_at,
            address: s.return_data.current_placement_address,
          }
        : null,
      updatedAt: s.synced_at,
      error: s.error_message,
      availableActions: canceled ? ["sync"] : ozonActions(s.status, paid),
    })),
  };
}
export async function loadOzonEvents(db: Db, orderId: string) {
  return (
    await db.query(
      `select id,posting_number as "number",status,status_at as "statusAt",received_at as "receivedAt" from public.merch_ozon_delivery_events where order_id=$1 order by status_at desc limit 100`,
      [orderId],
    )
  ).rows.map((r) => ({ ...r, statusName: names[r.status] ?? r.status }));
}
async function updatePosting(
  db: Db,
  config: AppConfig,
  posting: OzonPosting,
  orderId: string,
  history: Array<{ status: string; status_changed_at: string }>,
) {
  await db.withTransaction(async (q) => {
    const changed = await q.query(
      `update public.merch_ozon_delivery_shipments set status=$2,status_at=$3,raw=$4::jsonb,error_message=null,synced_at=now(),next_sync_at=now()+interval '10 minutes',updated_at=now() where posting_number=$1 and order_id=$5 and (status_at is null or status_at<$3::timestamptz or (status_at=$3::timestamptz and status=$2)) returning id`,
      [
        posting.posting_number,
        posting.status,
        posting.status_changed_at,
        JSON.stringify(posting),
        orderId,
      ],
    );
    for (const h of [
      ...history,
      { status: posting.status, status_changed_at: posting.status_changed_at },
    ])
      await q.query(
        `insert into public.merch_ozon_delivery_events(order_id,posting_number,status,status_at) values($1,$2,$3,$4) on conflict do nothing`,
        [orderId, posting.posting_number, h.status, h.status_changed_at],
      );
    if (!changed.rows.length) return;
    if (
      config.OZON_DELIVERY_STATUS_EMAILS_SINCE &&
      Date.parse(posting.status_changed_at) >=
        Date.parse(config.OZON_DELIVERY_STATUS_EMAILS_SINCE)
    ) {
      if (posting.status === "on_way")
        await enqueueOzonShippingEmail(
          q,
          orderId,
          "shipment_handed_over",
          posting.posting_number,
        );
      if (posting.status === "in_delivery_point")
        await enqueueOzonShippingEmail(
          q,
          orderId,
          "shipment_ready",
          posting.posting_number,
        );
    }
    if (posting.status === "canceled")
      await q.query(
        `update public.merch_customer_orders set fulfillment_status='canceled',updated_at=now() where id=$1 and delivery_provider='ozon' and fulfillment_status not in ('delivered','returned')`,
        [orderId],
      );
    if (receivedStatuses.has(posting.status))
      await q.query(
        `update public.merch_customer_orders set fulfillment_status=case when $2='delivered' then 'delivered' else 'shipped' end,shipped_at=coalesce(shipped_at,now()),delivered_at=case when $2='delivered' then coalesce(delivered_at,now()) else delivered_at end,updated_at=now() where id=$1 and delivery_provider='ozon' and fulfillment_status in ('new','processing','shipped')`,
        [orderId, posting.status],
      );
  });
}
export async function syncOzonShipment(
  context: Context,
  shipment: OzonShipment,
) {
  const client = ozonClient(context.config);
  const info = await client.call<{ postings: OzonPosting[] }>(
    "/v1/posting/info",
    { posting_numbers: [shipment.posting_number] },
  );
  const posting = info.postings.find(
    (p) => p.posting_number === shipment.posting_number,
  );
  if (!posting || posting.order_number !== shipment.external_order_number)
    throw new OzonApiError(502, "PostingIdentityMismatch", null);
  posting.status = posting.status.toLowerCase();
  if (!Number.isFinite(Date.parse(posting.status_changed_at)))
    throw new OzonApiError(502, "InvalidPostingTimestamp", null);
  const events = await client.call<{
    history: Array<{ status: string; status_changed_at: string }>;
  }>("/v1/posting/status-history", { posting_number: shipment.posting_number });
  await updatePosting(
    context.db,
    context.config,
    posting,
    shipment.order_id,
    (events.history ?? []).map((h) => ({
      ...h,
      status: h.status.toLowerCase(),
    })),
  );
  const saved = (
    await context.db.query<{ raw: OzonPosting }>(
      `select raw from public.merch_ozon_delivery_shipments where posting_number=$1`,
      [shipment.posting_number],
    )
  ).rows[0];
  return saved?.raw?.status ? saved.raw : posting;
}
async function createPosting(context: Context, order: Record<string, any>) {
  let stored = (
    await context.db.query<{
      idempotency_key: string;
      request_payload: Record<string, any>;
      external_order_number: string | null;
    }>(
      `select idempotency_key,request_payload,external_order_number from public.merch_ozon_delivery_orders where order_id=$1`,
      [order.id],
    )
  ).rows[0];
  if (stored?.external_order_number) return;
  if (!stored && order.metadata?.ozon_cancel_requested) return;
  if (!stored) {
    const snapshot = order.metadata?.ozon as OzonSnapshot | undefined;
    if (!snapshot?.posting || !snapshot?.point)
      throw new HttpError(
        422,
        "ozon_snapshot_missing",
        "В заказе отсутствуют параметры Ozon",
      );
    if (Date.parse(snapshot.posting.cutoff_at) <= Date.now())
      throw new HttpError(
        422,
        "ozon_cutoff_expired",
        "Плановая дата отгрузки Ozon истекла. Требуется проверка",
      );
    const request = {
      order_external_id: order.order_number,
      recipient: {
        phone_number: order.customer_phone,
        full_name: `${order.customer_last_name} ${order.customer_first_name}`,
      },
      delivery: {
        delivery_point: { delivery_point_id: snapshot.point.delivery_point_id },
      },
      postings: [
        {
          ...snapshot.posting,
          posting_external_id: `${order.order_number}-1`,
          description: `Одежда KOMUI, заказ ${order.order_number}`,
        },
      ],
    };
    await context.db.query(
      `insert into public.merch_ozon_delivery_orders(order_id,idempotency_key,request_payload) values($1,$2,$3::jsonb) on conflict do nothing`,
      [order.id, randomUUID(), JSON.stringify(request)],
    );
    stored = (
      await context.db.query<{
        idempotency_key: string;
        request_payload: Record<string, any>;
        external_order_number: string | null;
      }>(
        `select idempotency_key,request_payload,external_order_number from public.merch_ozon_delivery_orders where order_id=$1`,
        [order.id],
      )
    ).rows[0];
  }
  // Never change a persisted body/key after a timeout: the original request may exist at Ozon.
  const result = await ozonClient(context.config).call<{
    order_number: string;
    order_external_id?: string;
    postings: Array<{
      posting_number: string;
      request_id: number;
      posting_external_id?: string;
    }>;
  }>("/v1/order/create", stored.request_payload, {
    idempotencyKey: stored.idempotency_key,
  });
  if (
    !result.order_number ||
    (result.order_external_id != null &&
      result.order_external_id !== order.order_number) ||
    !Array.isArray(result.postings) ||
    result.postings.length !== 1 ||
    result.postings[0].request_id !== 1 ||
    !result.postings[0].posting_number ||
    (result.postings[0].posting_external_id != null &&
      result.postings[0].posting_external_id !== `${order.order_number}-1`)
  )
    throw new OzonApiError(502, "InvalidCreateResponse", null);
  const financialStatus = await context.db.withTransaction(async (q) => {
    await q.query(
      `update public.merch_ozon_delivery_orders set external_order_number=$2,updated_at=now() where order_id=$1`,
      [order.id, result.order_number],
    );
    for (const p of result.postings) {
      const savedShipment = await q.query(
        `insert into public.merch_ozon_delivery_shipments(order_id,posting_number,external_order_number) values($1,$2,$3) on conflict(posting_number) do update set posting_number=excluded.posting_number where merch_ozon_delivery_shipments.order_id=excluded.order_id and merch_ozon_delivery_shipments.external_order_number=excluded.external_order_number returning id`,
        [order.id, p.posting_number, result.order_number],
      );
      if (!savedShipment.rows.length)
        throw new OzonApiError(502, "PostingIdentityConflict", null);
    }
    const state = (
      await q.query(
        `select status from public.merch_customer_orders where id=$1 for update`,
        [order.id],
      )
    ).rows[0];
    if (!["paid", "partially_refunded"].includes(state.status))
      await enqueueOzonEffect(q, "ozon_cancel", order.id, {
        reason: "payment_changed_during_create",
      });
    return state.status;
  });
  if (financialStatus === "partially_refunded")
    throw new HttpError(422, "partial_refund_review", "После частичного возврата нужна проверка состава отправления");
}
async function processEffect(context: Context, effect: Effect) {
  const db = context.db;
  const order = (
    await db.query(`select * from public.merch_customer_orders where id=$1`, [
      effect.order_id,
    ])
  ).rows[0];
  if (!order || order.delivery_provider !== "ozon")
    throw new HttpError(
      422,
      "wrong_delivery_provider",
      "Заказ не относится к доставке Ozon",
    );
  if (effect.effect_type === "ozon_create") {
    if (order.status !== "paid") {
      // Reconcile a previously sent create first; its stable key safely returns the original result.
      const prior = (
        await db.query(
          `select 1 from public.merch_ozon_delivery_orders where order_id=$1`,
          [order.id],
        )
      ).rows[0];
      if (!prior) {
        if (order.status === "partially_refunded")
          throw new HttpError(
            422,
            "partial_refund_review",
            "После частичного возврата нужна проверка состава отправления",
          );
        return;
      }
    }
    await createPosting(context, order);
    return;
  }
  if (
    effect.effect_type === "ozon_approve" &&
    (order.metadata?.ozon_cancel_requested ||
      order.status !== "paid" ||
      ["canceled", "returned"].includes(order.fulfillment_status))
  )
    throw new HttpError(
      422,
      "order_not_paid",
      "Подтверждать можно только оплаченный заказ",
    );
  // A financial cancellation may be superseded by a later valid CONFIRMED event.
  if (
    effect.effect_type === "ozon_cancel" &&
    !effect.payload.manual &&
    !order.metadata?.ozon_cancel_requested &&
    order.status === "paid"
  )
    return;
  const shipments = (
    await db.query<OzonShipment>(
      `select * from public.merch_ozon_delivery_shipments where order_id=$1 and ($2::bigint is null or id=$2) order by id`,
      [order.id, effect.payload.shipmentId ?? null],
    )
  ).rows;
  if (!shipments.length) {
    const prior = (
      await db.query(
        `select 1 from public.merch_ozon_delivery_orders where order_id=$1 and external_order_number is null`,
        [order.id],
      )
    ).rows[0];
    if (prior) {
      await createPosting(context, order);
      throw new OzonApiError(503, "ReconcileCreatedBeforeCancel", null);
    }
    if (effect.payload.manual)
      await db.query(
        `update public.merch_customer_orders set fulfillment_status='canceled',updated_at=now() where id=$1 and fulfillment_status in ('new','processing')`,
        [order.id],
      );
    if (effect.effect_type === "ozon_approve")
      throw new HttpError(
        422,
        "shipment_missing",
        "Отправление ещё не создано",
      );
    return;
  }
  for (const shipment of shipments) {
    const posting = await syncOzonShipment(context, shipment);
    if (effect.effect_type === "ozon_approve") {
      if (
        [
          "forming",
          "ready_for_shipping",
          "in_container",
          "acceptance_in_progress",
          "on_way",
          "in_delivery_point",
          "in_courier_service",
          "delivered",
        ].includes(posting.status)
      )
        continue;
      if (!["created", "forming_failed"].includes(posting.status))
        throw new HttpError(
          422,
          "ozon_invalid_state",
          "Отправление нельзя подтвердить в текущем статусе",
        );
      await ozonClient(context.config).call("/v1/posting/approve", {
        posting_number: shipment.posting_number,
      });
      await db.query(
        `update public.merch_customer_orders set fulfillment_status='processing',updated_at=now() where id=$1 and fulfillment_status='new' and status='paid'`,
        [order.id],
      );
    } else {
      if (posting.status === "canceled") continue;
      if (posting.status === "delivered")
        throw new HttpError(
          422,
          "shipment_delivered",
          "Полученное отправление нельзя отменить",
        );
      await ozonClient(context.config).call("/v1/posting/cancel", {
        posting_number: shipment.posting_number,
      });
    }
    const updated = await syncOzonShipment(context, shipment);
    if (effect.effect_type === "ozon_cancel" && updated.status !== "canceled")
      throw new OzonApiError(503, "CancellationPending", null);
  }
}
export async function processOzonEffects(context: Context) {
  if (
    !context.config.OZON_DELIVERY_WORKER_ENABLED ||
    !ozonConfigured(context.config)
  )
    return;
  for (let n = 0; n < 5; n++) {
    const worker = randomUUID();
    const effect = (
      await context.db.query<Effect>(
        `with candidate as (select id from public.merch_order_effects where effect_type in ('ozon_create','ozon_approve','ozon_cancel') and ((status in ('pending','retry') and available_at<=now()) or (status='processing' and locked_at<now()-interval '5 minutes')) order by case when effect_type='ozon_cancel' then 0 else 1 end,id for update skip locked limit 1) update public.merch_order_effects e set status='processing',locked_by=$1,locked_at=now(),attempts=e.attempts+1,updated_at=now() from candidate c where e.id=c.id returning e.*`,
        [worker],
      )
    ).rows[0];
    if (!effect) break;
    const client = await context.db.pool.connect();
    let locked = false;
    try {
      locked = (
        await client.query<{ locked: boolean }>(
          `select pg_try_advisory_lock(hashtextextended($1,0)) as locked`,
          [`ozon:${effect.order_id}`],
        )
      ).rows[0].locked;
      if (!locked) throw new OzonApiError(503, "OrderBusy", null);
      // Route all work through the locked session, including short transactions.
      // This also works when DATABASE_POOL_MAX=1.
      const scopedDb = {
        ...context.db,
        query: client.query.bind(client),
        withTransaction: async <T>(fn: (q: PoolClient) => Promise<T>) => {
          await client.query("begin");
          try {
            const value = await fn(client);
            await client.query("commit");
            return value;
          } catch (e) {
            await client.query("rollback");
            throw e;
          }
        },
      } as Db;
      await processEffect({ ...context, db: scopedDb }, effect);
      const finished = await client.query(
        `update public.merch_order_effects set status='completed',completed_at=now(),last_error=null,locked_by=null,locked_at=null,updated_at=now() where id=$1 and locked_by=$2 and payload=$3::jsonb returning id`,
        [effect.id, worker, JSON.stringify(effect.payload)],
      );
      // A newer financial transition may have changed this effect while its
      // provider call was in flight. Do not consume that new intent.
      if (!finished.rows.length)
        await client.query(
          `update public.merch_order_effects set status='pending',locked_by=null,locked_at=null,available_at=now(),updated_at=now() where id=$1 and locked_by=$2`,
          [effect.id, worker],
        );
    } catch (error) {
      const review =
        (error instanceof HttpError && error.statusCode < 500) ||
        effect.attempts >= 12;
      const message =
        error instanceof HttpError
          ? error.message
          : "Временная ошибка связи с Ozon";
      await client.query(
        `update public.merch_order_effects set status=case when payload=$6::jsonb then $3 else 'pending' end,last_error=case when payload=$6::jsonb then $4 else null end,available_at=case when payload=$6::jsonb then now()+($5::int*interval '1 second') else now() end,locked_by=null,locked_at=null,updated_at=now() where id=$1 and locked_by=$2`,
        [
          effect.id,
          worker,
          review ? "needs_review" : "retry",
          message,
          Math.min(3600, 30 * 2 ** Math.min(effect.attempts, 7)),
          JSON.stringify(effect.payload),
        ],
      );
      context.logger?.warn(
        {
          orderId: effect.order_id,
          effect: effect.effect_type,
          code: error instanceof HttpError ? error.code : "network",
        },
        "Ozon delivery operation deferred",
      );
    } finally {
      if (locked)
        await client
          .query(`select pg_advisory_unlock(hashtextextended($1,0))`, [
            `ozon:${effect.order_id}`,
          ])
          .catch(() => {});
      client.release();
    }
  }
}
export async function handleOzonShippingAction(
  request: FastifyRequest,
  reply: FastifyReply,
  context: Context,
) {
  const params = z
    .object({
      orderId: z.string().uuid(),
      action: z.enum(["approve", "cancel", "sync", "retry", "label"]),
    })
    .parse(request.params);
  const input = z
    .object({ shipmentId: z.coerce.number().int().positive().optional() })
    .parse(request.method === "GET" ? request.query : (request.body ?? {}));
  const order = (
    await context.db.query(
      `select id,status,delivery_provider,metadata from public.merch_customer_orders where id=$1`,
      [params.orderId],
    )
  ).rows[0];
  if (!order) throw new HttpError(404, "order_not_found", "Заказ не найден");
  if (order.delivery_provider !== "ozon")
    throw new HttpError(
      409,
      "wrong_delivery_provider",
      "Эта операция доступна только для доставки Ozon",
    );
  if (
    !context.config.OZON_DELIVERY_WORKER_ENABLED ||
    !ozonConfigured(context.config)
  )
    throw new HttpError(
      503,
      "ozon_disabled",
      "Обработка отправлений Ozon отключена",
    );
  const shipments = (
    await context.db.query<OzonShipment>(
      `select * from public.merch_ozon_delivery_shipments where order_id=$1 and ($2::bigint is null or id=$2) order by id`,
      [params.orderId, input.shipmentId ?? null],
    )
  ).rows;
  if (
    order.metadata?.ozon_cancel_requested &&
    ["approve", "retry"].includes(params.action)
  )
    throw new HttpError(
      409,
      "ozon_cancellation_requested",
      "Отмена доставки уже запрошена",
    );
  if (
    params.action === "cancel" &&
    shipments.some((s) => s.status === "delivered")
  )
    throw new HttpError(
      409,
      "shipment_delivered",
      "Полученное отправление нельзя отменить",
    );
  if (params.action === "approve" && !shipments.length)
    throw new HttpError(409, "shipment_missing", "Отправление ещё не создано");
  if (input.shipmentId && !shipments.length)
    throw new HttpError(404, "shipment_not_found", "Отправление не найдено");
  await auditAdminEvent(
    context.config,
    request,
    `komui.ozon.${params.action}`,
    "allowed",
    { orderId: params.orderId, shipmentId: input.shipmentId ?? null },
  );
  if (params.action === "label") {
    if (shipments.length !== 1)
      throw new HttpError(409, "shipment_required", "Выберите отправление");
    const posting = await syncOzonShipment(context, shipments[0]);
    if (!ozonActions(posting.status, order.status === "paid").includes("label"))
      throw new HttpError(
        409,
        "label_not_ready",
        "Этикетка доступна после подтверждения готовности",
      );
    const pdf = await ozonClient(context.config).call<Buffer>(
      "/v1/posting/label",
      { posting_number: shipments[0].posting_number },
      { binary: true },
    );
    return reply
      .header("Content-Type", "application/pdf")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Disposition",
        `attachment; filename="ozon-label-${shipments[0].id}.pdf"`,
      )
      .send(pdf);
  }
  if (params.action === "sync") {
    for (const shipment of shipments) await syncOzonShipment(context, shipment);
  } else {
    if (["approve", "retry"].includes(params.action) && order.status !== "paid")
      throw new HttpError(409, "order_not_paid", "Нужна подтверждённая оплата");
    await context.db.withTransaction(async (q) => {
      if (params.action === "cancel") {
        await q.query(
          `update public.merch_customer_orders set metadata=metadata||jsonb_build_object('ozon_cancel_requested',true),updated_at=now() where id=$1`,
          [params.orderId],
        );
      }
      if (params.action === "retry") {
        const existing = await q.query(
          `update public.merch_order_effects set status='pending',attempts=0,available_at=now(),last_error=null,updated_at=now() where order_id=$1 and effect_type like 'ozon_%' and status in ('needs_review','retry') returning id`,
          [params.orderId],
        );
        if (!existing.rows.length && !shipments.length)
          await enqueueOzonEffect(q, "ozon_create", params.orderId, {
            manual: true,
          });
      } else
        await enqueueOzonEffect(
          q,
          params.action === "approve" ? "ozon_approve" : "ozon_cancel",
          params.orderId,
          { manual: true, shipmentId: input.shipmentId ?? null },
        );
    });
  }
  return {
    ok: true,
    shipping: await loadOzonShipping(
      context.db,
      params.orderId,
      order.status === "paid",
    ),
  };
}

/** Return records are matched to an existing posting identity, never to a buyer. */
export async function syncOzonReturnsPage(context: Context) {
  const method = context.config.OZON_DELIVERY_SHIPMENT_METHOD_ID;
  if (!method) return;
  await context.db.query(
    `insert into public.merch_ozon_delivery_cache(shipment_method_id) values($1) on conflict do nothing`,
    [method],
  );
  const state = (
    await context.db.query<{ return_cursor: string | null }>(
      `select return_cursor from public.merch_ozon_delivery_cache where shipment_method_id=$1`,
      [method],
    )
  ).rows[0];
  const page = await ozonClient(context.config).call<{
    returns: Array<{
      return_number: string;
      return_external_id?: string;
      status: string;
      status_changed_at: string;
      [key: string]: unknown;
    }>;
    next_cursor?: string;
  }>("/v1/return/search", {
    filters: { shipment_method_id: method },
    pagination: {
      limit: 100,
      ...(state?.return_cursor ? { cursor: state.return_cursor } : {}),
    },
  });
  for (const item of page.returns ?? []) {
    if (!Number.isFinite(Date.parse(item.status_changed_at))) continue;
    item.status = item.status.toLowerCase();
    await context.db.withTransaction(async (q) => {
      // Official response examples identify a canceled posting by its posting number.
      // Additionally validate the merchant id when Ozon includes it; do not infer a
      // relationship from phone/address or create an order for an unmatched return.
      const changed = await q.query<{ order_id: string }>(
        `update public.merch_ozon_delivery_shipments s set return_data=$2::jsonb,return_status_at=$3,updated_at=now() from public.merch_customer_orders o where s.order_id=o.id and s.posting_number=$1 and ($4::text is null or $4=o.order_number||'-1') and (s.return_status_at is null or s.return_status_at<=$3::timestamptz) returning s.order_id`,
        [
          item.return_number,
          JSON.stringify(item),
          item.status_changed_at,
          item.return_external_id ?? null,
        ],
      );
      if (changed.rows[0] && item.status === "received")
        await q.query(
          `update public.merch_customer_orders set fulfillment_status='returned',updated_at=now() where id=$1 and delivery_provider='ozon'`,
          [changed.rows[0].order_id],
        );
    });
  }
  if (page.next_cursor && page.next_cursor === state?.return_cursor)
    throw new OzonApiError(502, "RepeatedReturnCursor", null);
  await context.db.query(
    `update public.merch_ozon_delivery_cache set return_cursor=$2 where shipment_method_id=$1`,
    [method, page.next_cursor ?? null],
  );
}

export function startOzonDeliveryWorker(context: Context) {
  let stopping = false;
  let running: Promise<void> | null = null;
  let lastSync = 0;
  const tick = () => {
    if (
      stopping ||
      running ||
      !context.config.OZON_DELIVERY_WORKER_ENABLED ||
      !ozonConfigured(context.config)
    )
      return;
    running = (async () => {
      await processOzonEffects(context);
      if (context.config.OZON_DELIVERY_ENABLED) {
        try {
          for (let page = 0; page < 5; page++)
            await refreshOzonPointsPage(context.db, context.config);
        } catch (e) {
          context.logger?.warn(
            { code: e instanceof HttpError ? e.code : "cache_error" },
            "Ozon point cache refresh deferred",
          );
        }
      }
      if (
        Date.now() - lastSync >=
        context.config.OZON_DELIVERY_SYNC_INTERVAL_MS
      ) {
        lastSync = Date.now();
        try {
          await syncOzonReturnsPage(context);
        } catch (e) {
          context.logger?.warn(
            { code: e instanceof HttpError ? e.code : "return_sync_error" },
            "Ozon return sync deferred",
          );
        }
        const shipments = (
          await context.db.query<OzonShipment>(
            `select * from public.merch_ozon_delivery_shipments where status not in ('delivered','canceled') and next_sync_at<=now() order by next_sync_at limit 10`,
          )
        ).rows;
        for (const s of shipments) {
          try {
            await syncOzonShipment(context, s);
          } catch {
            await context.db.query(
              `update public.merch_ozon_delivery_shipments set error_message='Не удалось обновить статус Ozon',next_sync_at=now()+interval '10 minutes' where id=$1`,
              [s.id],
            );
          }
        }
      }
    })()
      .catch((e) =>
        context.logger?.error(
          { code: e instanceof HttpError ? e.code : "worker_error" },
          "Ozon worker failed",
        ),
      )
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 10000);
  timer.unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    if (running) await running;
  };
}
