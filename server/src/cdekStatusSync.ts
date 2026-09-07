import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { PoolClient, QueryResultRow } from "pg";
import {
  cdekNumberFromResponse,
  getCdekOrder,
  type CdekOrderResponse,
} from "./cdek";
import {
  cdekDeliveredStatusCodes,
  cdekInTransitStatusCodes,
  cdekReadyStatusCodes,
  cdekTerminalStatusCodes,
} from "./cdekDeliveryStatuses";
import type { AppConfig } from "./config";
import type { Db } from "./db";

type StatusSyncLogger = {
  info?: (values: Record<string, unknown>, message: string) => void;
  warn?: (values: Record<string, unknown>, message: string) => void;
  error?: (values: Record<string, unknown>, message: string) => void;
};

type StatusSyncContext = {
  config: AppConfig;
  db: Db;
  logger?: StatusSyncLogger;
};

type DueShipmentRow = QueryResultRow & {
  id: string | number;
  order_id: string;
  cdek_uuid: string;
};

type LockedShipmentRow = QueryResultRow & {
  shipment_id: string | number;
  order_id: string;
  shipment_status: string;
  cdek_uuid: string;
  cdek_number: string | null;
  order_number: string;
  order_status: string;
  fulfillment_status: string;
  customer_first_name: string;
  customer_email: string | null;
  delivery_point_code: string;
  delivery_city: string;
  delivery_address: string;
  delivery_hours: string | null;
  delivery_eta: string | null;
  order_metadata: unknown;
  shipment_created_at: Date | string;
};

type NormalizedCdekStatus = {
  code: string;
  name: string | null;
  dateTime: string;
  timestamp: number;
  reasonCode: string | null;
  city: string | null;
  deleted: boolean;
  eventHash: string;
};

type ShipmentEmailEvent = "shipment_handed_over" | "shipment_ready";

export type ProcessCdekStatusSyncResult = {
  claimed: number;
  synced: number;
  eventsStored: number;
  emailsEnqueued: number;
  skipped: number;
  failed: number;
};

export type ProcessCdekStatusSyncOptions = {
  limit?: number;
  getOrder?: typeof getCdekOrder;
  workerId?: string;
};

const closedShipmentStatuses = new Set([
  "deleting",
  "deleted",
  "failed",
  "invalid",
]);
const financiallyEligibleOrderStatuses = new Set(["paid", "partially_refunded"]);
const postamatDeliveryModes = new Set([6, 7, 10]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function boundedText(value: unknown, maxLength = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function validIsoDate(value: unknown): string | null {
  const normalized = boundedText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized
    ? normalized
    : null;
}

function validIsoTimestamp(value: unknown): string | null {
  const normalized = boundedText(value, 80);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Moscow",
  }).format(date);
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Moscow",
  }).format(date);
}

function statusHash(cdekUuid: string, status: Omit<NormalizedCdekStatus, "eventHash">) {
  return createHash("sha256")
    .update(
      [cdekUuid, status.code, status.dateTime, status.deleted ? "1" : "0"].join(
        "\u0000",
      ),
    )
    .digest("hex");
}

export function normalizeCdekStatuses(
  response: CdekOrderResponse,
  cdekUuid: string,
): NormalizedCdekStatus[] {
  const normalized: NormalizedCdekStatus[] = [];
  for (const rawStatus of response.statuses ?? []) {
    const code = boundedText(rawStatus.code, 100).toUpperCase();
    const dateTime = validIsoTimestamp(rawStatus.date_time);
    if (!code || !dateTime) continue;
    const base = {
      code,
      name: boundedText(rawStatus.name, 160) || null,
      dateTime,
      timestamp: new Date(dateTime).getTime(),
      reasonCode: boundedText(rawStatus.reason_code, 100) || null,
      city: boundedText(rawStatus.city, 160) || null,
      deleted: rawStatus.deleted === true,
    };
    normalized.push({ ...base, eventHash: statusHash(cdekUuid, base) });
  }
  return normalized.sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.code.localeCompare(right.code);
  });
}

function latestActiveStatus(statuses: NormalizedCdekStatus[]) {
  return [...statuses].reverse().find((status) => !status.deleted) ?? null;
}

