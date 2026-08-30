import type { PoolClient, QueryResultRow } from "pg";
import type { Db } from "./db";
import {
  markPromoRedemptionRedeemed,
  releasePromoRedemption,
} from "./promo";
import {
  findOtherTbankPaymentIdentityOwner,
  lockTbankPaymentIdentity,
} from "./tbankPaymentIdentity";

type PaymentAttemptRow = QueryResultRow & {
  id: number;
  order_id: string;
  amount: number;
  external_payment_id: string | null;
  provider_status: string;
  terminal_key: string;
  response_payload: Record<string, unknown> | null;
};

type OrderRow = QueryResultRow & {
  id: string;
  order_number: string;
  total_amount: number;
  status: string;
  paid_at: string | null;
};

export type TbankWebhookEventInput = {
  terminalKey: string;
  paymentId: string;
  orderNumber: string;
  providerStatus: string;
  amount: number | null;
  eventHash: string;
  payload: Record<string, unknown>;
};

export type TbankWebhookTransition = {
  eventId: number;
  eventHash: string;
  orderId: string;
  orderNumber: string;
  paymentAttemptId: number | null;
  paymentId: string;
  providerStatus: string;
  previousOrderStatus: string;
  resultingOrderStatus: string;
  expectedAmount: number;
  receivedAmount: number | null;
  amountMismatch: boolean;
  terminalMismatch: boolean;
  paymentIdentityMismatch: boolean;
  paymentStateConflict: boolean;
  providerStatusApplied: boolean;
  becamePaid: boolean;
  becameRefunded: boolean;
};

export type TbankWebhookOutcome = {
  duplicate: boolean;
  providerStatusApplied: boolean;
  orderStatusChanged: boolean;
  transition: TbankWebhookTransition;
};

export type TbankWebhookTransactionHook = (
  client: PoolClient,
  transition: TbankWebhookTransition,
) => Promise<void>;

export class TbankWebhookOrderNotFoundError extends Error {
  constructor() {
    super("T-Bank webhook order not found");
    this.name = "TbankWebhookOrderNotFoundError";
  }
}

export class TbankWebhookOrderMismatchError extends Error {
  constructor() {
    super("T-Bank webhook payment and order identifiers do not match");
    this.name = "TbankWebhookOrderMismatchError";
  }
}

const providerStatusRanks: Record<string, number> = {
  INITIATING: 0,
  INIT_UNKNOWN: 0,
  RECONCILING_INIT: 0,
  NETWORK_ERROR: 0,
  INIT_ERROR: 0,
  MOCK_INIT: 0,
  NEW: 1,
  FORM_SHOWED: 2,
  AUTHORIZING: 3,
  "3DS_CHECKING": 4,
  "3DS_CHECKED": 5,
  AUTH_FAIL: 6,
  AUTHORIZED: 10,
  CONFIRMING: 11,
  REVERSING: 11,
  REFUNDING: 11,
  CANCELED: 20,
  REJECTED: 20,
  DEADLINE_EXPIRED: 20,
  REVERSED: 20,
  CONFIRMED: 30,
  PARTIAL_REVERSED: 41,
  PARTIAL_REFUNDED: 40,
  REFUNDED: 50,
};

/**
 * Provider notifications may be concurrent or arrive out of order. A status
 * with less financial finality must never replace a more final status.
 */
export function shouldApplyTbankProviderStatus(
  currentStatus: string,
  nextStatus: string,
): boolean {
  // The quarantine can represent more than one provider PaymentId. No status
  // for one of those identities is allowed to adjudicate the other implicitly.
  if (currentStatus === "INIT_REVIEW") return false;
  if (!nextStatus || currentStatus === nextStatus) return false;
  const currentRank = providerStatusRanks[currentStatus] ?? 0;
  const nextRank = providerStatusRanks[nextStatus] ?? 0;
  return nextRank > currentRank;
}

export function tbankOrderStatus(providerStatus: string): string | null {
  switch (providerStatus) {
    case "CONFIRMED":
      return "paid";
    case "AUTHORIZED":
      return "authorized";
    case "REFUNDED":
      return "refunded";
    case "PARTIAL_REFUNDED":
      return "partially_refunded";
    case "PARTIAL_REVERSED":
      return "payment_review";
    case "REJECTED":
    case "CANCELED":
    case "REVERSED":
    case "DEADLINE_EXPIRED":
      return "payment_failed";
    default:
      return null;
  }
}

/**
 * A partial refund is only meaningful after a locally confirmed charge. If it
 * is the first financial fact we see, keep fulfillment blocked until a later
 * CONFIRMED/REFUNDED event or operator reconciliation resolves the conflict.
 */
