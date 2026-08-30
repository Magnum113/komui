import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { PoolClient, QueryResultRow } from "pg";
import {
  cancelCdekOrder,
  cdekFirstError,
  cdekNumberFromResponse,
  cdekRequestState,
  getCdekOrder,
  getCdekOrderByImNumber,
  type CdekOrderResponse,
} from "./cdek";
import { createCdekShipmentForOrder } from "./cdekShipments";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { errorMessage, HttpError } from "./errors";

export type CdekEffectType = "cdek_create" | "cdek_cancel";

export type CdekEffectStatus =
  | "pending"
  | "processing"
  | "retry"
  | "completed"
  | "needs_review"
  | "canceled";

export type CdekEffectRow = QueryResultRow & {
  id: number;
  order_id: string;
  effect_type: CdekEffectType;
  dedupe_key: string;
  status: CdekEffectStatus;
  payload: Record<string, unknown>;
  attempts: number;
  locked_by: string | null;
};

type ShipmentRow = QueryResultRow & {
  id: number;
  order_id: string;
  status: string;
  cdek_uuid: string | null;
  cdek_number: string | null;
};

type EffectStatusRow = QueryResultRow & {
  status: CdekEffectStatus;
};

type OrderFinancialRow = QueryResultRow & {
  order_number: string;
  status: string;
  metadata: unknown;
};

export type CdekEffectQueryable = Pick<PoolClient, "query">;

type EffectLogger = Pick<FastifyRequest["log"], "info" | "warn" | "error">;

type EffectContext = {
  config: AppConfig;
  db: Db;
  logger?: EffectLogger;
};

type ProcessorDependencies = {
  createShipment?: typeof createCdekShipmentForOrder;
  cancelOrder?: typeof cancelCdekOrder;
  getOrder?: typeof getCdekOrder;
  getOrderByImNumber?: typeof getCdekOrderByImNumber;
};

export type ProcessCdekEffectsOptions = ProcessorDependencies & {
  limit?: number;
  workerId?: string;
};

export type ProcessCdekEffectsResult = {
  claimed: number;
  completed: number;
  retried: number;
  needsReview: number;
  canceled: number;
};

const leaseSeconds = 120;
const defaultBatchSize = 10;
const maxAttempts = 12;
const financiallyCanceledOrderStatuses = new Set([
  "payment_failed",
  "refunded",
]);
const paymentReviewCancellationReasons = new Set([
  "partial_reversed",
  "amount_mismatch",
  "payment_identity_conflict",
  "payment_state_conflict",
]);

class EffectRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectRetryError";
  }
}

class EffectNeedsReviewError extends Error {
  constructor(
    message: string,
    public readonly auditPayload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EffectNeedsReviewError";
  }
}

function boundedText(value: unknown, maxLength = 500): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function dedupeKey(effectType: CdekEffectType, orderId: string): string {
  return `${effectType}:${orderId}`;
}

function cancellationReason(effect: CdekEffectRow): string {
  return boundedText(effect.payload.reason, 80).toLowerCase();
}

function cancellationIsCausal(
  financialOrder: OrderFinancialRow,
  effect: CdekEffectRow,
): boolean {
  if (financiallyCanceledOrderStatuses.has(financialOrder.status)) return true;
  if (financialOrder.status !== "payment_review") return false;

  const reason = cancellationReason(effect);
  if (!paymentReviewCancellationReasons.has(reason)) return false;
  const metadata =
    financialOrder.metadata &&
    typeof financialOrder.metadata === "object" &&
    !Array.isArray(financialOrder.metadata)
      ? (financialOrder.metadata as Record<string, unknown>)
      : {};
  if (
    boundedText(metadata.payment_review_reason, 80).toLowerCase() !== reason
  ) {
    return false;
  }
  if (
    [
      "amount_mismatch",
      "payment_identity_conflict",
      "payment_state_conflict",
    ].includes(reason)
  ) {
    return true;
  }

  const providerStatus = boundedText(
    effect.payload.provider_status ?? effect.payload.providerStatus,
    80,
  ).toUpperCase();
  return providerStatus === "PARTIAL_REVERSED";
}

/**
 * Persist a CDEK side effect without calling the provider.
 *
 * Pass the payment transaction's PoolClient so the financial transition and
 * its fulfillment intent commit atomically. Duplicate provider events keep the
 * existing non-terminal state and only merge audit metadata into payload. A
 * new financial create/cancel transition rearms its terminal row: the dedupe
 * key stays stable, while the old lease/retry outcome is cleared.
 */