export function deliveryEmailEvent(
  latest: NormalizedCdekStatus | null,
  cutoff: Date,
): ShipmentEmailEvent | null {
  if (!latest || latest.timestamp < cutoff.getTime()) return null;
  if (cdekReadyStatusCodes.has(latest.code)) return "shipment_ready";
  if (cdekInTransitStatusCodes.has(latest.code)) return "shipment_handed_over";
  return null;
}

export function cdekStatusSyncConfigurationError(
  config: AppConfig,
): string | null {
  if (!config.CDEK_STATUS_SYNC_ENABLED) return null;
  if (!config.CDEK_CREATE_SHIPMENTS) {
    return "CDEK_STATUS_SYNC_ENABLED requires CDEK_CREATE_SHIPMENTS=true";
  }
  if (!config.EMAIL_ENABLED || !config.EMAIL_WORKER_ENABLED) {
    return "CDEK status emails require EMAIL_ENABLED=true and EMAIL_WORKER_ENABLED=true";
  }
  if (!config.CDEK_STATUS_EMAILS_SINCE) {
    return "CDEK status sync requires CDEK_STATUS_EMAILS_SINCE";
  }
  if (
    !config.CDEK_MOCK &&
    !(
      (config.CDEK_LOGIN || config.CDEK_CLIENT_ID) &&
      (config.CDEK_PASSWORD || config.CDEK_CLIENT_SECRET)
    )
  ) {
    return "CDEK status sync requires provider credentials";
  }
  return null;
}

async function dueShipments(
  context: StatusSyncContext,
  limit: number,
  cutoff: Date,
): Promise<DueShipmentRow[]> {
  const result = await context.db.query<DueShipmentRow>(
    `
      /* cdek_status_sync:due */
      select id, order_id, cdek_uuid
      from public.merch_cdek_shipments
      where cdek_uuid is not null
        and delivery_status_terminal is false
        and status not in ('deleting', 'deleted', 'failed', 'invalid')
        and created_at >= $2::timestamptz
        and delivery_status_next_sync_at <= now()
      order by delivery_status_next_sync_at, id
      limit $1
    `,
    [limit, cutoff.toISOString()],
  );
  return result.rows;
}

async function lockShipment(
  client: PoolClient,
  shipmentId: number,
): Promise<LockedShipmentRow | null> {
  const result = await client.query<LockedShipmentRow>(
    `
      /* cdek_status_sync:lock */
      select
        shipment.id as shipment_id,
        shipment.order_id,
        shipment.status as shipment_status,
        shipment.cdek_uuid,
        shipment.cdek_number,
        orders.order_number,
        orders.status as order_status,
        orders.fulfillment_status,
        orders.customer_first_name,
        orders.customer_email,
        orders.delivery_point_code,
        orders.delivery_city,
        orders.delivery_address,
        orders.delivery_hours,
        orders.delivery_eta,
        orders.metadata as order_metadata,
        shipment.created_at as shipment_created_at
      from public.merch_cdek_shipments shipment
      join public.merch_customer_orders orders on orders.id = shipment.order_id
      where shipment.id = $1
      for update of shipment, orders
    `,
    [shipmentId],
  );
  return result.rows[0] ?? null;
}

async function storeStatusEvents(
  client: PoolClient,
  shipment: LockedShipmentRow,
  cdekNumber: string | null,
  statuses: NormalizedCdekStatus[],
): Promise<number> {
  if (!statuses.length) return 0;
  const payload = statuses.map((status) => ({
    code: status.code,
    name: status.name,
    dateTime: status.dateTime,
    reasonCode: status.reasonCode,
    city: status.city,
    deleted: status.deleted,
    eventHash: status.eventHash,
  }));
  const result = await client.query(
    `
      /* cdek_status_sync:store_events */
      insert into public.merch_cdek_events (
        shipment_id,
        order_id,
        cdek_uuid,
        cdek_number,
        event_type,
        status_code,
        status_name,
        event_hash,
        payload,
        status_at,
        reason_code,
        status_city,
        status_deleted
      )
      select
        $1,
        $2::uuid,
        $3,
        $4,
        'status',
        item ->> 'code',
        nullif(item ->> 'name', ''),
        item ->> 'eventHash',
        item - 'eventHash',
        (item ->> 'dateTime')::timestamptz,
        nullif(item ->> 'reasonCode', ''),
        nullif(item ->> 'city', ''),
        coalesce((item ->> 'deleted')::boolean, false)
      from jsonb_array_elements($5::jsonb) item
      on conflict (event_hash) do nothing
      returning id
    `,
    [
      shipment.shipment_id,
      shipment.order_id,
      shipment.cdek_uuid,
      cdekNumber,
      JSON.stringify(payload),
    ],
  );
  return result.rows.length;
}