export function tbankOrderStatusForCurrentOrder(
  currentOrderStatus: string,
  providerStatus: string,
): string | null {
  if (
    providerStatus === "PARTIAL_REFUNDED" &&
    !["paid", "partially_refunded"].includes(currentOrderStatus)
  ) {
    return "payment_review";
  }
  return tbankOrderStatus(providerStatus);
}

/** Explicit order state graph. Successful financial states are irreversible. */
export function canApplyTbankOrderStatus(
  currentStatus: string,
  nextStatus: string,
): boolean {
  if (currentStatus === nextStatus) return false;
  switch (currentStatus) {
    case "paid":
      return ["partially_refunded", "refunded"].includes(nextStatus);
    case "partially_refunded":
      return nextStatus === "refunded";
    case "refunded":
      return false;
    case "payment_review":
      return ["paid", "partially_refunded", "refunded"].includes(nextStatus);
    case "payment_failed":
      return ["paid", "payment_review", "partially_refunded", "refunded"].includes(
        nextStatus,
      );
    case "canceled":
      return ["paid", "payment_review", "partially_refunded", "refunded"].includes(
        nextStatus,
      );
    case "authorized":
      return [
        "paid",
        "payment_failed",
        "payment_review",
        "partially_refunded",
        "refunded",
      ].includes(nextStatus);
    case "created":
    case "pending_payment":
    case "payment_unknown":
      return [
        "authorized",
        "paid",
        "payment_failed",
        "payment_review",
        "partially_refunded",
        "refunded",
      ].includes(nextStatus);
    default:
      return false;
  }
}

export function canApplyTbankOrderProjection(
  currentStatus: string,
  nextStatus: string,
  context: {
    providerStatus: string;
    amountMismatch: boolean;
    paymentIdentityConflict?: boolean;
    paymentStateConflict?: boolean;
  },
): boolean {
  if (
    nextStatus === "payment_review" &&
    context.amountMismatch &&
    ["paid", "partially_refunded"].includes(currentStatus)
  ) {
    return true;
  }
  if (
    nextStatus === "payment_review" &&
    context.paymentIdentityConflict === true &&
    ["paid", "partially_refunded", "refunded"].includes(currentStatus)
  ) {
    return true;
  }
  if (
    nextStatus === "payment_review" &&
    context.paymentStateConflict === true &&
    ["authorized", "paid", "partially_refunded"].includes(currentStatus)
  ) {
    return true;
  }
  if (
    nextStatus === "payment_review" &&
    !context.amountMismatch &&
    context.providerStatus === "PARTIAL_REVERSED" &&
    ["paid", "partially_refunded", "authorized"].includes(currentStatus)
  ) {
    return true;
  }
  return canApplyTbankOrderStatus(currentStatus, nextStatus);
}

async function locateAttemptByPaymentId(
  client: PoolClient,
  paymentId: string,
): Promise<Pick<PaymentAttemptRow, "id" | "order_id"> | null> {
  if (!paymentId) return null;
  const result = await client.query<Pick<PaymentAttemptRow, "id" | "order_id">>(
    `
      select id, order_id
      from public.merch_payment_attempts
      where provider = 'tbank'
        and external_payment_id = $1
      limit 1
    `,
    [paymentId],
  );
  return result.rows[0] ?? null;
}