export async function enqueueCdekEffect(
  queryable: CdekEffectQueryable,
  effectType: CdekEffectType,
  orderId: string,
  payload: Record<string, unknown> = {},
): Promise<CdekEffectRow> {
  const normalizedOrderId = boundedText(orderId, 36);
  if (!normalizedOrderId) {
    throw new Error("CDEK effect orderId is required");
  }

  const result = await queryable.query<CdekEffectRow>(
    `
      /* cdek_effect:enqueue */
      with superseded_create as (
        update public.merch_order_effects
        set
          status = 'canceled',
          last_error = 'Superseded by CDEK cancellation',
          locked_at = null,
          locked_by = null,
          updated_at = now()
        where $1::text = 'cdek_cancel'
          and dedupe_key = 'cdek_create:' || $2::text
          and status in ('pending', 'retry')
      ), upserted as (
        insert into public.merch_order_effects (
          order_id,
          effect_type,
          dedupe_key,
          status,
          payload,
          available_at
        )
        values ($2::uuid, $1, $3, 'pending', $4::jsonb, now())
        on conflict (dedupe_key) do update
        set
          status = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then 'pending'
            else public.merch_order_effects.status
          end,
          payload = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then (
                public.merch_order_effects.payload
                  - 'outcome'
                  - 'shipmentId'
                  - 'cdekCancellation'
                  - 'providerFailure'
                  - 'providerDeleteAttempted'
                  - 'cancellationIntentRestored'
                  - 'currentOrderStatus'
                  - 'shipmentStatus'
                  - 'fulfillmentRecovery'
                  - 'cdekReconciliation'
              ) || excluded.payload
            else public.merch_order_effects.payload || excluded.payload
          end,
          attempts = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then 0
            when public.merch_order_effects.status in (
              'pending',
              'retry',
              'processing'
            )
              and public.merch_order_effects.payload <>
                (public.merch_order_effects.payload || excluded.payload)
              then 0
            else public.merch_order_effects.attempts
          end,
          available_at = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then now()
            when public.merch_order_effects.status in (
              'pending',
              'retry',
              'processing'
            )
              and public.merch_order_effects.payload <>
                (public.merch_order_effects.payload || excluded.payload)
              then now()
            else public.merch_order_effects.available_at
          end,
          locked_at = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then null
            else public.merch_order_effects.locked_at
          end,
          locked_by = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then null
            else public.merch_order_effects.locked_by
          end,
          completed_at = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then null
            else public.merch_order_effects.completed_at
          end,
          last_error = case
            when $1::text in ('cdek_create', 'cdek_cancel')
              and public.merch_order_effects.status in (
                'completed',
                'needs_review',
                'canceled'
              )
              then null
            when public.merch_order_effects.status in (
              'pending',
              'retry',
              'processing'
            )
              and public.merch_order_effects.payload <>
                (public.merch_order_effects.payload || excluded.payload)
              then null
            else public.merch_order_effects.last_error
          end,
          updated_at = now()
        returning
          id,
          order_id,
          effect_type,
          dedupe_key,
          status,
          payload,
          attempts,
          locked_by
      )
      select * from upserted
    `,
    [
      effectType,
      normalizedOrderId,
      dedupeKey(effectType, normalizedOrderId),
      JSON.stringify(payload),
    ],
  );

  const effect = result.rows[0];
  if (!effect) throw new Error("Failed to enqueue CDEK effect");
  return effect;
}

async function claimNextEffect(
  db: Db,
  workerId: string,
): Promise<CdekEffectRow | null> {
  const result = await db.query<CdekEffectRow>(
    `
      /* cdek_effect:claim */
      with candidate as (
        select id
        from public.merch_order_effects
        where effect_type in ('cdek_create', 'cdek_cancel')
          and (
            (
              status in ('pending', 'retry')
              and available_at <= now()
            )
            or (
              status = 'processing'
              and locked_at < now() - ($2::int * interval '1 second')
            )
          )
        order by
          case when effect_type = 'cdek_cancel' then 0 else 1 end,
          available_at asc,
          id asc
        for update skip locked
        limit 1
      )
      update public.merch_order_effects as effect
      set
        status = 'processing',
        attempts = effect.attempts + 1,
        locked_at = now(),
        locked_by = $1,
        updated_at = now()
      from candidate
      where effect.id = candidate.id
      returning
        effect.id,
        effect.order_id,
        effect.effect_type,
        effect.dedupe_key,
        effect.status,
        effect.payload,
        effect.attempts,
        effect.locked_by
    `,
    [workerId, leaseSeconds],
  );
  return result.rows[0] ?? null;
}