function deliveryPointType(
  response: CdekOrderResponse,
  metadata: Record<string, unknown>,
): "pickup_point" | "postamat" {
  const cdekMetadata = metadataObject(metadata.cdek);
  const providerMode = finiteInteger(response.delivery_mode);
  const storedMode = finiteInteger(cdekMetadata.delivery_mode);
  const pointType = boundedText(cdekMetadata.delivery_point_type, 40).toUpperCase();
  if (
    (providerMode !== null && postamatDeliveryModes.has(providerMode)) ||
    (storedMode !== null && postamatDeliveryModes.has(storedMode)) ||
    pointType.includes("POSTAMAT")
  ) {
    return "postamat";
  }
  return "pickup_point";
}

function eventPayload(
  event: ShipmentEmailEvent,
  shipment: LockedShipmentRow,
  response: CdekOrderResponse,
  cdekNumber: string,
  plannedDeliveryDate: string | null,
  keepFreeUntil: string | null,
) {
  const metadata = metadataObject(shipment.order_metadata);
  const cdekMetadata = metadataObject(metadata.cdek);
  if (event === "shipment_handed_over") {
    return {
      schemaVersion: 1,
      customerFirstName: boundedText(shipment.customer_first_name, 80),
      orderNumber: boundedText(shipment.order_number, 80),
      cdekNumber,
      deliveryCity: boundedText(shipment.delivery_city, 100),
      deliveryAddress: boundedText(shipment.delivery_address, 220),
      estimatedDeliveryDate:
        formatDate(plannedDeliveryDate) || boundedText(shipment.delivery_eta, 100) || null,
    };
  }
  return {
    schemaVersion: 1,
    customerFirstName: boundedText(shipment.customer_first_name, 80),
    orderNumber: boundedText(shipment.order_number, 80),
    cdekNumber,
    deliveryPointType: deliveryPointType(response, metadata),
    deliveryPointName:
      boundedText(cdekMetadata.delivery_point_name, 160) || null,
    deliveryPointCode: boundedText(shipment.delivery_point_code, 40) || null,
    deliveryCity: boundedText(shipment.delivery_city, 100),
    deliveryAddress: boundedText(shipment.delivery_address, 220),
    deliveryHours: boundedText(shipment.delivery_hours, 160) || null,
    storageUntil: formatTimestamp(keepFreeUntil),
  };
}

async function enqueueEmail(
  client: PoolClient,
  event: ShipmentEmailEvent,
  shipment: LockedShipmentRow,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const recipientEmail = boundedText(shipment.customer_email, 320).toLowerCase();
  if (
    !financiallyEligibleOrderStatuses.has(shipment.order_status) ||
    !emailPattern.test(recipientEmail)
  ) {
    return false;
  }
  const idempotencyKey = `${event.replaceAll("_", "-")}:${shipment.order_id}`;
  const inserted = await client.query(
    `
      /* cdek_status_sync:enqueue_email */
      insert into public.merch_email_outbox (
        order_id,
        contact_id,
        event_type,
        message_class,
        recipient_email,
        template_key,
        payload,
        idempotency_key
      )
      values (
        $1::uuid,
        (
          select id
          from public.merch_email_contacts
          where email_normalized = $2
          limit 1
        ),
        $3,
        'transactional',
        $2,
        $3,
        $4::jsonb,
        $5
      )
      on conflict (idempotency_key) do nothing
      returning id
    `,
    [
      shipment.order_id,
      recipientEmail,
      event,
      JSON.stringify(payload),
      idempotencyKey,
    ],
  );
  return inserted.rows.length === 1;
}