async function locateOrderIdByNumber(
  client: PoolClient,
  orderNumber: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      select id
      from public.merch_customer_orders
      where order_number = $1
      limit 1
    `,
    [orderNumber],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new TbankWebhookOrderNotFoundError();
  return id;
}

async function locateLatestAttemptForOrder(
  client: PoolClient,
  orderId: string,
): Promise<Pick<PaymentAttemptRow, "id" | "order_id">> {
  const result = await client.query<Pick<PaymentAttemptRow, "id" | "order_id">>(
    `
      select id, order_id
      from public.merch_payment_attempts
      where order_id = $1::uuid
        and provider = 'tbank'
      order by created_at desc, id desc
      limit 1
    `,
    [orderId],
  );
  const attempt = result.rows[0];
  if (!attempt) throw new TbankWebhookOrderMismatchError();
  return attempt;
}

async function lockAttempt(
  client: PoolClient,
  attemptId: number,
): Promise<PaymentAttemptRow> {
  const result = await client.query<PaymentAttemptRow>(
    `
      select
        id,
        order_id,
        amount,
        external_payment_id,
        provider_status,
        terminal_key,
        response_payload
      from public.merch_payment_attempts
      where id = $1
      limit 1
      for update
    `,
    [attemptId],
  );
  const attempt = result.rows[0];
  if (!attempt) throw new TbankWebhookOrderMismatchError();
  return attempt;
}

async function lockOrder(
  client: PoolClient,
  orderId: string,
  orderNumber: string,
): Promise<OrderRow> {
  const result = await client.query<OrderRow>(
    `
      select id, order_number, total_amount, status, paid_at
      from public.merch_customer_orders
      where id = $1::uuid
      limit 1
      for update
    `,
    [orderId],
  );
  const order = result.rows[0];
  if (!order) throw new TbankWebhookOrderNotFoundError();
  if (orderNumber && order.order_number !== orderNumber) {
    throw new TbankWebhookOrderMismatchError();
  }
  return order;
}

export async function processTbankWebhookEvent(
  db: Db,
  input: TbankWebhookEventInput,
  options: { onTransition?: TbankWebhookTransactionHook } = {},
): Promise<TbankWebhookOutcome> {
  return db.withTransaction(async (client) => {
    let locatedAttempt = await locateAttemptByPaymentId(client, input.paymentId);
    if (!locatedAttempt) {
      const orderId = await locateOrderIdByNumber(client, input.orderNumber);
      // An early webhook may arrive before Init persistence binds PaymentId.
      // Only the latest attempt is eligible; an older unbound attempt must not
      // steal a notification from a newer, already-bound payment.
      locatedAttempt = await locateLatestAttemptForOrder(client, orderId);
    }

    // Keep the same lock order as Init persistence: attempt first, order next.
    const attempt = await lockAttempt(client, locatedAttempt.id);
    const order = await lockOrder(client, attempt.order_id, input.orderNumber);
    let paymentIdentityOwner:
      | Awaited<ReturnType<typeof findOtherTbankPaymentIdentityOwner>>
      | null = null;
    if (!attempt.external_payment_id) {
      await lockTbankPaymentIdentity(client, input.paymentId);
      paymentIdentityOwner = await findOtherTbankPaymentIdentityOwner(
        client,
        input.paymentId,
        attempt.id,
      );
    }

    const insertedEvent = await client.query<{ id: number }>(
      `
        insert into public.merch_payment_events (
          payment_attempt_id,
          order_id,
          external_payment_id,
          provider_status,
          event_hash,
          signature_valid,
          amount,
          payload
        )
        values ($1, $2::uuid, $3, $4, $5, true, $6, $7::jsonb)
        on conflict (event_hash) do nothing
        returning id
      `,
      [
        attempt.id,
        order.id,
        input.paymentId || null,
        input.providerStatus || null,
        input.eventHash,
        input.amount,
        JSON.stringify(input.payload),
      ],
    );

    let eventId = insertedEvent.rows[0]?.id;
    const duplicate = !eventId;
    if (!eventId) {
      const existingEvent = await client.query<{
        id: number;
        order_id: string | null;
        payment_attempt_id: number | null;
      }>(
        `
          select id, order_id, payment_attempt_id
          from public.merch_payment_events
          where event_hash = $1
          limit 1
        `,
        [input.eventHash],
      );
      const existing = existingEvent.rows[0];
      if (
        !existing ||
        existing.order_id !== order.id ||
        (existing.payment_attempt_id !== null &&
          existing.payment_attempt_id !== attempt.id)
      ) {
        throw new TbankWebhookOrderMismatchError();
      }
      eventId = existing.id;
    }
    const baseTransition: TbankWebhookTransition = {
      eventId,
      eventHash: input.eventHash,
      orderId: order.id,
      orderNumber: order.order_number,
      paymentAttemptId: attempt.id,
      paymentId: input.paymentId,
      providerStatus: input.providerStatus,
      previousOrderStatus: order.status,
      resultingOrderStatus: order.status,
      expectedAmount: Number(order.total_amount),
      receivedAmount: input.amount,
      amountMismatch: false,
      terminalMismatch: false,
      paymentIdentityMismatch: false,
      paymentStateConflict: false,
      providerStatusApplied: false,
      becamePaid: false,
      becameRefunded: false,
    };

    // Verify the complete local/provider amount boundary for every status
    // before binding an early PaymentId or mutating either state machine.
    const amountMismatch =
      input.amount === null ||
      !Number.isSafeInteger(input.amount) ||
      input.amount <= 0 ||
      input.amount !== Number(order.total_amount) ||
      Number(attempt.amount) !== Number(order.total_amount);
    const terminalMismatch =
      !attempt.terminal_key || attempt.terminal_key !== input.terminalKey;
    const paymentIdentityMismatch = Boolean(
      (attempt.external_payment_id &&
        attempt.external_payment_id !== input.paymentId) ||
        paymentIdentityOwner,
    );
    const cancellationWasAttempted =
      attempt.response_payload?.tbank_cancel_attempted === true;
    const paymentStateConflict =
      cancellationWasAttempted &&
      ["AUTHORIZED", "CONFIRMED", "PARTIAL_REFUNDED"].includes(
        input.providerStatus,
      );
    const existingQuarantine =
      attempt.response_payload?.payment_review_quarantine;
    const projectionQuarantined = Boolean(
      existingQuarantine &&
        typeof existingQuarantine === "object" &&
        !Array.isArray(existingQuarantine),
    );
    const shouldQuarantineBoundary =
      paymentIdentityMismatch ||
      terminalMismatch ||
      (amountMismatch && order.status !== "refunded") ||
      paymentStateConflict;
    const providerStatusApplied = Boolean(
      !amountMismatch &&
        !terminalMismatch &&
        !paymentIdentityMismatch &&
        !paymentStateConflict &&
        shouldApplyTbankProviderStatus(
          attempt.provider_status,
          input.providerStatus,
        ),
    );
    if (shouldQuarantineBoundary) {
      const quarantineReason =
        paymentIdentityMismatch || terminalMismatch
          ? "payment_identity_conflict"
          : paymentStateConflict
            ? "payment_state_conflict"
            : "amount_mismatch";
      const quarantineCode = paymentIdentityMismatch
        ? "tbank_payment_id_boundary_mismatch"
        : terminalMismatch
          ? "tbank_terminal_boundary_mismatch"
          : paymentStateConflict
            ? "tbank_cancel_payment_state_conflict"
            : "tbank_amount_mismatch";
      await client.query(
        `
          update public.merch_payment_attempts
          set provider_status = 'INIT_REVIEW',
              payment_url = null,
              error_code = case
                when provider_status = 'INIT_REVIEW' then error_code
                else $2
              end,
              error_message = case
                when provider_status = 'INIT_REVIEW' then error_message
                else $3
              end,
              response_payload = jsonb_set(
                coalesce(response_payload, '{}'::jsonb),
                '{payment_review_quarantine}',
                coalesce(
                  response_payload -> 'payment_review_quarantine',
                  $4::jsonb -> 'payment_review_quarantine'
                ),
                true
              ),
              reconciliation_next_at = null
          where id = $1
        `,
        [
          attempt.id,
          quarantineCode,
          "Signed T-Bank webhook crossed a locked payment boundary",
          JSON.stringify({
            payment_review_quarantine: {
              reason: quarantineReason,
              prior_provider_status: attempt.provider_status,
              received_provider_status: input.providerStatus,
              payment_id: input.paymentId,
              stored_payment_id: attempt.external_payment_id,
              conflicting_attempt_id: paymentIdentityOwner?.id ?? null,
              conflicting_order_id: paymentIdentityOwner?.order_id ?? null,
              expected_amount: Number(order.total_amount),
              received_amount: input.amount,
              stored_terminal_key: attempt.terminal_key || null,
              received_terminal_key: input.terminalKey,
              event_hash: input.eventHash,
            },
          }),
        ],
      );
    } else if (
      !amountMismatch &&
      !terminalMismatch &&
      !paymentIdentityMismatch &&
      !paymentStateConflict &&
      (providerStatusApplied || !attempt.external_payment_id)
    ) {
      await client.query(
        `
          update public.merch_payment_attempts
          set external_payment_id = coalesce(external_payment_id, $2),
              provider_status = case when $3::boolean then $4 else provider_status end,
              error_code = case when $3::boolean then null else error_code end,
              error_message = case when $3::boolean then null else error_message end,
              confirmed_at = case
                when $3::boolean and $4 = 'CONFIRMED'
                  then coalesce(confirmed_at, now())
                else confirmed_at
              end
          where id = $1
        `,
        [
          attempt.id,
          input.paymentId || null,
          providerStatusApplied,
          input.providerStatus,
        ],
      );
    }

    // The order projection may only follow a provider fact that advanced the
    // locked attempt, or replay the exact fact already stored on that attempt
    // to heal an incomplete legacy transaction. A stale lower-rank event must
    // not drive fulfillment merely because its order transition looks valid.
    const canProjectProviderStatus =
      !amountMismatch &&
      !terminalMismatch &&
      !paymentIdentityMismatch &&
      !paymentStateConflict &&
      !projectionQuarantined &&
      (providerStatusApplied ||
        attempt.provider_status === input.providerStatus);
    const mappedStatus = canProjectProviderStatus
      ? tbankOrderStatusForCurrentOrder(order.status, input.providerStatus)
      : null;
    const requestedOrderStatus =
      amountMismatch ||
      terminalMismatch ||
      paymentIdentityMismatch ||
      paymentStateConflict
        ? "payment_review"
        : mappedStatus;
    const orderStatusChanged = Boolean(
      requestedOrderStatus &&
        canApplyTbankOrderProjection(order.status, requestedOrderStatus, {
          providerStatus: input.providerStatus,
          amountMismatch,
          paymentIdentityConflict:
            paymentIdentityMismatch || terminalMismatch,
          paymentStateConflict,
        }),
    );
    const resultingOrderStatus = orderStatusChanged
      ? (requestedOrderStatus as string)
      : order.status;

    const paymentReviewMetadata = paymentIdentityMismatch
      ? {
          payment_review_reason: "payment_identity_conflict",
          payment_review_code: "tbank_payment_id_boundary_mismatch",
          stored_payment_id: attempt.external_payment_id,
          received_payment_id: input.paymentId,
          conflicting_attempt_id: paymentIdentityOwner?.id ?? null,
          conflicting_order_id: paymentIdentityOwner?.order_id ?? null,
          provider_status: input.providerStatus,
        }
      : terminalMismatch
        ? {
            payment_review_reason: "payment_identity_conflict",
            payment_review_code: "tbank_terminal_boundary_mismatch",
            stored_terminal_key: attempt.terminal_key || null,
            received_terminal_key: input.terminalKey,
            provider_status: input.providerStatus,
            payment_id: input.paymentId,
          }
        : paymentStateConflict
          ? {
              payment_review_reason: "payment_state_conflict",
              payment_review_code: "tbank_cancel_payment_state_conflict",
              provider_status: input.providerStatus,
              payment_id: input.paymentId,
            }
          : amountMismatch
            ? {
                payment_review_reason: "amount_mismatch",
                expected_amount: Number(order.total_amount),
                received_amount: input.amount,
                provider_status: input.providerStatus,
                payment_id: input.paymentId,
              }
      : input.providerStatus === "PARTIAL_REVERSED"
        ? {
            payment_review_reason: "partial_reversed",
            provider_status: input.providerStatus,
            payment_id: input.paymentId,
          }
        : {};

    if (orderStatusChanged) {
      await client.query(
        `
          update public.merch_customer_orders
          set status = $2,
              paid_at = case when $2 = 'paid' then coalesce(paid_at, now()) else paid_at end,
              metadata = case
                when $2 = 'payment_review'
                  then metadata || $3::jsonb
                else metadata
              end
          where id = $1::uuid
            and status = $4
        `,
        [
          order.id,
          resultingOrderStatus,
          JSON.stringify(paymentReviewMetadata),
          order.status,
        ],
      );

      if (resultingOrderStatus === "paid") {
        await markPromoRedemptionRedeemed(client, order.id);
      } else if (resultingOrderStatus === "payment_failed") {
        await releasePromoRedemption(client, order.id);
      } else if (resultingOrderStatus === "refunded") {
        await releasePromoRedemption(client, order.id, "canceled");
      }
    } else if (paymentStateConflict && order.status === "payment_review") {
      // A prior review reason may be unrelated. Bind the causal cancellation
      // intent to this durable marker conflict even when the status is already
      // payment_review, otherwise the fulfillment worker must reject it.
      await client.query(
        `
          update public.merch_customer_orders
          set metadata = metadata || $2::jsonb
          where id = $1::uuid
            and status = 'payment_review'
        `,
        [order.id, JSON.stringify(paymentReviewMetadata)],
      );
    }

    const transition: TbankWebhookTransition = {
      ...baseTransition,
      resultingOrderStatus,
      amountMismatch,
      terminalMismatch,
      paymentIdentityMismatch,
      paymentStateConflict,
      providerStatusApplied,
      becamePaid: orderStatusChanged && resultingOrderStatus === "paid",
      becameRefunded: orderStatusChanged && resultingOrderStatus === "refunded",
    };
    if (
      (!duplicate ||
        orderStatusChanged ||
        providerStatusApplied ||
        paymentStateConflict) &&
      options.onTransition
    ) {
      await options.onTransition(client, transition);
    }

    return {
      duplicate,
      providerStatusApplied,
      orderStatusChanged,
      transition,
    };
  });
}