async function loadShipment(
  queryable: CdekEffectQueryable,
  orderId: string,
): Promise<ShipmentRow | null> {
  const result = await queryable.query<ShipmentRow>(
    `
      /* cdek_effect:load_shipment */
      select id, order_id, status, cdek_uuid, cdek_number
      from public.merch_cdek_shipments
      where order_id = $1::uuid
      limit 1
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

async function relatedCreateStatus(
  queryable: CdekEffectQueryable,
  orderId: string,
): Promise<CdekEffectStatus | null> {
  const result = await queryable.query<EffectStatusRow>(
    `
      /* cdek_effect:load_create_status */
      select status
      from public.merch_order_effects
      where dedupe_key = 'cdek_create:' || $1::text
      limit 1
    `,
    [orderId],
  );
  return result.rows[0]?.status ?? null;
}

async function lockOrderFinancialState(
  queryable: CdekEffectQueryable,
  orderId: string,
): Promise<OrderFinancialRow | null> {
  const result = await queryable.query<OrderFinancialRow>(
    `
      /* cdek_effect:lock_order_financial_state */
      select order_number, status, metadata
      from public.merch_customer_orders
      where id = $1::uuid
      limit 1
      for update
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

function reconciliationSummary(
  response: CdekOrderResponse,
  merchantOrderMatches: boolean | null,
) {
  const error = cdekFirstError(response);
  return {
    cdekReconciliation: {
      state: cdekRequestState(response),
      hasUuid: Boolean(boundedText(response.entity?.uuid, 80)),
      hasMerchantOrderNumber: Boolean(
        boundedText(response.entity?.number, 36) ||
          boundedText(response.entity?.im_number, 36),
      ),
      merchantOrderMatches,
      errorCode: boundedText(error?.code, 120) || null,
      errorMessage: boundedText(error?.message) || null,
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function reconcileShipmentForCancellation(
  context: EffectContext,
  queryable: CdekEffectQueryable,
  orderNumber: string,
  shipment: ShipmentRow,
  findOrderByImNumber: typeof getCdekOrderByImNumber,
): Promise<ShipmentRow> {
  if (!orderNumber) {
    throw new EffectNeedsReviewError(
      "Cannot reconcile CDEK cancellation without a local merchant order number",
    );
  }

  const response = await findOrderByImNumber(
    context.config,
    orderNumber,
  );
  if (!response) {
    throw new EffectRetryError(
      "Ambiguous CDEK create is not visible by merchant order number yet",
    );
  }

  const providerUuid = boundedText(response.entity?.uuid, 80);
  const providerOrderNumber =
    boundedText(response.entity?.number, 36) ||
    boundedText(response.entity?.im_number, 36);
  const merchantOrderMatches = providerOrderNumber === orderNumber;
  const providerState = cdekRequestState(response);
  const providerError = cdekFirstError(response);
  const summary = reconciliationSummary(response, merchantOrderMatches);

  if (!providerUuid || !providerOrderNumber) {
    throw new EffectNeedsReviewError(
      "CDEK create reconciliation returned an ambiguous order identity",
      summary,
    );
  }
  if (!merchantOrderMatches) {
    throw new EffectNeedsReviewError(
      "CDEK create reconciliation returned a different merchant order",
      summary,
    );
  }
  if (providerError || !["accepted", "created"].includes(providerState)) {
    throw new EffectNeedsReviewError(
      boundedText(providerError?.message) ||
        `CDEK create reconciliation ended with status ${providerState}`,
      summary,
    );
  }

  const firstRequest = response.requests?.[0];
  let adopted: ShipmentRow | null = null;
  try {
    const result = await queryable.query<ShipmentRow>(
      `
        /* cdek_effect:adopt_reconciled_shipment */
        update public.merch_cdek_shipments
        set
          status = $4,
          cdek_uuid = $2,
          cdek_number = $3,
          request_uuid = $5,
          response_payload = $6::jsonb,
          error_code = null,
          error_message = null,
          synced_at = now()
        where id = $1
          and cdek_uuid is null
          and status not in ('deleting', 'deleted')
        returning id, order_id, status, cdek_uuid, cdek_number
      `,
      [
        shipment.id,
        providerUuid,
        cdekNumberFromResponse(response),
        providerState,
        firstRequest?.request_uuid ?? null,
        JSON.stringify(response),
      ],
    );
    adopted = result.rows[0] ?? null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new EffectNeedsReviewError(
      "Reconciled CDEK UUID is already attached to another local shipment",
      summary,
    );
  }

  if (adopted) return adopted;

  const current = await loadShipment(queryable, shipment.order_id);
  if (!current) {
    throw new EffectNeedsReviewError(
      "CDEK shipment disappeared during cancellation reconciliation",
      summary,
    );
  }
  if (current.status === "deleted" || current.cdek_uuid === providerUuid) {
    return current;
  }
  if (current.cdek_uuid) {
    throw new EffectNeedsReviewError(
      "Concurrent CDEK reconciliation persisted a different provider UUID",
      summary,
    );
  }
  throw new EffectRetryError(
    "CDEK shipment changed during cancellation reconciliation; retry deferred",
  );
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(Math.max(0, attempts - 1), 6));
}

async function markEffectTerminal(
  queryable: CdekEffectQueryable,
  effect: CdekEffectRow,
  workerId: string,
  status: Extract<CdekEffectStatus, "completed" | "needs_review" | "canceled">,
  payload: Record<string, unknown>,
  lastError: string | null = null,
): Promise<void> {
  await queryable.query(
    `
      /* cdek_effect:terminal */
      update public.merch_order_effects
      set
        status = case when payload = $6::jsonb then $3 else 'pending' end,
        payload = case
          when payload = $6::jsonb then payload || $4::jsonb
          else payload
        end,
        available_at = case
          when payload = $6::jsonb then available_at
          else now()
        end,
        last_error = case when payload = $6::jsonb then $5 else last_error end,
        completed_at = case when payload = $6::jsonb then now() else null end,
        locked_at = null,
        locked_by = null,
        updated_at = now()
      where id = $1
        and status = 'processing'
        and locked_by = $2
    `,
    [
      effect.id,
      workerId,
      status,
      JSON.stringify(payload),
      lastError,
      JSON.stringify(effect.payload),
    ],
  );
}

async function markEffectRetry(
  queryable: CdekEffectQueryable,
  effect: CdekEffectRow,
  workerId: string,
  error: unknown,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const message = boundedText(errorMessage(error));
  const delaySeconds = retryDelaySeconds(effect.attempts);
  await queryable.query(
    `
      /* cdek_effect:retry */
      update public.merch_order_effects
      set
        status = case when payload = $6::jsonb then 'retry' else 'pending' end,
        available_at = case
          when payload = $6::jsonb
            then now() + ($3::int * interval '1 second')
          else now()
        end,
        payload = case
          when payload = $6::jsonb then payload || $5::jsonb
          else payload
        end,
        last_error = case when payload = $6::jsonb then $4 else last_error end,
        locked_at = null,
        locked_by = null,
        updated_at = now()
      where id = $1
        and status = 'processing'
        and locked_by = $2
    `,
    [
      effect.id,
      workerId,
      delaySeconds,
      message,
      JSON.stringify(payload),
      JSON.stringify(effect.payload),
    ],
  );
}

function cancellationResponseSummary(response: CdekOrderResponse) {
  const request =
    response.requests?.find(
      (item) => boundedText(item.type, 40).toUpperCase() === "DELETE",
    ) ?? response.requests?.[0];
  const error = cdekFirstError(response);
  return {
    cdekCancellation: {
      state: boundedText(request?.state, 40) || null,
      requestUuid: boundedText(request?.request_uuid, 80) || null,
      errorCode: boundedText(error?.code, 120) || null,
      errorMessage: boundedText(error?.message) || null,
    },
  };
}

function cancellationState(
  response: CdekOrderResponse,
  requireDeleteRequest = false,
): "completed" | "pending" | "missing" {
  const deleteRequest = response.requests?.find(
    (request) => boundedText(request.type, 40).toUpperCase() === "DELETE",
  );
  const request = deleteRequest ?? (requireDeleteRequest ? undefined : response.requests?.[0]);
  if (!request) return "missing";
  const state = boundedText(request?.state, 40).toUpperCase();
  const providerError = request.errors?.[0] ?? cdekFirstError(response);

  if (providerError || state === "INVALID") {
    throw new EffectNeedsReviewError(
      boundedText(providerError?.message) ||
        "CDEK rejected the order cancellation request",
      {
        cdekCancellation: {
          state: state || null,
          requestUuid: boundedText(request.request_uuid, 80) || null,
          errorCode: boundedText(providerError?.code, 120) || null,
          errorMessage: boundedText(providerError?.message) || null,
        },
      },
    );
  }
  if (state === "SUCCESSFUL") return "completed";
  if (["ACCEPTED", "WAITING"].includes(state)) return "pending";
  if (state) {
    throw new EffectNeedsReviewError(
      `Unexpected CDEK cancellation state: ${state}`,
      cancellationResponseSummary(response),
    );
  }
  return "missing";
}

async function processCreateEffect(
  context: EffectContext,
  effect: CdekEffectRow,
  workerId: string,
  createShipment: typeof createCdekShipmentForOrder,
): Promise<"completed" | "canceled"> {
  if (!context.config.CDEK_CREATE_SHIPMENTS) {
    await markEffectTerminal(
      context.db as unknown as CdekEffectQueryable,
      effect,
      workerId,
      "canceled",
      { outcome: "automatic_creation_disabled" },
      "CDEK automatic shipment creation is disabled",
    );
    return "canceled";
  }

  // createCdekShipmentForOrder always reloads the current order and permits
  // the fulfillment states `paid` and `partially_refunded`; a full
  // refund/reversal or review transition committed first cancels this work.
  const shipment = await createShipment(
    { ...context, logger: context.logger },
    { orderId: effect.order_id },
  );
  if (!shipment) {
    await markEffectTerminal(
      context.db as unknown as CdekEffectQueryable,
      effect,
      workerId,
      "canceled",
      { outcome: "order_not_fulfillable" },
    );
    return "canceled";
  }

  if (["deleting", "deleted"].includes(shipment.status)) {
    throw new EffectNeedsReviewError(
      shipment.status === "deleted"
        ? "Payment recovered after the CDEK shipment was deleted; manual fulfillment recovery is required"
        : "Payment recovered while the CDEK shipment is being deleted; manual fulfillment review is required",
      {
        fulfillmentRecovery: {
          shipmentId: shipment.id,
          shipmentStatus: shipment.status,
          automaticCreateRetried: false,
        },
      },
    );
  }

  if (["pending", "creating", "accepted"].includes(shipment.status)) {
    throw new EffectRetryError("CDEK shipment creation is still in progress");
  }
  if (["failed", "invalid", "unknown"].includes(shipment.status)) {
    throw new EffectNeedsReviewError(
      `CDEK shipment creation ended with status ${shipment.status}`,
    );
  }

  await markEffectTerminal(
    context.db as unknown as CdekEffectQueryable,
    effect,
    workerId,
    "completed",
    {
      outcome: "shipment_created",
      shipmentId: shipment.id,
      shipmentStatus: shipment.status,
    },
  );
  return "completed";
}

type CancelEffectOutcome =
  | "completed"
  | "retry"
  | "needs_review"
  | "canceled";

type CancellationPreparation =
  | { kind: "finished"; outcome: CancelEffectOutcome }
  | {
      kind: "reconcile";
      orderNumber: string;
      shipment: ShipmentRow;
    }
  | {
      kind: "provider";
      orderNumber: string;
      shipment: ShipmentRow;
      restoreStatus: string | null;
    };

async function restoreCancellationIntent(
  queryable: CdekEffectQueryable,
  shipment: ShipmentRow,
  restoreStatus: string,
): Promise<ShipmentRow | null> {
  if (["deleting", "deleted"].includes(restoreStatus)) return null;
  const result = await queryable.query<ShipmentRow>(
    `
      /* cdek_effect:restore_cancel_intent */
      update public.merch_cdek_shipments
      set status = $3, synced_at = now()
      where id = $1
        and cdek_uuid = $2
        and status = 'deleting'
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [shipment.id, shipment.cdek_uuid, restoreStatus],
  );
  return result.rows[0] ?? null;
}

async function finishNonCausalCancellation(
  queryable: CdekEffectQueryable,
  effect: CdekEffectRow,
  workerId: string,
  financialOrder: OrderFinancialRow,
  shipment: ShipmentRow | null,
  options: {
    restoreStatus?: string | null;
    providerDeleteAttempted: boolean;
  },
): Promise<Extract<CancelEffectOutcome, "canceled" | "needs_review">> {
  let current = shipment;
  let intentRestored = false;
  if (
    current?.status === "deleting" &&
    options.restoreStatus &&
    !options.providerDeleteAttempted
  ) {
    const restored = await restoreCancellationIntent(
      queryable,
      current,
      options.restoreStatus,
    );
    if (restored) {
      current = restored;
      intentRestored = true;
    } else {
      current = await loadShipment(queryable, effect.order_id);
    }
  }

  if (current && ["deleting", "deleted"].includes(current.status)) {
    const message =
      current.status === "deleted"
        ? "CDEK shipment was deleted after payment recovery; manual fulfillment recovery is required"
        : "CDEK cancellation is ambiguous after payment recovery; manual fulfillment review is required";
    await markEffectTerminal(
      queryable,
      effect,
      workerId,
      "needs_review",
      {
        outcome:
          current.status === "deleted"
            ? "shipment_deleted_after_financial_recovery"
            : "cancellation_ambiguous_after_financial_recovery",
        shipmentId: current.id,
        shipmentStatus: current.status,
        currentOrderStatus: financialOrder.status,
        providerDeleteAttempted: options.providerDeleteAttempted,
        cancellationIntentRestored: intentRestored,
      },
      message,
    );
    return "needs_review";
  }

  await markEffectTerminal(
    queryable,
    effect,
    workerId,
    "canceled",
    {
      outcome: "cancellation_superseded_by_financial_state",
      shipmentId: current?.id ?? null,
      shipmentStatus: current?.status ?? null,
      currentOrderStatus: financialOrder.status,
      providerDeleteAttempted: options.providerDeleteAttempted,
      cancellationIntentRestored: intentRestored,
    },
  );
  return "canceled";
}

async function markCancellationIntent(
  queryable: CdekEffectQueryable,
  shipment: ShipmentRow,
): Promise<ShipmentRow> {
  const result = await queryable.query<ShipmentRow>(
    `
      /* cdek_effect:mark_cancel_intent */
      update public.merch_cdek_shipments
      set status = 'deleting', synced_at = now()
      where id = $1
        and cdek_uuid = $2
        and status = $3
        and status not in ('deleting', 'deleted')
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [shipment.id, shipment.cdek_uuid, shipment.status],
  );
  if (result.rows[0]) return result.rows[0];

  const current = await loadShipment(queryable, shipment.order_id);
  if (!current) {
    throw new EffectNeedsReviewError(
      "CDEK shipment disappeared while persisting cancellation intent",
    );
  }
  if (
    shipment.cdek_uuid &&
    current.cdek_uuid &&
    shipment.cdek_uuid !== current.cdek_uuid
  ) {
    throw new EffectNeedsReviewError(
      "CDEK shipment UUID changed while persisting cancellation intent",
    );
  }
  return current;
}

async function prepareCancellation(
  context: EffectContext,
  effect: CdekEffectRow,
  workerId: string,
): Promise<CancellationPreparation> {
  return context.db.withTransaction(async (client) => {
    const financialOrder = await lockOrderFinancialState(client, effect.order_id);
    if (!financialOrder) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        { outcome: "financial_state_missing" },
        "Cannot validate the financial state for CDEK cancellation",
      );
      return { kind: "finished", outcome: "needs_review" };
    }

    let shipment = await loadShipment(client, effect.order_id);
    if (!cancellationIsCausal(financialOrder, effect)) {
      const outcome = await finishNonCausalCancellation(
        client,
        effect,
        workerId,
        financialOrder,
        shipment,
        { providerDeleteAttempted: false },
      );
      return { kind: "finished", outcome };
    }

    if (!shipment) {
      const createStatus = await relatedCreateStatus(client, effect.order_id);
      if (createStatus === "processing") {
        throw new EffectRetryError(
          "CDEK shipment creation is still processing; cancellation deferred",
        );
      }
      await markEffectTerminal(client, effect, workerId, "completed", {
        outcome: "no_shipment",
        currentOrderStatus: financialOrder.status,
      });
      return { kind: "finished", outcome: "completed" };
    }

    if (shipment.status === "deleted") {
      await markEffectTerminal(client, effect, workerId, "completed", {
        outcome: "shipment_already_deleted",
        shipmentId: shipment.id,
        currentOrderStatus: financialOrder.status,
      });
      return { kind: "finished", outcome: "completed" };
    }

    if (!shipment.cdek_uuid) {
      return {
        kind: "reconcile",
        orderNumber: financialOrder.order_number,
        shipment,
      };
    }

    if (shipment.status === "deleting") {
      return {
        kind: "provider",
        orderNumber: financialOrder.order_number,
        shipment,
        restoreStatus: null,
      };
    }

    const restoreStatus = shipment.status;
    shipment = await markCancellationIntent(client, shipment);
    if (shipment.status === "deleted") {
      await markEffectTerminal(client, effect, workerId, "completed", {
        outcome: "shipment_already_deleted",
        shipmentId: shipment.id,
        currentOrderStatus: financialOrder.status,
      });
      return { kind: "finished", outcome: "completed" };
    }
    if (shipment.status !== "deleting" || !shipment.cdek_uuid) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: "cancellation_intent_conflict",
          shipmentId: shipment.id,
          shipmentStatus: shipment.status,
        },
        "CDEK shipment changed while persisting cancellation intent",
      );
      return { kind: "finished", outcome: "needs_review" };
    }

    return {
      kind: "provider",
      orderNumber: financialOrder.order_number,
      shipment,
      restoreStatus,
    };
  });
}

