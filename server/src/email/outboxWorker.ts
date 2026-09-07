import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { z } from "zod";
import {
  cdekInTransitStatusCodes,
  cdekReadyStatusCodes,
  cdekTerminalStatusCodes,
} from "../cdekDeliveryStatuses";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { renderOrderPaidEmail } from "./templates/order-paid";
import { renderShipmentHandedOverEmail } from "./templates/shipment-handed-over";
import { renderShipmentReadyEmail } from "./templates/shipment-ready";
import {
  EmailProviderError,
  maskEmail,
  UnisenderGoClient,
  type EmailSendRequest,
} from "./unisenderGo";

type WorkerLogger = {
  info?: (values: Record<string, unknown>, message: string) => void;
  warn?: (values: Record<string, unknown>, message: string) => void;
  error?: (values: Record<string, unknown>, message: string) => void;
};

type EmailWorkerContext = {
  config: AppConfig;
  db: Db;
  logger?: WorkerLogger;
};

type EmailSender = Pick<UnisenderGoClient, "send">;

type EmailOutboxRow = QueryResultRow & {
  id: string;
  order_id: string | null;
  contact_id: string | null;
  event_type: string;
  message_class: "transactional" | "marketing";
  recipient_email: string;
  template_key: string;
  payload: unknown;
  attempt_count: number;
  idempotency_key: string;
  locked_by: string | null;
  created_at: string | Date;
};

type CdekTrackingState = {
  status: string | null;
  number: string | null;
};

export type ProcessEmailOutboxResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  deduplicated: number;
  suppressed: number;
  deferred: number;
  cancelled: number;
};

export type ProcessEmailOutboxOptions = {
  limit?: number;
  workerId?: string;
  sender?: EmailSender;
};

const orderPaidPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  customerFirstName: z.string().max(80),
  orderNumber: z.string().min(1).max(80),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        size: z.string().max(20).nullable(),
        quantity: z.number().int().min(1).max(50),
        lineTotalAmount: z.number().int().min(0),
        imageUrl: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
  subtotalAmount: z.number().int().min(0),
  discountAmount: z.number().int().min(0),
  deliveryAmount: z.number().int().min(0),
  totalAmount: z.number().int().min(1),
  currency: z.literal("RUB"),
  deliveryCity: z.string().max(100),
  deliveryAddress: z.string().max(220),
  deliveryEta: z.string().max(100).nullable(),
});

const shipmentHandedOverPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  customerFirstName: z.string().max(80),
  orderNumber: z.string().min(1).max(80),
  cdekNumber: z.string().min(1).max(80),
  deliveryCity: z.string().max(100),
  deliveryAddress: z.string().min(1).max(220),
  estimatedDeliveryDate: z.string().max(100).nullable().optional(),
});

const shipmentReadyPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  customerFirstName: z.string().max(80),
  orderNumber: z.string().min(1).max(80),
  cdekNumber: z.string().min(1).max(80),
  deliveryPointType: z.enum(["pickup_point", "postamat"]),
  deliveryPointName: z.string().max(160).nullable().optional(),
  deliveryPointCode: z.string().max(40).nullable().optional(),
  deliveryCity: z.string().max(100),
  deliveryAddress: z.string().min(1).max(220),
  deliveryHours: z.string().max(160).nullable().optional(),
  storageUntil: z.string().max(100).nullable().optional(),
});

const retryDelaysMs = [5 * 60_000, 30 * 60_000, 4 * 60 * 60_000];
const cdekTrackingWaitMs = 90_000;
const cdekTrackingPollMs = 10_000;

export function emailWorkerConfigurationError(
  config: AppConfig,
): string | null {
  if (!config.EMAIL_WORKER_ENABLED) return null;
  if (!config.EMAIL_ENABLED) {
    return "EMAIL_WORKER_ENABLED requires EMAIL_ENABLED=true";
  }
  if (!config.EMAIL_FROM || !config.EMAIL_REPLY_TO || !config.UNISENDER_GO_API_KEY) {
    return "Email worker requires sender, Reply-To and provider API key";
  }
  if (config.NODE_ENV !== "production" && !config.EMAIL_TEST_MODE) {
    return "Non-production email worker requires EMAIL_TEST_MODE=true";
  }
  if (config.EMAIL_TEST_MODE && !config.EMAIL_ALLOWED_RECIPIENTS.trim()) {
    return "Email test mode requires a non-empty recipient allowlist";
  }
  return null;
}