async function markFulfillmentFromDeliveryStatus(
  client: PoolClient,
  shipment: LockedShipmentRow,
  latest: NormalizedCdekStatus | null,
) {
  if (!latest) return;
  if (cdekDeliveredStatusCodes.has(latest.code)) {
    await client.query(
      `
        /* cdek_status_sync:fulfillment_delivered */
        update public.merch_customer_orders
        set fulfillment_status = 'delivered',
            delivered_at = coalesce(delivered_at, $2::timestamptz)
        where id = $1::uuid
          and fulfillment_status in ('new', 'processing', 'shipped')
      `,
      [shipment.order_id, latest.dateTime],
    );
    return;
  }
  if (
    cdekInTransitStatusCodes.has(latest.code) ||
    cdekReadyStatusCodes.has(latest.code)
  ) {
    await client.query(
      `
        /* cdek_status_sync:fulfillment_shipped */
        update public.merch_customer_orders
        set fulfillment_status = 'shipped',
            shipped_at = coalesce(shipped_at, $2::timestamptz)
        where id = $1::uuid
          and fulfillment_status in ('new', 'processing')
      `,
      [shipment.order_id, latest.dateTime],
    );
  }
}

async function persistResponse(
  context: StatusSyncContext,
  due: DueShipmentRow,
  response: CdekOrderResponse,
  cutoff: Date,
): Promise<{ eventsStored: number; emailEnqueued: boolean; skipped: boolean }> {
  const statuses = normalizeCdekStatuses(response, due.cdek_uuid);
  const latest = latestActiveStatus(statuses);
  const plannedDeliveryDate = validIsoDate(response.planned_delivery_date);
  const keepFreeUntil = validIsoTimestamp(response.keep_free_until);
  const providerUuid = boundedText(response.entity?.uuid, 80);
  if (providerUuid && providerUuid !== due.cdek_uuid) {
    throw new Error("cdek_status_uuid_mismatch");
  }
  const deliveryMode = finiteInteger(response.delivery_mode);

  return context.db.withTransaction(async (client) => {
    const shipment = await lockShipment(client, Number(due.id));
    if (
      !shipment ||
      shipment.cdek_uuid !== due.cdek_uuid ||
      closedShipmentStatuses.has(shipment.shipment_status)
    ) {
      return { eventsStored: 0, emailEnqueued: false, skipped: true };
    }
    const cdekNumber =
      cdekNumberFromResponse(response) || boundedText(shipment.cdek_number, 80) || null;
    const eventsStored = await storeStatusEvents(
      client,
      shipment,
      cdekNumber,
      statuses,
    );
    await client.query(
      `
        /* cdek_status_sync:update_shipment */
        update public.merch_cdek_shipments
        set cdek_number = coalesce($2, cdek_number),
            delivery_status_code = coalesce($3, delivery_status_code),
            delivery_status_name = case when $3 is null then delivery_status_name else $4 end,
            delivery_status_at = coalesce($5::timestamptz, delivery_status_at),
            delivery_status_city = case when $3 is null then delivery_status_city else $6 end,
            delivery_status_terminal = case when $3 is null then delivery_status_terminal else $7 end,
            delivery_status_synced_at = now(),
            delivery_status_sync_attempts = 0,
            delivery_status_sync_error = null,
            delivery_status_next_sync_at = now() + ($8::double precision * interval '1 millisecond'),
            planned_delivery_date = coalesce($9::date, planned_delivery_date),
            keep_free_until = coalesce($10::timestamptz, keep_free_until),
            delivery_mode = coalesce($11::integer, delivery_mode),
            synced_at = now()
        where id = $1
      `,
      [
        shipment.shipment_id,
        cdekNumber,
        latest?.code ?? null,
        latest?.name ?? null,
        latest?.dateTime ?? null,
        latest?.city ?? null,
        latest ? cdekTerminalStatusCodes.has(latest.code) : false,
        context.config.CDEK_STATUS_SYNC_INTERVAL_MS,
        plannedDeliveryDate,
        keepFreeUntil,
        deliveryMode,
      ],
    );
    await markFulfillmentFromDeliveryStatus(client, shipment, latest);

    const shipmentCreatedAt = new Date(shipment.shipment_created_at).getTime();
    const isRolloutEligible =
      Number.isFinite(shipmentCreatedAt) && shipmentCreatedAt >= cutoff.getTime();
    const event = isRolloutEligible ? deliveryEmailEvent(latest, cutoff) : null;
    if (!event || !cdekNumber) {
      return { eventsStored, emailEnqueued: false, skipped: false };
    }
    const payload = eventPayload(
      event,
      shipment,
      response,
      cdekNumber,
      plannedDeliveryDate,
      keepFreeUntil,
    );
    const emailEnqueued = await enqueueEmail(client, event, shipment, payload);
    return { eventsStored, emailEnqueued, skipped: false };
  });
}