type ProviderDeleteGuard =
  | { kind: "proceed"; shipment: ShipmentRow }
  | { kind: "finished"; outcome: CancelEffectOutcome };

async function guardBeforeProviderDelete(
  context: EffectContext,
  effect: CdekEffectRow,
  workerId: string,
  shipment: ShipmentRow,
  restoreStatus: string | null,
): Promise<ProviderDeleteGuard> {
  return context.db.withTransaction(async (client) => {
    const financialOrder = await lockOrderFinancialState(client, effect.order_id);
    if (!financialOrder) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        { outcome: "financial_state_missing_before_delete" },
        "Cannot revalidate the financial state before CDEK cancellation",
      );
      return { kind: "finished", outcome: "needs_review" };
    }

    const current = await loadShipment(client, effect.order_id);
    if (!cancellationIsCausal(financialOrder, effect)) {
      const outcome = await finishNonCausalCancellation(
        client,
        effect,
        workerId,
        financialOrder,
        current,
        {
          restoreStatus,
          providerDeleteAttempted: false,
        },
      );
      return { kind: "finished", outcome };
    }

    if (!current) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        { outcome: "shipment_missing_before_delete" },
        "CDEK shipment disappeared before provider cancellation",
      );
      return { kind: "finished", outcome: "needs_review" };
    }
    if (current.status === "deleted") {
      await markEffectTerminal(client, effect, workerId, "completed", {
        outcome: "shipment_already_deleted",
        shipmentId: current.id,
        currentOrderStatus: financialOrder.status,
      });
      return { kind: "finished", outcome: "completed" };
    }
    if (
      current.status !== "deleting" ||
      !current.cdek_uuid ||
      current.cdek_uuid !== shipment.cdek_uuid
    ) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: "cancellation_intent_conflict",
          shipmentId: current.id,
          shipmentStatus: current.status,
        },
        "CDEK shipment changed before provider cancellation",
      );
      return { kind: "finished", outcome: "needs_review" };
    }
    return { kind: "proceed", shipment: current };
  });
}