function boundedText(value: unknown, maxLength = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function workerIdentity(value?: string): string {
  return (
    boundedText(value, 160) ||
    `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  );
}

async function claimNextEmail(
  context: EmailWorkerContext,
  workerId: string,
): Promise<EmailOutboxRow | null> {
  return context.db.withTransaction(async (client) => {
    const result = await client.query<EmailOutboxRow>(
      `
        /* email_outbox:claim */
        with candidate as (
          select id
          from public.merch_email_outbox
          where (
            status in ('pending', 'retry')
            and coalesce(next_attempt_at, scheduled_at) <= now()
          ) or (
            status = 'processing'
            and coalesce(locked_at, updated_at, created_at) <
              now() - ($2::double precision * interval '1 millisecond')
          )
          order by coalesce(next_attempt_at, scheduled_at), created_at, id
          for update skip locked
          limit 1
        )
        update public.merch_email_outbox outbox
        set status = 'processing',
            attempt_count = outbox.attempt_count + 1,
            next_attempt_at = null,
            locked_at = now(),
            locked_by = $1,
            last_error = null
        from candidate
        where outbox.id = candidate.id
        returning
          outbox.id,
          outbox.order_id,
          outbox.contact_id,
          outbox.event_type,
          outbox.message_class,
          outbox.recipient_email,
          outbox.template_key,
          outbox.payload,
          outbox.attempt_count,
          outbox.idempotency_key,
          outbox.locked_by,
          outbox.created_at
      `,
      [workerId, context.config.EMAIL_WORKER_LEASE_MS],
    );
    return result.rows[0] ?? null;
  });
}

async function suppressionReason(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
): Promise<string | null> {
  const result = await context.db.query<{
    reason: string | null;
    marketing_status: string | null;
  }>(
    `
      /* email_outbox:suppression */
      select
        suppressions.reason,
        contacts.marketing_status
      from (values (lower(btrim($1)))) as target(email_normalized)
      left join public.merch_email_suppressions suppressions using (email_normalized)
      left join public.merch_email_contacts contacts using (email_normalized)
    `,
    [row.recipient_email],
  );
  const reason = boundedText(result.rows[0]?.reason, 80).toLowerCase();
  if (row.message_class === "marketing") {
    if (reason) return reason;
    const marketingStatus = boundedText(
      result.rows[0]?.marketing_status,
      40,
    ).toLowerCase();
    return marketingStatus === "subscribed"
      ? null
      : `marketing_consent_${marketingStatus || "missing"}`;
  }
  if (!reason) return null;
  return ["hard_bounce", "spam_complaint"].includes(reason) ? reason : null;
}

function emailRequest(
  row: EmailOutboxRow,
  cdekNumber: string | null,
): EmailSendRequest {
  if (row.message_class !== "transactional" || row.template_key !== row.event_type) {
    throw new Error("Unsupported email outbox template");
  }
  let rendered;
  let orderNumber: string;
  switch (row.template_key) {
    case "order_paid": {
      const input = orderPaidPayloadSchema.parse(row.payload);
      rendered = renderOrderPaidEmail({ ...input, cdekNumber });
      orderNumber = input.orderNumber;
      break;
    }
    case "shipment_handed_over": {
      const input = shipmentHandedOverPayloadSchema.parse(row.payload);
      rendered = renderShipmentHandedOverEmail(input);
      orderNumber = input.orderNumber;
      break;
    }
    case "shipment_ready": {
      const input = shipmentReadyPayloadSchema.parse(row.payload);
      rendered = renderShipmentReadyEmail(input);
      orderNumber = input.orderNumber;
      break;
    }
    default:
      throw new Error("Unsupported email outbox template");
  }
  return {
    recipientEmail: row.recipient_email,
    messageClass: row.message_class,
    templateKey: row.template_key,
    idempotencyKey: row.idempotency_key,
    rendered,
    metadata: {
      order_id: row.order_id ?? "",
      order_number: orderNumber,
    },
  };
}

const paidOrderStatuses = new Set(["paid", "partially_refunded"]);
const closedFulfillmentStatuses = new Set(["canceled", "returned"]);
const closedShipmentStatuses = new Set([
  "deleting",
  "deleted",
  "failed",
  "invalid",
]);
async function sendCancellationReason(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
): Promise<string | null> {
  if (!row.order_id) return "email_order_missing";
  const result = await context.db.query<{
    order_status: string;
    fulfillment_status: string;
    shipment_status: string | null;
    delivery_status_code: string | null;
  }>(
    `
      /* email_outbox:send_eligibility */
      select
        orders.status as order_status,
        orders.fulfillment_status,
        shipment.status as shipment_status,
        shipment.delivery_status_code
      from public.merch_customer_orders orders
      left join public.merch_cdek_shipments shipment on shipment.order_id = orders.id
      where orders.id = $1::uuid
      limit 1
    `,
    [row.order_id],
  );
  const current = result.rows[0];
  if (!current) return "email_order_missing";
  if (!paidOrderStatuses.has(boundedText(current.order_status, 40).toLowerCase())) {
    return "email_order_no_longer_paid";
  }
  if (
    closedFulfillmentStatuses.has(
      boundedText(current.fulfillment_status, 40).toLowerCase(),
    )
  ) {
    return "email_fulfillment_closed";
  }
  if (row.event_type === "order_paid") return null;
  const shipmentStatus = boundedText(current.shipment_status, 40).toLowerCase();
  if (!shipmentStatus) return "email_shipment_missing";
  if (closedShipmentStatuses.has(shipmentStatus)) return "email_shipment_closed";
  const deliveryStatus = boundedText(
    current.delivery_status_code,
    100,
  ).toUpperCase();
  if (row.event_type === "shipment_handed_over") {
    if (!cdekInTransitStatusCodes.has(deliveryStatus)) {
      return cdekReadyStatusCodes.has(deliveryStatus)
        ? "email_shipment_handed_over_stale_ready"
        : "email_shipment_handed_over_stale_status";
    }
  }
  if (row.event_type === "shipment_ready" && !cdekReadyStatusCodes.has(deliveryStatus)) {
    return cdekTerminalStatusCodes.has(deliveryStatus)
      ? "email_shipment_ready_stale_terminal"
      : "email_shipment_ready_stale_status";
  }
  return null;
}

async function cdekTrackingState(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
): Promise<CdekTrackingState> {
  if (!context.config.CDEK_CREATE_SHIPMENTS || !row.order_id) {
    return { status: null, number: null };
  }
  const result = await context.db.query<{
    status: string;
    cdek_number: string | null;
  }>(
    `
      /* email_outbox:cdek_tracking */
      select status, cdek_number
      from public.merch_cdek_shipments
      where order_id = $1::uuid
      limit 1
    `,
    [row.order_id],
  );
  const shipment = result.rows[0];
  return {
    status: boundedText(shipment?.status, 40).toLowerCase() || null,
    number: boundedText(shipment?.cdek_number, 80) || null,
  };
}

function shouldWaitForCdekTracking(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
  cdek: CdekTrackingState,
): boolean {
  if (row.event_type !== "order_paid" || row.template_key !== "order_paid") {
    return false;
  }
  if (!context.config.CDEK_CREATE_SHIPMENTS || cdek.number) return false;
  if (["invalid", "failed", "deleted"].includes(cdek.status ?? "")) {
    return false;
  }
  const createdAt = new Date(row.created_at).getTime();
  if (!Number.isFinite(createdAt)) return false;
  const ageMs = Date.now() - createdAt;
  return ageMs >= 0 && ageMs < cdekTrackingWaitMs;
}

async function deferForCdekTracking(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
  workerId: string,
) {
  await context.db.query(
    `
      /* email_outbox:await_cdek_tracking */
      update public.merch_email_outbox
      set status = 'retry',
          attempt_count = greatest(attempt_count - 1, 0),
          next_attempt_at = now() + ($3::double precision * interval '1 millisecond'),
          locked_at = null,
          locked_by = null,
          last_error = null
      where id = $1::uuid
        and status = 'processing'
        and locked_by = $2
    `,
    [row.id, workerId, cdekTrackingPollMs],
  );
}

async function markSent(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
  workerId: string,
  providerMessageId: string | null,
  auditMessage: string | null = null,
) {
  await context.db.query(
    `
      /* email_outbox:sent */
      update public.merch_email_outbox
      set status = 'sent',
          provider_message_id = coalesce($3, provider_message_id),
          sent_at = coalesce(sent_at, now()),
          failed_at = null,
          next_attempt_at = null,
          locked_at = null,
          locked_by = null,
          last_error = $4
      where id = $1::uuid
        and status = 'processing'
        and locked_by = $2
    `,
    [row.id, workerId, providerMessageId, auditMessage],
  );
}

async function markFailed(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
  workerId: string,
  errorCode: string,
) {
  await context.db.query(
    `
      /* email_outbox:failed */
      update public.merch_email_outbox
      set status = 'failed',
          failed_at = coalesce(failed_at, now()),
          next_attempt_at = null,
          locked_at = null,
          locked_by = null,
          last_error = $3
      where id = $1::uuid
        and status = 'processing'
        and locked_by = $2
    `,
    [row.id, workerId, boundedText(errorCode, 500)],
  );
}

async function markCancelled(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
  workerId: string,
  reason: string,
) {
  await context.db.query(
    `
      /* email_outbox:cancelled */
      update public.merch_email_outbox
      set status = 'cancelled',
          failed_at = null,
          next_attempt_at = null,
          locked_at = null,
          locked_by = null,
          last_error = $3
      where id = $1::uuid
        and status = 'processing'
        and locked_by = $2
    `,
    [row.id, workerId, boundedText(reason, 500)],
  );
}

async function markRetry(
  context: EmailWorkerContext,
  row: EmailOutboxRow,
  workerId: string,
  errorCode: string,
) {
  const delayIndex = Math.min(
    retryDelaysMs.length - 1,
    Math.max(0, row.attempt_count - 1),
  );
  await context.db.query(
    `
      /* email_outbox:retry */
      update public.merch_email_outbox
      set status = 'retry',
          next_attempt_at = now() + ($4::double precision * interval '1 millisecond'),
          locked_at = null,
          locked_by = null,
          last_error = $3
      where id = $1::uuid
        and status = 'processing'
        and locked_by = $2
    `,
    [
      row.id,
      workerId,
      boundedText(errorCode, 500),
      retryDelaysMs[delayIndex],
    ],
  );
}

function errorCode(error: unknown): string {
  if (error instanceof EmailProviderError) return error.code;
  if (error instanceof z.ZodError) return "email_payload_invalid";
  if (error instanceof Error && error.message === "Unsupported email outbox template") {
    return "email_template_unsupported";
  }
  if (
    error instanceof Error
    && (
      error.message.includes("Order email")
      || error.message.includes("Shipment email")
    )
  ) {
    return "email_template_invalid";
  }
  return "email_worker_unexpected_error";
}

export async function processEmailOutbox(
  context: EmailWorkerContext,
  options: ProcessEmailOutboxOptions = {},
): Promise<ProcessEmailOutboxResult> {
  const workerId = workerIdentity(options.workerId);
  const limit = Math.max(
    1,
    Math.min(
      100,
      Math.trunc(options.limit ?? context.config.EMAIL_WORKER_BATCH_SIZE),
    ),
  );
  const sender = options.sender ?? new UnisenderGoClient(context.config);
  const result: ProcessEmailOutboxResult = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    deduplicated: 0,
    suppressed: 0,
    deferred: 0,
    cancelled: 0,
  };

  for (let index = 0; index < limit; index += 1) {
    const row = await claimNextEmail(context, workerId);
    if (!row) break;
    result.claimed += 1;

    try {
      const suppressedBy = await suppressionReason(context, row);
      if (suppressedBy) {
        await markFailed(
          context,
          row,
          workerId,
          `email_suppressed_${suppressedBy}`,
        );
        result.failed += 1;
        result.suppressed += 1;
        context.logger?.warn?.(
          {
            outboxId: row.id,
            orderId: row.order_id,
            recipient: maskEmail(row.recipient_email),
            suppressionReason: suppressedBy,
          },
          "Email suppressed before provider call",
        );
        continue;
      }

      const cdek = await cdekTrackingState(context, row);
      if (shouldWaitForCdekTracking(context, row, cdek)) {
        await deferForCdekTracking(context, row, workerId);
        result.deferred += 1;
        context.logger?.info?.(
          {
            outboxId: row.id,
            orderId: row.order_id,
            cdekStatus: cdek.status,
          },
          "Email briefly deferred while CDEK tracking number is created",
        );
        continue;
      }

      const request = emailRequest(row, cdek.number);
      const cancellationReason = await sendCancellationReason(context, row);
      if (cancellationReason) {
        await markCancelled(context, row, workerId, cancellationReason);
        result.cancelled += 1;
        context.logger?.info?.(
          {
            outboxId: row.id,
            orderId: row.order_id,
            eventType: row.event_type,
            cancellationReason,
          },
          "Stale transactional email cancelled before provider call",
        );
        continue;
      }

      const sent = await sender.send(request);
      await markSent(context, row, workerId, sent.providerMessageId);
      result.sent += 1;
      context.logger?.info?.(
        {
          outboxId: row.id,
          orderId: row.order_id,
          eventType: row.event_type,
          attempt: row.attempt_count,
        },
        "Email accepted by provider",
      );
    } catch (error) {
      const code = errorCode(error);
      if (error instanceof EmailProviderError && error.kind === "duplicate") {
        await markSent(
          context,
          row,
          workerId,
          null,
          "email_provider_duplicate_idempotency_key",
        );
        result.sent += 1;
        result.deduplicated += 1;
        continue;
      }

      const retryable =
        error instanceof EmailProviderError
          ? error.retryable
          : !(error instanceof z.ZodError) &&
            !(error instanceof Error &&
              (error.message === "Unsupported email outbox template" ||
                error.message.includes("Order email") ||
                error.message.includes("Shipment email")));
      if (
        retryable &&
        row.attempt_count < context.config.EMAIL_WORKER_MAX_ATTEMPTS
      ) {
        await markRetry(context, row, workerId, code);
        result.retried += 1;
        context.logger?.warn?.(
          {
            outboxId: row.id,
            orderId: row.order_id,
            eventType: row.event_type,
            attempt: row.attempt_count,
            code,
          },
          "Email deferred for retry",
        );
      } else {
        await markFailed(context, row, workerId, code);
        result.failed += 1;
        context.logger?.error?.(
          {
            outboxId: row.id,
            orderId: row.order_id,
            eventType: row.event_type,
            attempt: row.attempt_count,
            code,
          },
          "Email delivery failed permanently",
        );
      }
    }
  }

  return result;
}

export function startEmailOutboxWorker(
  context: EmailWorkerContext,
  options: ProcessEmailOutboxOptions & { intervalMs?: number } = {},
): () => Promise<void> {
  if (!context.config.EMAIL_ENABLED || !context.config.EMAIL_WORKER_ENABLED) {
    context.logger?.info?.(
      {
        emailEnabled: context.config.EMAIL_ENABLED,
        emailWorkerEnabled: context.config.EMAIL_WORKER_ENABLED,
      },
      "Email worker is disabled",
    );
    return async () => undefined;
  }
  const configurationError = emailWorkerConfigurationError(context.config);
  if (configurationError) {
    context.logger?.error?.(
      { code: "email_worker_not_configured" },
      configurationError,
    );
    return async () => undefined;
  }

  const intervalMs = Math.max(
    1_000,
    options.intervalMs ?? context.config.EMAIL_WORKER_INTERVAL_MS,
  );
  const workerId = workerIdentity(options.workerId);
  let stopped = false;
  let running = false;
  let inFlight: Promise<void> | null = null;

  const run = () => {
    if (stopped || running) return inFlight ?? Promise.resolve();
    running = true;
    const current = processEmailOutbox(context, { ...options, workerId })
      .then(() => undefined)
      .catch((error) => {
        context.logger?.error?.({ error: boundedText(error) }, "Email worker batch failed");
      })
      .finally(() => {
        running = false;
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