async function markSyncFailure(
  context: StatusSyncContext,
  due: DueShipmentRow,
  error: unknown,
) {
  const message = boundedText(error instanceof Error ? error.message : error, 500);
  await context.db.query(
    `
      /* cdek_status_sync:failure */
      update public.merch_cdek_shipments
      set delivery_status_sync_attempts = delivery_status_sync_attempts + 1,
          delivery_status_sync_error = $2,
          delivery_status_next_sync_at = now() + (
            least(
              3600,
              60 * power(2, least(delivery_status_sync_attempts, 5))
            ) * interval '1 second'
          )
      where id = $1
        and cdek_uuid = $3
    `,
    [due.id, message || "cdek_status_sync_failed", due.cdek_uuid],
  );
}

export async function processCdekStatusSync(
  context: StatusSyncContext,
  options: ProcessCdekStatusSyncOptions = {},
): Promise<ProcessCdekStatusSyncResult> {
  if (!context.config.CDEK_STATUS_SYNC_ENABLED) {
    return {
      claimed: 0,
      synced: 0,
      eventsStored: 0,
      emailsEnqueued: 0,
      skipped: 0,
      failed: 0,
    };
  }
  const configurationError = cdekStatusSyncConfigurationError(context.config);
  if (configurationError) throw new Error(configurationError);
  const limit = Math.max(
    1,
    Math.min(
      50,
      Math.trunc(options.limit ?? context.config.CDEK_STATUS_SYNC_BATCH_SIZE),
    ),
  );
  const getOrder = options.getOrder ?? getCdekOrder;
  const cutoff = new Date(context.config.CDEK_STATUS_EMAILS_SINCE!);
  const rows = await dueShipments(context, limit, cutoff);
  const result: ProcessCdekStatusSyncResult = {
    claimed: rows.length,
    synced: 0,
    eventsStored: 0,
    emailsEnqueued: 0,
    skipped: 0,
    failed: 0,
  };

  for (const due of rows) {
    try {
      const response = await getOrder(context.config, due.cdek_uuid);
      const persisted = await persistResponse(context, due, response, cutoff);
      if (persisted.skipped) {
        result.skipped += 1;
        continue;
      }
      result.synced += 1;
      result.eventsStored += persisted.eventsStored;
      if (persisted.emailEnqueued) result.emailsEnqueued += 1;
    } catch (error) {
      result.failed += 1;
      await markSyncFailure(context, due, error).catch(() => undefined);
      context.logger?.warn?.(
        {
          shipmentId: Number(due.id),
          orderId: due.order_id,
          code: boundedText(error instanceof Error ? error.message : error, 120),
        },
        "CDEK delivery status synchronization failed",
      );
    }
  }

  if (rows.length || result.failed) {
    context.logger?.info?.(
      {
        workerId:
          boundedText(options.workerId, 160) ||
          `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
        ...result,
      },
      "CDEK delivery status synchronization batch finished",
    );
  }
  return result;
}

export function startCdekStatusSyncWorker(
  context: StatusSyncContext,
): () => Promise<void> {
  if (!context.config.CDEK_STATUS_SYNC_ENABLED) {
    context.logger?.info?.({}, "CDEK delivery status sync is disabled");
    return async () => undefined;
  }
  const configurationError = cdekStatusSyncConfigurationError(context.config);
  if (configurationError) {
    context.logger?.error?.(
      { code: "cdek_status_sync_not_configured" },
      configurationError,
    );
    return async () => undefined;
  }

  const workerId = `${hostname()}:${process.pid}:cdek-status`;
  let stopped = false;
  let running = false;
  let inFlight: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return inFlight ?? Promise.resolve();
    running = true;
    const current = processCdekStatusSync(context, { workerId })
      .then(() => undefined)
      .catch((error) => {
        context.logger?.error?.(
          { code: boundedText(error instanceof Error ? error.message : error, 120) },
          "CDEK delivery status synchronization batch failed",
        );
      })
      .finally(() => {
        running = false;
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  void run();
  const timer = setInterval(
    () => void run(),
    context.config.CDEK_STATUS_SYNC_INTERVAL_MS,
  );
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