function validateCancellationIdentity(
  response: CdekOrderResponse,
  shipment: ShipmentRow,
  orderNumber: string,
): void {
  const providerUuid = boundedText(response.entity?.uuid, 80);
  const providerOrderNumber =
    boundedText(response.entity?.number, 36) ||
    boundedText(response.entity?.im_number, 36);
  if (providerUuid && providerUuid !== shipment.cdek_uuid) {
    throw new EffectNeedsReviewError(
      "CDEK cancellation response returned a different provider UUID",
      {
        cdekCancellation: {
          hasUuid: true,
          uuidMatches: false,
          merchantOrderMatches:
            !providerOrderNumber || providerOrderNumber === orderNumber,
        },
      },
    );
  }
  if (providerOrderNumber && providerOrderNumber !== orderNumber) {
    throw new EffectNeedsReviewError(
      "CDEK cancellation response returned a different merchant order",
      {
        cdekCancellation: {
          hasUuid: Boolean(providerUuid),
          uuidMatches: !providerUuid || providerUuid === shipment.cdek_uuid,
          merchantOrderMatches: false,
        },
      },
    );
  }
}

function validateExactCancellationLookupIdentity(
  response: CdekOrderResponse,
  shipment: ShipmentRow,
  orderNumber: string,
): void {
  const providerUuid = boundedText(response.entity?.uuid, 80);
  const providerOrderNumber =
    boundedText(response.entity?.number, 36) ||
    boundedText(response.entity?.im_number, 36);
  if (!providerUuid || !providerOrderNumber) {
    throw new EffectNeedsReviewError(
      "Exact CDEK lookup did not return a complete shipment identity",
      {
        cdekCancellation: {
          hasUuid: Boolean(providerUuid),
          hasMerchantOrderNumber: Boolean(providerOrderNumber),
          uuidMatches: providerUuid
            ? providerUuid === shipment.cdek_uuid
            : null,
          merchantOrderMatches: providerOrderNumber
            ? providerOrderNumber === orderNumber
            : null,
        },
      },
    );
  }
  validateCancellationIdentity(response, shipment, orderNumber);
}

async function markShipmentDeletedAfterProvider(
  queryable: CdekEffectQueryable,
  shipment: ShipmentRow,
): Promise<ShipmentRow | null> {
  const result = await queryable.query<ShipmentRow>(
    `
      /* cdek_effect:mark_shipment_deleted */
      update public.merch_cdek_shipments
      set
        status = 'deleted',
        error_code = null,
        error_message = null,
        synced_at = now()
      where id = $1
        and cdek_uuid = $2
        and status in ('deleting', 'deleted')
      returning id, order_id, status, cdek_uuid, cdek_number
    `,
    [shipment.id, shipment.cdek_uuid],
  );
  if (result.rows[0]) return result.rows[0];
  return loadShipment(queryable, shipment.order_id);
}

async function finalizeProviderResponse(
  context: EffectContext,
  effect: CdekEffectRow,
  workerId: string,
  shipment: ShipmentRow,
  orderNumber: string,
  response: CdekOrderResponse,
  providerDeleteAttempted: boolean,
  requireDeleteRequest = false,
): Promise<CancelEffectOutcome> {
  const durableProviderDeleteAttempted =
    providerDeleteAttempted || effect.payload.providerDeleteAttempted === true;
  return context.db.withTransaction(async (client) => {
    const financialOrder = await lockOrderFinancialState(client, effect.order_id);
    const responseSummary = cancellationResponseSummary(response);
    if (!financialOrder) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: "financial_state_missing_after_delete",
          shipmentId: shipment.id,
          providerDeleteAttempted: durableProviderDeleteAttempted,
          ...responseSummary,
        },
        "Cannot validate the financial state after CDEK cancellation",
      );
      return "needs_review";
    }

    let state: "completed" | "pending" | "missing";
    try {
      validateCancellationIdentity(response, shipment, orderNumber);
      state = cancellationState(response, requireDeleteRequest);
    } catch (error) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: "provider_rejected",
          shipmentId: shipment.id,
          currentOrderStatus: financialOrder.status,
          providerDeleteAttempted: durableProviderDeleteAttempted,
          ...responseSummary,
          ...providerFailureSummary(error),
        },
        boundedText(errorMessage(error)),
      );
      return "needs_review";
    }

    if (state === "completed") {
      const current = await markShipmentDeletedAfterProvider(client, shipment);
      if (!current || current.status !== "deleted") {
        await markEffectTerminal(
          client,
          effect,
          workerId,
          "needs_review",
          {
            outcome: "shipment_delete_cas_conflict",
            shipmentId: current?.id ?? shipment.id,
            shipmentStatus: current?.status ?? null,
            currentOrderStatus: financialOrder.status,
            providerDeleteAttempted: durableProviderDeleteAttempted,
            ...responseSummary,
          },
          "CDEK deletion was confirmed but local shipment state changed",
        );
        return "needs_review";
      }
      if (!cancellationIsCausal(financialOrder, effect)) {
        return finishNonCausalCancellation(
          client,
          effect,
          workerId,
          financialOrder,
          current,
          { providerDeleteAttempted: durableProviderDeleteAttempted },
        );
      }
      await markEffectTerminal(client, effect, workerId, "completed", {
        outcome: "cancellation_accepted",
        shipmentId: current.id,
        currentOrderStatus: financialOrder.status,
        providerDeleteAttempted: durableProviderDeleteAttempted,
        ...responseSummary,
      });
      return "completed";
    }

    if (state === "missing") {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: "cancellation_response_ambiguous",
          shipmentId: shipment.id,
          currentOrderStatus: financialOrder.status,
          providerDeleteAttempted: durableProviderDeleteAttempted,
          ...responseSummary,
        },
        "CDEK cancellation response did not include a DELETE request",
      );
      return "needs_review";
    }

    if (!cancellationIsCausal(financialOrder, effect)) {
      const current = await loadShipment(client, effect.order_id);
      return finishNonCausalCancellation(
        client,
        effect,
        workerId,
        financialOrder,
        current,
        { providerDeleteAttempted: durableProviderDeleteAttempted },
      );
    }
    if (effect.attempts >= maxAttempts) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: "cancellation_confirmation_exhausted",
          shipmentId: shipment.id,
          currentOrderStatus: financialOrder.status,
          providerDeleteAttempted: durableProviderDeleteAttempted,
          ...responseSummary,
        },
        `CDEK cancellation was not confirmed after ${effect.attempts} attempts`,
      );
      return "needs_review";
    }
    await markEffectRetry(
      client,
      effect,
      workerId,
      new EffectRetryError("CDEK cancellation accepted; awaiting confirmation"),
      {
        outcome: "cancellation_pending",
        shipmentId: shipment.id,
        currentOrderStatus: financialOrder.status,
        providerDeleteAttempted: durableProviderDeleteAttempted,
        ...responseSummary,
      },
    );
    return "retry";
  });
}

async function finalizeProviderIoError(
  context: EffectContext,
  effect: CdekEffectRow,
  workerId: string,
  shipment: ShipmentRow,
  error: unknown,
  providerDeleteAttempted: boolean,
): Promise<CancelEffectOutcome> {
  const durableProviderDeleteAttempted =
    providerDeleteAttempted || effect.payload.providerDeleteAttempted === true;
  return context.db.withTransaction(async (client) => {
    const financialOrder = await lockOrderFinancialState(client, effect.order_id);
    const current = await loadShipment(client, effect.order_id);
    if (!financialOrder) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: "financial_state_missing_after_provider_error",
          shipmentId: shipment.id,
          providerDeleteAttempted: durableProviderDeleteAttempted,
          ...providerFailureSummary(error),
        },
        boundedText(errorMessage(error)),
      );
      return "needs_review";
    }
    if (!cancellationIsCausal(financialOrder, effect)) {
      return finishNonCausalCancellation(
        client,
        effect,
        workerId,
        financialOrder,
        current,
        { providerDeleteAttempted: durableProviderDeleteAttempted },
      );
    }
    if (needsOperatorReview(error) || effect.attempts >= maxAttempts) {
      await markEffectTerminal(
        client,
        effect,
        workerId,
        "needs_review",
        {
          outcome: needsOperatorReview(error)
            ? "provider_rejected"
            : "retry_exhausted",
          shipmentId: shipment.id,
          currentOrderStatus: financialOrder.status,
          providerDeleteAttempted: durableProviderDeleteAttempted,
          ...providerFailureSummary(error),
        },
        boundedText(errorMessage(error)),
      );
      return "needs_review";
    }
    await markEffectRetry(client, effect, workerId, error, {
      outcome: "cancellation_provider_retry",
      shipmentId: shipment.id,
      currentOrderStatus: financialOrder.status,
      providerDeleteAttempted: durableProviderDeleteAttempted,
      ...providerFailureSummary(error),
    });
    return "retry";
  });
}

async function processCancelEffect(
  context: EffectContext,
  effect: CdekEffectRow,
  workerId: string,
  cancelOrder: typeof cancelCdekOrder,
  getOrder: typeof getCdekOrder,
  findOrderByImNumber: typeof getCdekOrderByImNumber,
): Promise<CancelEffectOutcome> {
  let prepared = await prepareCancellation(context, effect, workerId);
  if (prepared.kind === "finished") return prepared.outcome;

  if (prepared.kind === "reconcile") {
    try {
      // Provider lookup and durable UUID adoption intentionally happen outside
      // any database transaction. The next preparation transaction rechecks
      // the financial state before a cancellation intent is persisted.
      await reconcileShipmentForCancellation(
        context,
        context.db as unknown as CdekEffectQueryable,
        prepared.orderNumber,
        prepared.shipment,
        findOrderByImNumber,
      );
    } catch (error) {
      return finalizeProviderIoError(
        context,
        effect,
        workerId,
        prepared.shipment,
        error,
        false,
      );
    }
    prepared = await prepareCancellation(context, effect, workerId);
    if (prepared.kind === "finished") return prepared.outcome;
    if (prepared.kind === "reconcile") {
      return finalizeProviderIoError(
        context,
        effect,
        workerId,
        prepared.shipment,
        new EffectRetryError(
          "CDEK shipment UUID is not persisted yet; cancellation deferred",
        ),
        false,
      );
    }
  }

  const providerPlan = prepared;
  let providerShipment = providerPlan.shipment;
  const priorProviderDeleteAttempted =
    effect.payload.providerDeleteAttempted === true;

  // Every cancellation, including legacy rows created before the identity
  // boundary existed, first proves that the exact provider UUID belongs to
  // this merchant order. The lookup runs after durable `deleting` intent and
  // outside a database transaction.
  let exactResponse: CdekOrderResponse;
  let exactNotFound = false;
  try {
    exactResponse = await getOrder(
      context.config,
      providerShipment.cdek_uuid!,
    );
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.code === "cdek_request_failed" &&
      error.details.providerStatus === 404
    ) {
      try {
        const merchantLookup = await findOrderByImNumber(
          context.config,
          providerPlan.orderNumber,
        );
        if (merchantLookup) {
          // A UUID miss is not absence when the merchant-order lookup still
          // finds a live record. Strict identity validation below prevents a
          // stale/foreign legacy UUID from being silently marked deleted.
          exactResponse = merchantLookup;
        } else {
          if (!priorProviderDeleteAttempted) {
            return finalizeProviderIoError(
              context,
              effect,
              workerId,
              providerShipment,
              new EffectRetryError(
                "CDEK shipment absence is not terminal before a durable provider DELETE attempt",
              ),
              false,
            );
          }
          exactNotFound = true;
          exactResponse = {
            entity: { uuid: providerShipment.cdek_uuid! },
            requests: [{ type: "DELETE", state: "SUCCESSFUL" }],
          };
        }
      } catch (lookupError) {
        return finalizeProviderIoError(
          context,
          effect,
          workerId,
          providerShipment,
          lookupError,
          false,
        );
      }
    } else {
      return finalizeProviderIoError(
        context,
        effect,
        workerId,
        providerShipment,
        error,
        false,
      );
    }
  }

  if (!exactNotFound) {
    try {
      validateExactCancellationLookupIdentity(
        exactResponse,
        providerShipment,
        providerPlan.orderNumber,
      );
    } catch (error) {
      return finalizeProviderIoError(
        context,
        effect,
        workerId,
        providerShipment,
        error,
        false,
      );
    }
  }

  try {
    if (cancellationState(exactResponse, true) !== "missing") {
      const observedProviderDeleteAttempted =
        priorProviderDeleteAttempted ||
        Boolean(
          exactResponse.requests?.some(
            (request) =>
              boundedText(request.type, 40).toUpperCase() === "DELETE",
          ),
        );
      return finalizeProviderResponse(
        context,
        effect,
        workerId,
        providerShipment,
        providerPlan.orderNumber,
        exactResponse,
        observedProviderDeleteAttempted,
        true,
      );
    }
  } catch {
    return finalizeProviderResponse(
      context,
      effect,
      workerId,
      providerShipment,
      providerPlan.orderNumber,
      exactResponse,
      priorProviderDeleteAttempted,
      true,
    );
  }

  const guard = await guardBeforeProviderDelete(
    context,
    effect,
    workerId,
    providerShipment,
    providerPlan.restoreStatus,
  );
  if (guard.kind === "finished") return guard.outcome;
  providerShipment = guard.shipment;

  let response: CdekOrderResponse;
  try {
    // No database transaction or row lock is held across this network call.
    response = await cancelOrder(context.config, providerShipment.cdek_uuid!);
  } catch (error) {
    return finalizeProviderIoError(
      context,
      effect,
      workerId,
      providerShipment,
      error,
      true,
    );
  }

  return finalizeProviderResponse(
    context,
    effect,
    workerId,
    providerShipment,
    providerPlan.orderNumber,
    response,
    true,
  );
}

function needsOperatorReview(error: unknown): boolean {
  if (error instanceof EffectNeedsReviewError) return true;
  if (!(error instanceof HttpError)) return false;
  const providerStatus = Number(error.details.providerStatus);
  if (
    providerStatus === 408 ||
    providerStatus === 425 ||
    providerStatus === 429 ||
    providerStatus >= 500
  ) {
    return false;
  }
  return error.statusCode >= 400 && error.statusCode < 500;
}

function providerFailureSummary(error: unknown): Record<string, unknown> {
  if (error instanceof EffectNeedsReviewError) return error.auditPayload;
  if (!(error instanceof HttpError)) return {};
  return {
    providerFailure: {
      code: error.code,
      status: error.details.providerStatus ?? null,
      errorCode: error.details.providerErrorCode ?? null,
    },
  };
}

/** Claim and process due CDEK effects. Provider failures never escape as webhook failures. */
export async function processCdekEffects(
  context: EffectContext,
  options: ProcessCdekEffectsOptions = {},
): Promise<ProcessCdekEffectsResult> {
  const workerId =
    boundedText(options.workerId, 160) ||
    `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const limit = Math.max(
    1,
    Math.min(100, Math.trunc(options.limit ?? defaultBatchSize)),
  );
  const createShipment = options.createShipment ?? createCdekShipmentForOrder;
  const cancelOrder = options.cancelOrder ?? cancelCdekOrder;
  const getOrder = options.getOrder ?? getCdekOrder;
  const findOrderByImNumber =
    options.getOrderByImNumber ?? getCdekOrderByImNumber;
  const result: ProcessCdekEffectsResult = {
    claimed: 0,
    completed: 0,
    retried: 0,
    needsReview: 0,
    canceled: 0,
  };

  for (let index = 0; index < limit; index += 1) {
    const effect = await claimNextEffect(context.db, workerId);
    if (!effect) break;
    result.claimed += 1;

    try {
      const outcome =
        effect.effect_type === "cdek_create"
          ? await processCreateEffect(context, effect, workerId, createShipment)
          : await processCancelEffect(
              context,
              effect,
              workerId,
              cancelOrder,
              getOrder,
              findOrderByImNumber,
            );
      if (outcome === "canceled") result.canceled += 1;
      else if (outcome === "retry") result.retried += 1;
      else if (outcome === "needs_review") result.needsReview += 1;
      else result.completed += 1;
      context.logger?.info(
        {
          effectId: effect.id,
          effectType: effect.effect_type,
          orderId: effect.order_id,
          attempts: effect.attempts,
          outcome,
        },
        "CDEK effect processed",
      );
    } catch (error) {
      if (needsOperatorReview(error) || effect.attempts >= maxAttempts) {
        await markEffectTerminal(
          context.db as unknown as CdekEffectQueryable,
          effect,
          workerId,
          "needs_review",
          {
            outcome: needsOperatorReview(error)
              ? "provider_rejected"
              : "retry_exhausted",
            ...providerFailureSummary(error),
          },
          boundedText(errorMessage(error)),
        );
        result.needsReview += 1;
        context.logger?.error(
          {
            err: error,
            effectId: effect.id,
            effectType: effect.effect_type,
            orderId: effect.order_id,
            attempts: effect.attempts,
          },
          "CDEK effect requires operator review",
        );
      } else {
        await markEffectRetry(
          context.db as unknown as CdekEffectQueryable,
          effect,
          workerId,
          error,
          providerFailureSummary(error),
        );
        result.retried += 1;
        context.logger?.warn(
          {
            err: error,
            effectId: effect.id,
            effectType: effect.effect_type,
            orderId: effect.order_id,
            attempts: effect.attempts,
          },
          "CDEK effect deferred for retry",
        );
      }
    }
  }

  return result;
}

export function startCdekEffectWorker(
  context: EffectContext,
  options: ProcessCdekEffectsOptions & { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 10_000);
  const workerId =
    boundedText(options.workerId, 160) ||
    `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let running = false;
  let inFlight: Promise<void> | null = null;
  let activeRun: symbol | null = null;

  const run = () => {
    if (stopped || running) return inFlight ?? Promise.resolve();
    running = true;
    const runToken = Symbol("cdek-effect-run");
    activeRun = runToken;
    const current = (async () => {
      try {
        await processCdekEffects(context, { ...options, workerId });
      } catch (error) {
        context.logger?.error(
          { err: error, workerId },
          "CDEK effect worker failed",
        );
      } finally {
        running = false;
        if (activeRun === runToken) {
          activeRun = null;
          inFlight = null;
        }
      }
    })();
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
