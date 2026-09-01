import type { PoolClient, QueryResultRow } from "pg";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { createTbankToken, sanitizedTbankPayload } from "./crypto";
import { enqueueCdekEffect } from "./cdekEffects";
import { errorDiagnostic, HttpError } from "./errors";
import {
  markPromoRedemptionRedeemed,
  releasePromoRedemption,
} from "./promo";
import {
  canApplyTbankOrderProjection,
  shouldApplyTbankProviderStatus,
  tbankOrderStatusForCurrentOrder,
} from "./tbankWebhook";
import {
  findOtherTbankPaymentIdentityOwner,
  lockTbankPaymentIdentity,
} from "./tbankPaymentIdentity";
import { enqueueOrderPaidEmail } from "./email/orderPaidOutbox";

export type TbankProviderConfig = {
  terminalKey: string;
  password: string;
  apiUrl: string;
  mock: boolean;
  requestTimeoutMs: number;
};

type ReconciliationLogger = {
  info?: (details: unknown, message?: string) => void;
  warn?: (details: unknown, message?: string) => void;
  error?: (details: unknown, message?: string) => void;
};

type ClaimedAttempt = QueryResultRow & {
  id: number;
  order_id: string;
  order_number: string;
  amount: number;
  order_total_amount: number;
  terminal_key: string;
  external_payment_id: string | null;
  reconciliation_attempts: number;
};

type LockedReconciliationAttempt = QueryResultRow & {
  attempt_status: string;
  order_status: string;
  external_payment_id: string | null;
  reconciliation_attempts: number;
  attempt_amount: number;
  order_total_amount: number;
  terminal_key: string;
  response_payload: Record<string, unknown> | null;
};

type CheckOrderPayment = {
  paymentId: string;
  amount: number | null;
  status: string;
};

type ProviderSnapshot = {
  checkOrder: Record<string, unknown>;
  getState: Record<string, unknown> | null;
  cancel?: {
    attempted: true;
    response: Record<string, unknown> | null;
  };
};

type TbankCancelCandidate = {
  orderNumber: string;
  expectedAmount: number;
  paymentId: string;
};

type TbankBeforeCancel = (
  candidate: TbankCancelCandidate,
) => Promise<boolean>;

export type TbankInitReconciliationResult =
  | {
      kind: "failed";
      paymentId: string | null;
      providerStatus: string;
      errorCode: string | null;
      errorMessage: string;
      snapshot: ProviderSnapshot;
    }
  | {
      kind: "review";
      paymentId: string | null;
      providerStatus: string;
      errorCode: string;
      errorMessage: string;
      snapshot: ProviderSnapshot | null;
    }
  | {
      kind: "processed";
      paymentId: string;
      providerStatus: string;
      snapshot: ProviderSnapshot;
    }
  | {
      kind: "pending";
      paymentId: string | null;
      providerStatus: string;
      errorCode: string | null;
      errorMessage: string;
      snapshot: ProviderSnapshot | null;
    };

type SupersededTbankInitReconciliation = {
  kind: "superseded";
  paymentId: string | null;
  providerStatus: string;
  orderStatus: string;
};

type PersistedTbankInitReconciliation =
  | TbankInitReconciliationResult
  | SupersededTbankInitReconciliation;

export type ReconciledTbankInit = PersistedTbankInitReconciliation & {
  orderId: string;
  orderNumber: string;
};

const terminalFailureStatuses = new Set([
  "REJECTED",
  "CANCELED",
  "REVERSED",
  "DEADLINE_EXPIRED",
]);

const financiallyProcessedStatuses = new Set([
  "AUTHORIZED",
  "CONFIRMED",
  "PARTIAL_REFUNDED",
  "REFUNDED",
]);

const resumableTbankPaymentStatuses = new Set([
  "MOCK_INIT",
  "INITIATING",
  "INIT_UNKNOWN",
  "NETWORK_ERROR",
  "INIT_ERROR",
  "NEW",
  "FORM_SHOWED",
  "AUTHORIZING",
  "3DS_CHECKING",
  "3DS_CHECKED",
  "AUTH_FAIL",
]);

export function isResumableTbankPaymentStatus(status: string): boolean {
  return resumableTbankPaymentStatuses.has(status);
}

type LateInitDisposition =
  | "persisted"
  | "reconciling"
  | "review"
  | "processed"
  | "retry";

function lateInitDisposition(
  attemptStatus: string,
  orderStatus: string,
): LateInitDisposition {
  if (
    attemptStatus === "INIT_REVIEW" ||
    attemptStatus === "PARTIAL_REVERSED" ||
    orderStatus === "payment_review"
  ) {
    return "review";
  }
  if (["authorized", "paid", "partially_refunded"].includes(orderStatus)) {
    return "processed";
  }
  if (["payment_failed", "canceled", "refunded"].includes(orderStatus)) {
    return "retry";
  }
  if (attemptStatus === "RECONCILING_INIT") return "reconciling";
  if (["AUTHORIZED", "CONFIRMED", "PARTIAL_REFUNDED"].includes(attemptStatus)) {
    return "processed";
  }
  if (
    ["REJECTED", "CANCELED", "REVERSED", "DEADLINE_EXPIRED", "REFUNDED"].includes(
      attemptStatus,
    )
  ) {
    return "retry";
  }
  if (
    ["created", "pending_payment", "payment_unknown"].includes(orderStatus) &&
    isResumableTbankPaymentStatus(attemptStatus)
  ) {
    return "persisted";
  }
  return "review";
}

function scalarText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function successFlag(value: unknown): boolean {
  return value === true || value === "true";
}

function integerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function validTbankPaymentUrl(value: unknown): string {
  const raw = scalarText(value, 2_000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== "tbank.ru" &&
      !hostname.endsWith(".tbank.ru") &&
      hostname !== "tinkoff.ru" &&
      !hostname.endsWith(".tinkoff.ru")
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function tbankInitResponseMatchesBoundary(
  response: Record<string, unknown>,
  expected: { terminalKey: string; orderNumber: string; amount: number },
): boolean {
  const amount = integerOrNull(response.Amount);
  return (
    scalarText(response.TerminalKey, 80) === expected.terminalKey &&
    scalarText(response.OrderId, 50) === expected.orderNumber &&
    amount === expected.amount &&
    scalarText(response.Status, 80).toUpperCase() === "NEW"
  );
}

function safeProviderSnapshot(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const payments = Array.isArray(payload.Payments)
    ? payload.Payments.slice(0, 10).map((item) => {
        const row = item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
        return {
          PaymentId: scalarText(row.PaymentId, 120) || null,
          Amount: integerOrNull(row.Amount),
          Status: scalarText(row.Status, 80) || null,
          Success: successFlag(row.Success),
          ErrorCode: scalarText(row.ErrorCode, 80) || null,
        };
      })
    : undefined;
  return {
    TerminalKey: scalarText(payload.TerminalKey, 80) || null,
    OrderId: scalarText(payload.OrderId, 50) || null,
    PaymentId: scalarText(payload.PaymentId, 120) || null,
    Amount: integerOrNull(payload.Amount),
    Status: scalarText(payload.Status, 80) || null,
    Success: successFlag(payload.Success),
    ErrorCode: scalarText(payload.ErrorCode, 80) || null,
    HttpStatus: integerOrNull(payload.HttpStatus),
    Message: scalarText(payload.Message, 500) || null,
    Details: scalarText(payload.Details, 500) || null,
    PaymentURL: validTbankPaymentUrl(payload.PaymentURL) || null,
    ...(payments ? { Payments: payments } : {}),
  };
}

export function tbankRuntimeConfig(config: AppConfig): TbankProviderConfig {
  const terminalKey =
    config.TBANK_MODE === "production"
      ? config.TBANK_TERMINAL_KEY
      : config.TBANK_DEMO_TERMINAL_KEY;
  const password =
    config.TBANK_MODE === "production"
      ? config.TBANK_PASSWORD
      : config.TBANK_DEMO_PASSWORD;

  if (config.TBANK_MOCK_PAYMENTS) {
    return {
      terminalKey: terminalKey || "KOMUI_STAGE_MOCK",
      password: password || "komui-stage-mock-password",
      apiUrl: config.TBANK_API_URL,
      mock: true,
      requestTimeoutMs: config.TBANK_REQUEST_TIMEOUT_MS,
    };
  }

  if (!terminalKey || !password) {
    throw new HttpError(
      503,
      "tbank_not_configured",
      "T-Bank credentials are not configured",
    );
  }

  return {
    terminalKey,
    password,
    apiUrl: config.TBANK_API_URL,
    mock: false,
    requestTimeoutMs: config.TBANK_REQUEST_TIMEOUT_MS,
  };
}

async function providerRequest(
  provider: TbankProviderConfig,
  method: "CheckOrder" | "GetState" | "Cancel",
  unsignedPayload: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const payload = {
    ...unsignedPayload,
    Token: createTbankToken(unsignedPayload, provider.password),
  };
  const response = await fetchImpl(
    `${provider.apiUrl.replace(/\/$/, "")}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(provider.requestTimeoutMs),
    },
  );
  const responseText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(`T-Bank ${method} returned invalid JSON (${response.status})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`T-Bank ${method} returned an invalid payload`);
  }
  if (!response.ok) {
    const body = parsed as Record<string, unknown>;
    const errorCode = scalarText(body.ErrorCode, 80) || `http_${response.status}`;
    const message = scalarText(body.Message ?? body.Details, 500);
    throw new Error(`T-Bank ${method} ${errorCode}${message ? `: ${message}` : ""}`);
  }
  return parsed as Record<string, unknown>;
}

function checkOrderPayments(payload: Record<string, unknown>): {
  payments: CheckOrderPayment[];
  conflictingPaymentIds: string[];
  malformedRows: number;
} {
  if (!Array.isArray(payload.Payments)) {
    return { payments: [], conflictingPaymentIds: [], malformedRows: 0 };
  }
  const unique = new Map<string, CheckOrderPayment>();
  const conflicts = new Set<string>();
  let malformedRows = 0;
  for (const item of payload.Payments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      malformedRows += 1;
      continue;
    }
    const row = item as Record<string, unknown>;
    const paymentId = scalarText(row.PaymentId, 120);
    if (!paymentId) {
      malformedRows += 1;
      continue;
    }
    const payment = {
      paymentId,
      amount: integerOrNull(row.Amount),
      status: scalarText(row.Status, 80).toUpperCase() || "UNKNOWN",
    };
    const existing = unique.get(paymentId);
    if (
      existing &&
      (existing.amount !== payment.amount || existing.status !== payment.status)
    ) {
      conflicts.add(paymentId);
      continue;
    }
    if (!existing) unique.set(paymentId, payment);
  }
  return {
    payments: [...unique.values()],
    conflictingPaymentIds: [...conflicts],
    malformedRows,
  };
}

function choosePayment(
  payments: CheckOrderPayment[],
  expectedAmount: number,
): { payment: CheckOrderPayment | null; ambiguous: boolean } {
  const exact = payments.filter((payment) => payment.amount === expectedAmount);
  if (exact.length === 1) return { payment: exact[0], ambiguous: false };
  if (exact.length > 1) return { payment: null, ambiguous: true };
  return { payment: null, ambiguous: payments.length > 0 };
}

type ReconciliationBoundaryError = {
  errorCode:
    | "tbank_local_amount_boundary_mismatch"
    | "tbank_terminal_boundary_mismatch";
  errorMessage: string;
  audit: Record<string, unknown>;
};

function validMoneyAmount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function claimedReconciliationBoundaryError(
  attempt: Pick<
    ClaimedAttempt,
    "amount" | "order_total_amount" | "terminal_key"
  >,
  expectedTerminalKey: string,
): ReconciliationBoundaryError | null {
  const attemptAmount = Number(attempt.amount);
  const orderAmount = Number(attempt.order_total_amount);
  if (
    !validMoneyAmount(attemptAmount) ||
    !validMoneyAmount(orderAmount) ||
    attemptAmount !== orderAmount
  ) {
    return {
      errorCode: "tbank_local_amount_boundary_mismatch",
      errorMessage:
        "Stored payment attempt amount does not match the locked order total",
      audit: {
        attempt_amount: attempt.amount,
        order_total_amount: attempt.order_total_amount,
      },
    };
  }
  if (!attempt.terminal_key || attempt.terminal_key !== expectedTerminalKey) {
    return {
      errorCode: "tbank_terminal_boundary_mismatch",
      errorMessage:
        "Stored payment terminal does not match the active T-Bank terminal",
      audit: {
        stored_terminal_key: attempt.terminal_key || null,
        configured_terminal_key: expectedTerminalKey,
      },
    };
  }
  return null;
}

/**
 * Resolve a potentially successful Init by the immutable merchant OrderId.
 * CheckOrder discovers the PaymentId and GetState verifies its financial
 * state. The opaque payment-form URL cannot be recovered: an orphaned NEW
 * payment is canceled before a fresh merchant order may be created.
 */
export async function queryTbankInitState(
  provider: TbankProviderConfig,
  input: {
    orderNumber: string;
    expectedAmount: number;
    knownPaymentId?: string | null;
    beforeCancel?: TbankBeforeCancel;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TbankInitReconciliationResult> {
  let checkOrder: Record<string, unknown>;
  try {
    checkOrder = await providerRequest(
      provider,
      "CheckOrder",
      { TerminalKey: provider.terminalKey, OrderId: input.orderNumber },
      fetchImpl,
    );
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return {
      kind: "pending",
      paymentId: input.knownPaymentId ?? null,
      providerStatus: "INIT_UNKNOWN",
      errorCode: diagnostic.code,
      errorMessage: diagnostic.message,
      snapshot: null,
    };
  }

  const checkSnapshot = safeProviderSnapshot(checkOrder);
  const snapshot: ProviderSnapshot = { checkOrder: checkSnapshot, getState: null };
  if (!successFlag(checkOrder.Success)) {
    return {
      kind: "pending",
      paymentId: input.knownPaymentId ?? null,
      providerStatus: "INIT_UNKNOWN",
      errorCode: scalarText(checkOrder.ErrorCode, 80) || null,
      errorMessage:
        scalarText(checkOrder.Message ?? checkOrder.Details, 500) ||
        "T-Bank has not confirmed whether Init created a payment",
      snapshot,
    };
  }
  if (
    scalarText(checkOrder.TerminalKey, 80) !== provider.terminalKey ||
    scalarText(checkOrder.OrderId, 50) !== input.orderNumber
  ) {
    return {
      kind: "review",
      paymentId: input.knownPaymentId ?? null,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_check_order_mismatch",
      errorMessage: "T-Bank returned a mismatching terminal or merchant order id",
      snapshot,
    };
  }

  const parsedPayments = checkOrderPayments(checkOrder);
  const payments = parsedPayments.payments;
  if (parsedPayments.malformedRows > 0) {
    return {
      kind: "review",
      paymentId: input.knownPaymentId ?? payments[0]?.paymentId ?? null,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_malformed_payment_rows",
      errorMessage: "T-Bank returned malformed rows in the payment list",
      snapshot,
    };
  }
  if (parsedPayments.conflictingPaymentIds.length > 0) {
    return {
      kind: "review",
      paymentId:
        input.knownPaymentId ?? parsedPayments.conflictingPaymentIds[0] ?? null,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_duplicate_payment_conflict",
      errorMessage:
        "T-Bank returned conflicting rows for the same payment identifier",
      snapshot,
    };
  }
  if (payments.length > 1) {
    return {
      kind: "review",
      paymentId: input.knownPaymentId ?? null,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_payment_ambiguous",
      errorMessage: "T-Bank returned multiple payments for one merchant order",
      snapshot,
    };
  }
  const knownPayment = input.knownPaymentId
    ? payments.find((payment) => payment.paymentId === input.knownPaymentId) ?? null
    : null;
  if (input.knownPaymentId && payments.length > 0 && !knownPayment) {
    return {
      kind: "review",
      paymentId: input.knownPaymentId,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_payment_id_mismatch",
      errorMessage: "T-Bank returned a different payment for the stored merchant order",
      snapshot,
    };
  }
  const selected = input.knownPaymentId
    ? { payment: knownPayment, ambiguous: false }
    : choosePayment(payments, input.expectedAmount);
  if (selected.ambiguous) {
    return {
      kind: "review",
      paymentId: input.knownPaymentId ?? null,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_payment_ambiguous",
      errorMessage: "T-Bank returned multiple or amount-mismatching payments",
      snapshot,
    };
  }
  if (!selected.payment) {
    return {
      kind: "pending",
      paymentId: null,
      providerStatus: "INIT_UNKNOWN",
      errorCode: "tbank_payment_not_visible",
      errorMessage: "T-Bank has not exposed a payment for this order yet",
      snapshot,
    };
  }

  const payment = selected.payment;
  const checkOrderAmountMatches = payment.amount === input.expectedAmount;
  if (!checkOrderAmountMatches) {
    return {
      kind: "review",
      paymentId: payment.paymentId,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_check_order_amount_mismatch",
      errorMessage: "T-Bank CheckOrder payment amount did not match the order",
      snapshot,
    };
  }
  let getState: Record<string, unknown> | null = null;
  try {
    getState = await providerRequest(
      provider,
      "GetState",
      { TerminalKey: provider.terminalKey, PaymentId: payment.paymentId },
      fetchImpl,
    );
    snapshot.getState = safeProviderSnapshot(getState);
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    if (
      checkOrderAmountMatches &&
      terminalFailureStatuses.has(payment.status)
    ) {
      return {
        kind: "failed",
        paymentId: payment.paymentId,
        providerStatus: payment.status,
        errorCode: diagnostic.code,
        errorMessage: diagnostic.message,
        snapshot,
      };
    }
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: diagnostic.code,
      errorMessage: diagnostic.message,
      snapshot,
    };
  }

  const statePaymentId = scalarText(getState.PaymentId, 120);
  const stateOrderId = scalarText(getState.OrderId, 50);
  const stateTerminalKey = scalarText(getState.TerminalKey, 80);
  const stateAmount = integerOrNull(getState.Amount);
  const providerStatus = scalarText(getState.Status, 80).toUpperCase();
  if (!successFlag(getState.Success)) {
    if (
      checkOrderAmountMatches &&
      terminalFailureStatuses.has(payment.status)
    ) {
      return {
        kind: "failed",
        paymentId: payment.paymentId,
        providerStatus: payment.status,
        errorCode: scalarText(getState.ErrorCode, 80) || null,
        errorMessage:
          scalarText(getState.Message ?? getState.Details, 500) ||
          "T-Bank payment is terminally unavailable",
        snapshot,
      };
    }
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: scalarText(getState.ErrorCode, 80) || null,
      errorMessage:
        scalarText(getState.Message ?? getState.Details, 500) ||
        "T-Bank has not confirmed the payment state",
      snapshot,
    };
  }
  if (
    statePaymentId !== payment.paymentId ||
    stateOrderId !== input.orderNumber ||
    stateTerminalKey !== provider.terminalKey ||
    stateAmount !== input.expectedAmount
  ) {
    return {
      kind: "review",
      paymentId: payment.paymentId,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_get_state_mismatch",
      errorMessage: "T-Bank GetState did not match the stored payment boundary",
      snapshot,
    };
  }

  if (!providerStatus || providerStatus === "UNKNOWN") {
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: "tbank_get_state_status_missing",
      errorMessage: "T-Bank GetState did not return an explicit payment status",
      snapshot,
    };
  }

  if (providerStatus === "PARTIAL_REVERSED") {
    return {
      kind: "review",
      paymentId: payment.paymentId,
      providerStatus,
      errorCode: "tbank_partial_reversal_requires_review",
      errorMessage: "T-Bank reported a partial reversal; payment requires review",
      snapshot,
    };
  }

  if (terminalFailureStatuses.has(providerStatus)) {
    return {
      kind: "failed",
      paymentId: payment.paymentId,
      providerStatus,
      errorCode: scalarText(getState.ErrorCode, 80) || null,
      errorMessage:
        scalarText(getState.Message ?? getState.Details, 500) ||
        "T-Bank payment is terminally unavailable",
      snapshot,
    };
  }
  if (financiallyProcessedStatuses.has(providerStatus)) {
    return {
      kind: "processed",
      paymentId: payment.paymentId,
      providerStatus,
      snapshot,
    };
  }

  // CheckOrder/GetState do not return the opaque payment-form URL. A payment
  // confirmed as NEW cannot be resumed safely, so cancel that exact PaymentId
  // before permitting a fresh merchant order. Never repeat Init with OrderId.
  if (providerStatus !== "NEW") {
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: "tbank_payment_in_progress",
      errorMessage: `T-Bank payment is still in status ${providerStatus}`,
      snapshot,
    };
  }

  if (!input.beforeCancel) {
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: "tbank_cancel_intent_required",
      errorMessage:
        "T-Bank cancellation requires a durable local intent before the provider request",
      snapshot,
    };
  }
  const cancelIntentAcquired = await input.beforeCancel({
    orderNumber: input.orderNumber,
    expectedAmount: input.expectedAmount,
    paymentId: payment.paymentId,
  });
  if (!cancelIntentAcquired) {
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: "tbank_cancel_intent_not_acquired",
      errorMessage:
        "T-Bank cancellation was skipped because the reconciliation lease or payment boundary changed",
      snapshot,
    };
  }

  let cancel: Record<string, unknown>;
  snapshot.cancel = { attempted: true, response: null };
  try {
    cancel = await providerRequest(
      provider,
      "Cancel",
      {
        TerminalKey: provider.terminalKey,
        PaymentId: payment.paymentId,
        ExternalRequestId: `komui-init-${input.orderNumber}-${payment.paymentId}`.slice(
          0,
          100,
        ),
      },
      fetchImpl,
    );
    snapshot.cancel = {
      attempted: true,
      response: safeProviderSnapshot(cancel),
    };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: diagnostic.code,
      errorMessage: diagnostic.message,
      snapshot,
    };
  }

  const cancelStatus = scalarText(cancel.Status, 80) || "UNKNOWN";
  const cancelPaymentId = scalarText(cancel.PaymentId, 120);
  const cancelOrderId = scalarText(cancel.OrderId, 50);
  const cancelTerminalKey = scalarText(cancel.TerminalKey, 80);
  const cancelOriginalAmount = integerOrNull(cancel.OriginalAmount);
  const cancelNewAmount = integerOrNull(cancel.NewAmount);
  if (!successFlag(cancel.Success)) {
    return {
      kind: "pending",
      paymentId: payment.paymentId,
      providerStatus: "INIT_UNKNOWN",
      errorCode: scalarText(cancel.ErrorCode, 80) || null,
      errorMessage:
        scalarText(cancel.Message ?? cancel.Details, 500) ||
        "T-Bank has not confirmed cancellation of the orphaned payment",
      snapshot,
    };
  }
  if (
    cancelPaymentId !== payment.paymentId ||
    cancelOrderId !== input.orderNumber ||
    cancelTerminalKey !== provider.terminalKey ||
    cancelOriginalAmount !== input.expectedAmount ||
    cancelNewAmount !== 0
  ) {
    return {
      kind: "review",
      paymentId: payment.paymentId,
      providerStatus: "INIT_REVIEW",
      errorCode: "tbank_cancel_mismatch",
      errorMessage: "T-Bank Cancel did not match the stored payment boundary",
      snapshot,
    };
  }
  if (terminalFailureStatuses.has(cancelStatus)) {
    return {
      kind: "failed",
      paymentId: payment.paymentId,
      providerStatus: cancelStatus,
      errorCode: scalarText(cancel.ErrorCode, 80) || null,
      errorMessage: "Orphaned T-Bank payment was canceled before retry",
      snapshot,
    };
  }
  if (financiallyProcessedStatuses.has(cancelStatus)) {
    return {
      kind: "processed",
      paymentId: payment.paymentId,
      providerStatus: cancelStatus,
      snapshot,
    };
  }
  return {
    kind: "pending",
    paymentId: payment.paymentId,
    providerStatus: "INIT_UNKNOWN",
    errorCode: "tbank_cancel_pending",
    errorMessage: `T-Bank cancellation is still in status ${cancelStatus}`,
    snapshot,
  };
}

async function claimTbankInitAttempts(
  db: Db,
  options: {
    orderId?: string;
    limit: number;
    staleMs: number;
    leaseMs: number;
    terminalKey: string;
  },
): Promise<ClaimedAttempt[]> {
  return db.withTransaction(async (client) => {
    const result = await client.query<ClaimedAttempt>(
      `
        select
          a.id,
          a.order_id,
          o.order_number,
          a.amount,
          o.total_amount as order_total_amount,
          a.terminal_key,
          a.external_payment_id,
          a.reconciliation_attempts
        from public.merch_payment_attempts a
        join public.merch_customer_orders o on o.id = a.order_id
        where a.provider = 'tbank'
          and ($1::uuid is null or o.id = $1::uuid)
          and (
            (
              a.provider_status = 'INITIATING'
              and a.created_at <= now() - ($3::double precision * interval '1 millisecond')
            )
            or (
              a.provider_status = 'INIT_UNKNOWN'
              and (a.reconciliation_next_at is null or a.reconciliation_next_at <= now())
            )
            or (
              a.provider_status = 'RECONCILING_INIT'
              and a.updated_at <= now() - ($4::double precision * interval '1 millisecond')
            )
            or (
              a.provider_status in (
                'NEW',
                'FORM_SHOWED',
                'AUTHORIZING',
                '3DS_CHECKING',
                '3DS_CHECKED',
                'AUTH_FAIL',
                'CONFIRMING',
                'REVERSING',
                'REFUNDING'
              )
              and a.payment_url is null
              and a.updated_at <= now() - ($3::double precision * interval '1 millisecond')
            )
          )
          and o.status in ('created', 'pending_payment', 'payment_unknown')
        order by a.updated_at asc, a.id asc
        limit $2
        for update of a, o skip locked
      `,
      [options.orderId ?? null, options.limit, options.staleMs, options.leaseMs],
    );

    const claimed: ClaimedAttempt[] = [];
    for (const attempt of result.rows) {
      const boundaryError = claimedReconciliationBoundaryError(
        attempt,
        options.terminalKey,
      );
      if (boundaryError) {
        await client.query(
          `
            update public.merch_payment_attempts
            set provider_status = 'INIT_REVIEW',
                error_code = $2,
                error_message = $3,
                response_payload = response_payload || $4::jsonb,
                reconciliation_next_at = null
            where id = $1
          `,
          [
            attempt.id,
            boundaryError.errorCode,
            boundaryError.errorMessage,
            JSON.stringify({
              reconciliation_boundary_rejected: boundaryError.audit,
            }),
          ],
        );
        await client.query(
          `
            update public.merch_customer_orders
            set status = 'payment_review',
                metadata = metadata || $2::jsonb
            where id = $1::uuid
              and status in ('created', 'pending_payment', 'payment_unknown')
          `,
          [
            attempt.order_id,
            JSON.stringify({
              payment_review_reason: boundaryError.errorCode,
              ...boundaryError.audit,
            }),
          ],
        );
        continue;
      }
      await client.query(
        `
          update public.merch_payment_attempts
          set provider_status = 'RECONCILING_INIT',
              reconciliation_attempts = reconciliation_attempts + 1,
              reconciliation_next_at = null,
              error_code = null,
              error_message = null
          where id = $1
        `,
        [attempt.id],
      );
      await client.query(
        `
          update public.merch_customer_orders
          set status = 'payment_unknown'
          where id = $1::uuid
            and status = 'created'
        `,
        [attempt.order_id],
      );
      attempt.reconciliation_attempts = Number(attempt.reconciliation_attempts) + 1;
      claimed.push(attempt);
    }
    return claimed;
  });
}

function snapshotJson(result: TbankInitReconciliationResult): string {
  const cancelAttempted = result.snapshot?.cancel?.attempted === true;
  return JSON.stringify({
    ...(cancelAttempted ? { tbank_cancel_attempted: true } : {}),
    reconciliation: {
      checked_at: new Date().toISOString(),
      kind: result.kind,
      snapshot: result.snapshot,
    },
  });
}

async function quarantineTbankReconciliation(
  client: PoolClient,
  attempt: ClaimedAttempt,
  locked: LockedReconciliationAttempt,
  review: Extract<TbankInitReconciliationResult, { kind: "review" }>,
  options: {
    reason:
      | "amount_mismatch"
      | "payment_identity_conflict"
      | "payment_state_conflict";
    audit: Record<string, unknown>;
    includeRefundedOrder?: boolean;
  },
): Promise<TbankInitReconciliationResult> {
  await client.query(
    `
      update public.merch_payment_attempts
      set provider_status = 'INIT_REVIEW',
          payment_url = null,
          error_code = $2,
          error_message = $3,
          response_payload = coalesce(response_payload, '{}'::jsonb) || $4::jsonb,
          reconciliation_next_at = null
      where id = $1
    `,
    [
      attempt.id,
      review.errorCode,
      review.errorMessage,
      JSON.stringify({
        ...JSON.parse(snapshotJson(review)),
        reconciliation_quarantine: options.audit,
      }),
    ],
  );
  const updatedOrder = await client.query<{ status: string }>(
    `
      update public.merch_customer_orders
      set status = case
            when status in (
              'created',
              'pending_payment',
              'payment_unknown',
              'authorized',
              'paid',
              'partially_refunded',
              'payment_failed',
              'canceled'
            ) or ($3::boolean and status = 'refunded')
              then 'payment_review'
            else status
          end,
          metadata = metadata || $2::jsonb
      where id = $1::uuid
      returning status
    `,
    [
      attempt.order_id,
      JSON.stringify({
        payment_review_reason: options.reason,
        payment_review_code: review.errorCode,
        ...options.audit,
      }),
      options.includeRefundedOrder === true,
    ],
  );
  const resultingOrderStatus =
    updatedOrder.rows[0]?.status ?? locked.order_status;
  if (
    resultingOrderStatus === "payment_review" &&
    (options.reason === "payment_state_conflict" ||
      ["authorized", "paid", "partially_refunded"].includes(
      locked.order_status,
    ) ||
      (options.includeRefundedOrder === true &&
        locked.order_status === "refunded"))
  ) {
    await enqueueCdekEffect(client, "cdek_cancel", attempt.order_id, {
      source: "tbank_init_reconciliation",
      reason: options.reason,
      error_code: review.errorCode,
      stored_payment_id: locked.external_payment_id,
      resolved_payment_id: review.paymentId,
      ...(options.reason === "payment_state_conflict"
        ? {
            cancel_provider_status:
              options.audit.cancel_provider_status ?? null,
            concurrent_attempt_status:
              options.audit.concurrent_attempt_status ?? null,
            concurrent_order_status:
              options.audit.concurrent_order_status ?? null,
          }
        : {}),
    });
  }
  return review;
}

async function persistReconciliationResult(
  db: Db,
  attempt: ClaimedAttempt,
  result: TbankInitReconciliationResult,
  expectedTerminalKey: string,
  intervalMs: number,
  maxAttempts: number,
  createCdekShipments: boolean,
): Promise<PersistedTbankInitReconciliation> {
  return db.withTransaction(async (client) => {
    const lockedResult = await client.query<LockedReconciliationAttempt>(
      `
        select
          a.provider_status as attempt_status,
          o.status as order_status,
          a.external_payment_id,
          a.reconciliation_attempts,
          a.amount as attempt_amount,
          o.total_amount as order_total_amount,
          a.terminal_key,
          a.response_payload
        from public.merch_payment_attempts a
        join public.merch_customer_orders o on o.id = a.order_id
        where a.id = $1
          and o.id = $2::uuid
        for update of a, o
      `,
      [attempt.id, attempt.order_id],
    );
    const locked = lockedResult.rows[0];
    if (!locked) {
      return {
        kind: "superseded",
        paymentId: attempt.external_payment_id,
        providerStatus: "UNKNOWN",
        orderStatus: "unknown",
      };
    }
    const leaseMatches =
      Number(locked.reconciliation_attempts) === attempt.reconciliation_attempts;
    const cancelAttempted = result.snapshot?.cancel?.attempted === true;
    // Ordinary observations from an old generation are stale. An already-sent
    // Cancel is different: its external side effect must be recorded under the
    // current lock before the old worker yields to the newer lease.
    if (!leaseMatches && !cancelAttempted) {
      return {
        kind: "superseded",
        paymentId: locked.external_payment_id,
        providerStatus: locked.attempt_status,
        orderStatus: locked.order_status,
      };
    }

    const lockedAttemptAmount = Number(locked.attempt_amount);
    const lockedOrderAmount = Number(locked.order_total_amount);
    const claimedAttemptAmount = Number(attempt.amount);
    const claimedOrderAmount = Number(attempt.order_total_amount);
    const amountBoundaryMatches =
      validMoneyAmount(lockedAttemptAmount) &&
      validMoneyAmount(lockedOrderAmount) &&
      validMoneyAmount(claimedAttemptAmount) &&
      validMoneyAmount(claimedOrderAmount) &&
      lockedAttemptAmount === lockedOrderAmount &&
      lockedAttemptAmount === claimedAttemptAmount &&
      lockedOrderAmount === claimedOrderAmount;
    const terminalBoundaryMatches =
      Boolean(locked.terminal_key) &&
      locked.terminal_key === expectedTerminalKey &&
      locked.terminal_key === attempt.terminal_key;
    if (!amountBoundaryMatches || !terminalBoundaryMatches) {
      const boundaryError: ReconciliationBoundaryError = amountBoundaryMatches
        ? {
            errorCode: "tbank_terminal_boundary_mismatch",
            errorMessage:
              "Stored payment terminal changed or does not match the active T-Bank terminal",
            audit: {
              claimed_terminal_key: attempt.terminal_key || null,
              locked_terminal_key: locked.terminal_key || null,
              configured_terminal_key: expectedTerminalKey,
            },
          }
        : {
            errorCode: "tbank_local_amount_boundary_mismatch",
            errorMessage:
              "Stored payment amount changed or does not match the locked order total",
            audit: {
              claimed_attempt_amount: attempt.amount,
              claimed_order_total_amount: attempt.order_total_amount,
              locked_attempt_amount: locked.attempt_amount,
              locked_order_total_amount: locked.order_total_amount,
            },
          };
      const boundaryReview: TbankInitReconciliationResult = {
        kind: "review",
        paymentId: locked.external_payment_id ?? result.paymentId,
        providerStatus: "INIT_REVIEW",
        errorCode: boundaryError.errorCode,
        errorMessage: boundaryError.errorMessage,
        snapshot: result.snapshot,
      };
      return quarantineTbankReconciliation(
        client,
        attempt,
        locked,
        boundaryReview,
        {
          reason: amountBoundaryMatches
            ? "payment_identity_conflict"
            : "amount_mismatch",
          audit: {
            boundary_error_code: boundaryError.errorCode,
            ...boundaryError.audit,
          },
        },
      );
    }

    let conflictingOwner:
      | Awaited<ReturnType<typeof findOtherTbankPaymentIdentityOwner>>
      | null = null;
    if (result.paymentId && !locked.external_payment_id) {
      await lockTbankPaymentIdentity(client, result.paymentId);
      conflictingOwner = await findOtherTbankPaymentIdentityOwner(
        client,
        result.paymentId,
        attempt.id,
      );
    }
    if (
      (locked.external_payment_id &&
        result.paymentId &&
        locked.external_payment_id !== result.paymentId) ||
      conflictingOwner
    ) {
      const conflictResult: TbankInitReconciliationResult = {
        kind: "review",
        paymentId: locked.external_payment_id ?? result.paymentId,
        providerStatus: "INIT_REVIEW",
        errorCode: "tbank_reconciliation_payment_id_conflict",
        errorMessage:
          "T-Bank reconciliation resolved a different payment than the concurrent Init response",
        snapshot: result.snapshot,
      };
      return quarantineTbankReconciliation(
        client,
        attempt,
        locked,
        conflictResult,
        {
          reason: "payment_identity_conflict",
          includeRefundedOrder: true,
          audit: {
            stored_payment_id: locked.external_payment_id,
            resolved_payment_id: result.paymentId,
            conflicting_attempt_id: conflictingOwner?.id ?? null,
            conflicting_order_id: conflictingOwner?.order_id ?? null,
          },
        },
      );
    }

    if (cancelAttempted) {
      await client.query(
        `
          update public.merch_payment_attempts
          set payment_url = null,
              response_payload = coalesce(response_payload, '{}'::jsonb) || $2::jsonb
          where id = $1
        `,
        [attempt.id, snapshotJson(result)],
      );

      const concurrentFulfillment = [
        "authorized",
        "paid",
        "partially_refunded",
      ].includes(locked.order_status);
      if (
        concurrentFulfillment &&
        (!leaseMatches || result.providerStatus !== "REFUNDED")
      ) {
        const stateConflict: TbankInitReconciliationResult = {
          kind: "review",
          paymentId: locked.external_payment_id ?? result.paymentId,
          providerStatus: "INIT_REVIEW",
          errorCode: "tbank_cancel_payment_state_conflict",
          errorMessage:
            "T-Bank Cancel raced with a concurrent fulfillable payment state",
          snapshot: result.snapshot,
        };
        return quarantineTbankReconciliation(
          client,
          attempt,
          locked,
          stateConflict,
          {
            reason: "payment_state_conflict",
            audit: {
              stored_payment_id: locked.external_payment_id,
              resolved_payment_id: result.paymentId,
              claimed_reconciliation_attempts: attempt.reconciliation_attempts,
              locked_reconciliation_attempts: locked.reconciliation_attempts,
              concurrent_attempt_status: locked.attempt_status,
              concurrent_order_status: locked.order_status,
              cancel_result_kind: result.kind,
              cancel_provider_status: result.providerStatus,
            },
          },
        );
      }
    }

    const cancellationBoundaryActive =
      cancelAttempted ||
      locked.response_payload?.tbank_cancel_attempted === true;
    const incomingFulfillment =
      result.kind === "processed" &&
      ["AUTHORIZED", "CONFIRMED", "PARTIAL_REFUNDED"].includes(
        result.providerStatus,
      );
    if (leaseMatches && cancellationBoundaryActive && incomingFulfillment) {
      const stateConflict: TbankInitReconciliationResult = {
        kind: "review",
        paymentId: locked.external_payment_id ?? result.paymentId,
        providerStatus: "INIT_REVIEW",
        errorCode: "tbank_cancel_payment_state_conflict",
        errorMessage:
          "A fulfillable T-Bank state arrived after cancellation was attempted",
        snapshot: result.snapshot,
      };
      return quarantineTbankReconciliation(
        client,
        attempt,
        locked,
        stateConflict,
        {
          reason: "payment_state_conflict",
          audit: {
            stored_payment_id: locked.external_payment_id,
            resolved_payment_id: result.paymentId,
            claimed_reconciliation_attempts: attempt.reconciliation_attempts,
            locked_reconciliation_attempts: locked.reconciliation_attempts,
            concurrent_attempt_status: locked.attempt_status,
            concurrent_order_status: locked.order_status,
            cancel_result_kind: result.kind,
            cancel_provider_status: result.providerStatus,
          },
        },
      );
    }

    if (!leaseMatches) {
      return {
        kind: "superseded",
        paymentId: locked.external_payment_id,
        providerStatus: locked.attempt_status,
        orderStatus: locked.order_status,
      };
    }

    const isCausalPartialReversalReview =
      result.kind === "review" && result.providerStatus === "PARTIAL_REVERSED";
    if (result.kind === "review" && !isCausalPartialReversalReview) {
      const amountConflict = result.errorCode.toLowerCase().includes("amount");
      return quarantineTbankReconciliation(client, attempt, locked, result, {
        reason: amountConflict ? "amount_mismatch" : "payment_identity_conflict",
        includeRefundedOrder: !amountConflict,
        audit: {
          reconciliation_error_code: result.errorCode,
          stored_payment_id: locked.external_payment_id,
          resolved_payment_id: result.paymentId,
        },
      });
    }

    if (locked.attempt_status !== "RECONCILING_INIT") {
      if (result.kind === "pending") {
        return {
          kind: "superseded",
          paymentId: locked.external_payment_id,
          providerStatus: locked.attempt_status,
          orderStatus: locked.order_status,
        };
      }
      const canApplyConcurrentProviderFact = shouldApplyTbankProviderStatus(
        locked.attempt_status,
        result.providerStatus,
      );
      if (
        !canApplyConcurrentProviderFact &&
        locked.attempt_status !== result.providerStatus
      ) {
        return {
          kind: "superseded",
          paymentId: locked.external_payment_id,
          providerStatus: locked.attempt_status,
          orderStatus: locked.order_status,
        };
      }
    }

    if (
      result.kind === "processed" ||
      result.kind === "failed" ||
      isCausalPartialReversalReview
    ) {
      const providerStatusApplied = shouldApplyTbankProviderStatus(
        locked.attempt_status,
        result.providerStatus,
      );
      // Keep the order projection causally tied to the locked provider state.
      // The equality branch supports healing an incomplete legacy write;
      // lower-rank provider observations cannot mutate the order.
      const canProjectProviderStatus =
        providerStatusApplied ||
        locked.attempt_status === result.providerStatus;
      const mappedOrderStatus = canProjectProviderStatus
        ? tbankOrderStatusForCurrentOrder(
            locked.order_status,
            result.providerStatus,
          )
        : null;
      await client.query(
        `
          update public.merch_payment_attempts
          set external_payment_id = coalesce(external_payment_id, $2),
              provider_status = case when $3::boolean then $4 else provider_status end,
              error_code = $5,
              error_message = $6,
              response_payload = response_payload || $7::jsonb,
              reconciliation_next_at = null,
              confirmed_at = case
                when $3::boolean and $4 = 'CONFIRMED'
                  then coalesce(confirmed_at, now())
                else confirmed_at
              end
          where id = $1
        `,
        [
          attempt.id,
          result.paymentId,
          providerStatusApplied,
          result.providerStatus,
          result.kind === "processed" ? null : result.errorCode,
          result.kind === "processed" ? null : result.errorMessage,
          snapshotJson(result),
        ],
      );

      const shouldApplyOrderStatus = Boolean(
        mappedOrderStatus &&
          canApplyTbankOrderProjection(locked.order_status, mappedOrderStatus, {
            providerStatus: result.providerStatus,
            amountMismatch: false,
          }),
      );
      if (shouldApplyOrderStatus && mappedOrderStatus) {
        const updatedOrder = await client.query<{ id: string }>(
          `
            update public.merch_customer_orders
            set status = $2,
                paid_at = case
                  when $2 = 'paid' then coalesce(paid_at, now())
                  else paid_at
                end,
                metadata = case
                  when $2 = 'payment_review' then metadata || $4::jsonb
                  else metadata
                end
            where id = $1::uuid
              and status = $3
            returning id
          `,
          [
            attempt.order_id,
            mappedOrderStatus,
            locked.order_status,
            JSON.stringify(
              mappedOrderStatus === "payment_review"
                ? {
                    payment_review_reason:
                      result.providerStatus === "PARTIAL_REVERSED"
                        ? "partial_reversed"
                        : "partial_refund_without_confirmed_payment",
                    provider_status: result.providerStatus,
                    payment_id: result.paymentId,
                  }
                : {},
            ),
          ],
        );
        if (updatedOrder.rows[0]) {
          if (mappedOrderStatus === "paid") {
            await markPromoRedemptionRedeemed(client, attempt.order_id);
            await enqueueOrderPaidEmail(client, attempt.order_id, {
              source: "tbank_init_reconciliation",
              provider_status: result.providerStatus,
              payment_id: result.paymentId,
            });
            if (createCdekShipments) {
              await enqueueCdekEffect(client, "cdek_create", attempt.order_id, {
                source: "tbank_init_reconciliation",
                providerStatus: result.providerStatus,
                paymentId: result.paymentId,
              });
            }
          } else if (mappedOrderStatus === "payment_failed") {
            await releasePromoRedemption(client, attempt.order_id);
            if (result.providerStatus === "REVERSED") {
              await enqueueCdekEffect(client, "cdek_cancel", attempt.order_id, {
                source: "tbank_init_reconciliation",
                providerStatus: result.providerStatus,
                paymentId: result.paymentId,
              });
            }
          } else if (mappedOrderStatus === "refunded") {
            await releasePromoRedemption(client, attempt.order_id, "canceled");
            await enqueueCdekEffect(client, "cdek_cancel", attempt.order_id, {
              source: "tbank_init_reconciliation",
              providerStatus: result.providerStatus,
              paymentId: result.paymentId,
            });
          } else if (
            mappedOrderStatus === "payment_review" &&
            result.providerStatus === "PARTIAL_REVERSED"
          ) {
            await enqueueCdekEffect(client, "cdek_cancel", attempt.order_id, {
              source: "tbank_init_reconciliation",
              providerStatus: result.providerStatus,
              paymentId: result.paymentId,
              reason: "partial_reversed",
            });
          }
        }
      } else if (!mappedOrderStatus && result.kind === "processed") {
        await client.query(
          `
            update public.merch_customer_orders
            set status = 'payment_review',
                metadata = metadata || $2::jsonb
            where id = $1::uuid
              and status in ('created', 'payment_unknown')
          `,
          [
            attempt.order_id,
            JSON.stringify({
              payment_review_reason: "unmapped_reconciliation_status",
              provider_status: result.providerStatus,
            }),
          ],
        );
      }
      return result;
    }

    const exhausted =
      result.kind === "review" || attempt.reconciliation_attempts >= maxAttempts;
    const errorCode = exhausted
      ? result.kind === "review"
        ? result.errorCode
        : "tbank_reconciliation_exhausted"
      : result.errorCode;
    const errorMessage = exhausted
      ? result.kind === "review"
        ? result.errorMessage
        : "Automatic T-Bank Init reconciliation needs operator review"
      : result.errorMessage;
    const retryDelayMs = Math.min(
      15 * 60_000,
      intervalMs * 2 ** Math.min(5, Math.max(0, attempt.reconciliation_attempts - 1)),
    );
    await client.query(
      `
        update public.merch_payment_attempts
        set external_payment_id = coalesce(external_payment_id, $2),
            provider_status = $3,
            error_code = $4,
            error_message = $5,
            response_payload = response_payload || $6::jsonb,
            reconciliation_next_at = case
              when $7::boolean then null
              else now() + ($8::double precision * interval '1 millisecond')
            end
        where id = $1
          and provider_status = 'RECONCILING_INIT'
      `,
      [
        attempt.id,
        result.paymentId,
        exhausted ? "INIT_REVIEW" : "INIT_UNKNOWN",
        errorCode,
        errorMessage,
        snapshotJson(result),
        exhausted,
        retryDelayMs,
      ],
    );
    await client.query(
      `
        update public.merch_customer_orders
        set status = $2
        where id = $1::uuid
          and status in ('created', 'pending_payment', 'payment_unknown')
      `,
      [attempt.order_id, exhausted ? "payment_review" : "payment_unknown"],
    );
    return exhausted && result.kind === "pending"
      ? {
          ...result,
          kind: "review",
          providerStatus: "INIT_REVIEW",
          errorCode: errorCode || "tbank_reconciliation_exhausted",
          errorMessage,
        }
      : result;
  });
}

type TbankCancelIntentResult =
  | { acquired: true }
  | {
      acquired: false;
      outcome: PersistedTbankInitReconciliation;
    };

async function acquireTbankCancelIntent(
  db: Db,
  attempt: ClaimedAttempt,
  candidate: TbankCancelCandidate,
  expectedTerminalKey: string,
): Promise<TbankCancelIntentResult> {
  return db.withTransaction(async (client) => {
    const lockedResult = await client.query<
      LockedReconciliationAttempt & { order_number: string }
    >(
      `
        /* tbank_cancel_intent:lock */
        select
          a.provider_status as attempt_status,
          o.status as order_status,
          o.order_number,
          a.external_payment_id,
          a.reconciliation_attempts,
          a.amount as attempt_amount,
          o.total_amount as order_total_amount,
          a.terminal_key,
          a.response_payload
        from public.merch_payment_attempts a
        join public.merch_customer_orders o on o.id = a.order_id
        where a.id = $1
          and a.order_id = $2::uuid
          and o.id = $2::uuid
        for update of a, o
      `,
      [attempt.id, attempt.order_id],
    );
    const locked = lockedResult.rows[0];
    if (!locked) {
      return {
        acquired: false,
        outcome: {
          kind: "superseded",
          paymentId: attempt.external_payment_id,
          providerStatus: "UNKNOWN",
          orderStatus: "unknown",
        },
      };
    }

    const lockedAttemptAmount = Number(locked.attempt_amount);
    const lockedOrderAmount = Number(locked.order_total_amount);
    const claimedAttemptAmount = Number(attempt.amount);
    const claimedOrderAmount = Number(attempt.order_total_amount);
    const amountBoundaryMatches =
      validMoneyAmount(candidate.expectedAmount) &&
      validMoneyAmount(lockedAttemptAmount) &&
      validMoneyAmount(lockedOrderAmount) &&
      validMoneyAmount(claimedAttemptAmount) &&
      validMoneyAmount(claimedOrderAmount) &&
      candidate.expectedAmount === claimedAttemptAmount &&
      lockedAttemptAmount === lockedOrderAmount &&
      lockedAttemptAmount === claimedAttemptAmount &&
      lockedOrderAmount === claimedOrderAmount;
    const terminalBoundaryMatches =
      Boolean(locked.terminal_key) &&
      locked.terminal_key === expectedTerminalKey &&
      locked.terminal_key === attempt.terminal_key;
    const orderBoundaryMatches =
      candidate.orderNumber === attempt.order_number &&
      locked.order_number === attempt.order_number;
    if (
      !amountBoundaryMatches ||
      !terminalBoundaryMatches ||
      !orderBoundaryMatches
    ) {
      const amountConflict = !amountBoundaryMatches;
      const boundaryReview: Extract<
        TbankInitReconciliationResult,
        { kind: "review" }
      > = {
        kind: "review",
        paymentId: locked.external_payment_id ?? candidate.paymentId,
        providerStatus: "INIT_REVIEW",
        errorCode: amountConflict
          ? "tbank_local_amount_boundary_mismatch"
          : "tbank_terminal_boundary_mismatch",
        errorMessage: amountConflict
          ? "Stored payment amount changed before T-Bank cancellation"
          : "Stored payment identity changed before T-Bank cancellation",
        snapshot: null,
      };
      const outcome = await quarantineTbankReconciliation(
        client,
        attempt,
        locked,
        boundaryReview,
        {
          reason: amountConflict
            ? "amount_mismatch"
            : "payment_identity_conflict",
          includeRefundedOrder: !amountConflict,
          audit: {
            cancel_intent_rejected: true,
            claimed_order_number: attempt.order_number,
            locked_order_number: locked.order_number,
            claimed_attempt_amount: attempt.amount,
            claimed_order_total_amount: attempt.order_total_amount,
            locked_attempt_amount: locked.attempt_amount,
            locked_order_total_amount: locked.order_total_amount,
            claimed_terminal_key: attempt.terminal_key || null,
            locked_terminal_key: locked.terminal_key || null,
            configured_terminal_key: expectedTerminalKey,
          },
        },
      );
      return { acquired: false, outcome };
    }

    let conflictingOwner:
      | Awaited<ReturnType<typeof findOtherTbankPaymentIdentityOwner>>
      | null = null;
    await lockTbankPaymentIdentity(client, candidate.paymentId);
    conflictingOwner = await findOtherTbankPaymentIdentityOwner(
      client,
      candidate.paymentId,
      attempt.id,
    );
    const paymentIdentityMatches =
      (!attempt.external_payment_id ||
        attempt.external_payment_id === candidate.paymentId) &&
      (!locked.external_payment_id ||
        locked.external_payment_id === candidate.paymentId) &&
      !conflictingOwner;
    if (!paymentIdentityMatches) {
      const identityReview: Extract<
        TbankInitReconciliationResult,
        { kind: "review" }
      > = {
        kind: "review",
        paymentId: locked.external_payment_id ?? candidate.paymentId,
        providerStatus: "INIT_REVIEW",
        errorCode: "tbank_reconciliation_payment_id_conflict",
        errorMessage:
          "T-Bank payment identity changed before cancellation could be attempted",
        snapshot: null,
      };
      const outcome = await quarantineTbankReconciliation(
        client,
        attempt,
        locked,
        identityReview,
        {
          reason: "payment_identity_conflict",
          includeRefundedOrder: true,
          audit: {
            cancel_intent_rejected: true,
            claimed_payment_id: attempt.external_payment_id,
            locked_payment_id: locked.external_payment_id,
            resolved_payment_id: candidate.paymentId,
            conflicting_attempt_id: conflictingOwner?.id ?? null,
            conflicting_order_id: conflictingOwner?.order_id ?? null,
          },
        },
      );
      return { acquired: false, outcome };
    }

    const leaseMatches =
      Number(locked.reconciliation_attempts) === attempt.reconciliation_attempts;
    const safeAttemptState = locked.attempt_status === "RECONCILING_INIT";
    const safeOrderState = [
      "created",
      "pending_payment",
      "payment_unknown",
    ].includes(locked.order_status);
    if (!leaseMatches || !safeAttemptState || !safeOrderState) {
      return {
        acquired: false,
        outcome: {
          kind: "superseded",
          paymentId: locked.external_payment_id,
          providerStatus: locked.attempt_status,
          orderStatus: locked.order_status,
        },
      };
    }

    const marker = {
      tbank_cancel_attempted: true,
      tbank_cancel_intent: {
        prepared_at: new Date().toISOString(),
        reconciliation_attempts: attempt.reconciliation_attempts,
        payment_id: candidate.paymentId,
        order_number: candidate.orderNumber,
        expected_amount: candidate.expectedAmount,
        terminal_key: expectedTerminalKey,
      },
    };
    const updated = await client.query<{ id: number }>(
      `
        /* tbank_cancel_intent:acquire */
        update public.merch_payment_attempts
        set external_payment_id = coalesce(external_payment_id, $2),
            payment_url = null,
            response_payload = coalesce(response_payload, '{}'::jsonb) || $4::jsonb
        where id = $1
          and provider_status = 'RECONCILING_INIT'
          and reconciliation_attempts = $3
          and (external_payment_id is null or external_payment_id = $2)
        returning id
      `,
      [
        attempt.id,
        candidate.paymentId,
        attempt.reconciliation_attempts,
        JSON.stringify(marker),
      ],
    );
    if (!updated.rows[0]) {
      return {
        acquired: false,
        outcome: {
          kind: "superseded",
          paymentId: locked.external_payment_id,
          providerStatus: locked.attempt_status,
          orderStatus: locked.order_status,
        },
      };
    }
    return { acquired: true };
  });
}

async function reconcileClaimedAttempt(
  db: Db,
  provider: TbankProviderConfig,
  attempt: ClaimedAttempt,
  options: {
    intervalMs: number;
    maxAttempts: number;
    createCdekShipments?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<ReconciledTbankInit> {
  const cancelIntentState: {
    outcome: PersistedTbankInitReconciliation | null;
  } = { outcome: null };
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: attempt.order_number,
      expectedAmount: Number(attempt.amount),
      knownPaymentId: attempt.external_payment_id,
      beforeCancel: async (candidate) => {
        const intent = await acquireTbankCancelIntent(
          db,
          attempt,
          candidate,
          provider.terminalKey,
        );
        if (!intent.acquired) {
          cancelIntentState.outcome = intent.outcome;
          return false;
        }
        return true;
      },
    },
    options.fetchImpl,
  );
  const cancelIntentOutcome = cancelIntentState.outcome;
  if (cancelIntentOutcome !== null) {
    return {
      ...cancelIntentOutcome,
      orderId: attempt.order_id,
      orderNumber: attempt.order_number,
    };
  }
  const persisted = await persistReconciliationResult(
    db,
    attempt,
    result,
    provider.terminalKey,
    options.intervalMs,
    options.maxAttempts,
    options.createCdekShipments !== false,
  );
  return {
    ...persisted,
    orderId: attempt.order_id,
    orderNumber: attempt.order_number,
  };
}

export async function reconcileTbankInitForOrder(
  db: Db,
  provider: TbankProviderConfig,
  orderId: string,
  options: {
    staleMs: number;
    leaseMs: number;
    intervalMs: number;
    maxAttempts: number;
    createCdekShipments?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<ReconciledTbankInit | null> {
  const claimed = await claimTbankInitAttempts(db, {
    orderId,
    limit: 1,
    staleMs: options.staleMs,
    leaseMs: options.leaseMs,
    terminalKey: provider.terminalKey,
  });
  if (!claimed[0]) return null;
  return reconcileClaimedAttempt(db, provider, claimed[0], options);
}

export async function reconcilePendingTbankInits(
  db: Db,
  provider: TbankProviderConfig,
  options: {
    limit: number;
    staleMs: number;
    leaseMs: number;
    intervalMs: number;
    maxAttempts: number;
    createCdekShipments?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<ReconciledTbankInit[]> {
  const claimed = await claimTbankInitAttempts(db, {
    limit: options.limit,
    staleMs: options.staleMs,
    leaseMs: options.leaseMs,
    terminalKey: provider.terminalKey,
  });
  return Promise.all(
    claimed.map((attempt) =>
      reconcileClaimedAttempt(db, provider, attempt, options),
    ),
  );
}

export async function markTbankInitUnknown(
  db: Db,
  input: {
    orderId: string;
    attemptId: number;
    errorCode: string | null;
    errorMessage: string;
    retryAtMs: number;
    requestPayload?: Record<string, unknown>;
    responsePayload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.withTransaction(async (client) => {
    const markedAttempt = await client.query<{ id: number }>(
      `
        update public.merch_payment_attempts
        set provider_status = 'INIT_UNKNOWN',
            error_code = $2,
            error_message = $3,
            request_payload = case
              when $4::jsonb is null then request_payload
              else $4::jsonb
            end,
            response_payload = case
              when $5::jsonb is null then response_payload
              else response_payload || $5::jsonb
            end,
            reconciliation_next_at = now() + ($6::double precision * interval '1 millisecond')
        where id = $1
          and order_id = $7::uuid
          and provider_status in ('INITIATING', 'RECONCILING_INIT', 'INIT_UNKNOWN')
        returning id
      `,
      [
        input.attemptId,
        input.errorCode,
        input.errorMessage,
        input.requestPayload
          ? JSON.stringify(sanitizedTbankPayload(input.requestPayload))
          : null,
        input.responsePayload
          ? JSON.stringify({ init: safeProviderSnapshot(input.responsePayload) })
          : null,
        input.retryAtMs,
        input.orderId,
      ],
    );
    // A webhook may have advanced the attempt while Init was in flight. The
    // webhook then owns the order transition; a late timeout/persistence error
    // must not regress that order to payment_unknown.
    if (!markedAttempt.rows[0]) return;
    await client.query(
      `
        update public.merch_customer_orders
        set status = 'payment_unknown'
        where id = $1::uuid
          and status in ('created', 'payment_unknown')
      `,
      [input.orderId],
    );
  });
}

export type PersistTbankInitSuccessResult =
  | { kind: "persisted"; attemptStatus: string; orderStatus: string }
  | { kind: "reconciling"; attemptStatus: string; orderStatus: string }
  | {
      kind: "review" | "processed" | "retry";
      attemptStatus: string;
      orderStatus: string;
    }
  | {
      kind: "conflict";
      storedPaymentId: string;
      receivedPaymentId: string;
      orderStatus: string;
    };

/**
 * Persist the complete successful Init result under an attempt/order lock.
 * An earlier webhook is never downgraded, but its matching Init response can
 * still add the opaque payment-form URL that provider status APIs omit.
 */
export async function persistTbankInitSuccess(
  db: Db,
  input: {
    orderId: string;
    attemptId: number;
    paymentId: string;
    paymentUrl: string;
    providerStatus: string;
    errorCode: string | null;
    errorMessage: string | null;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
  },
): Promise<PersistTbankInitSuccessResult> {
  return db.withTransaction(async (client) => {
    const lockedResult = await client.query<{
      external_payment_id: string | null;
      attempt_status: string;
      order_status: string;
      response_payload: Record<string, unknown> | null;
    }>(
      `
        select
          a.external_payment_id,
          a.provider_status as attempt_status,
          o.status as order_status,
          a.response_payload
        from public.merch_payment_attempts a
        join public.merch_customer_orders o on o.id = a.order_id
        where a.id = $1
          and a.order_id = $2::uuid
        for update of a, o
      `,
      [input.attemptId, input.orderId],
    );
    const locked = lockedResult.rows[0];
    if (!locked) {
      throw new Error("T-Bank payment attempt disappeared before Init persistence");
    }

    let conflictingOwner:
      | Awaited<ReturnType<typeof findOtherTbankPaymentIdentityOwner>>
      | null = null;
    if (!locked.external_payment_id) {
      await lockTbankPaymentIdentity(client, input.paymentId);
      conflictingOwner = await findOtherTbankPaymentIdentityOwner(
        client,
        input.paymentId,
        input.attemptId,
      );
    }
    if (
      (locked.external_payment_id &&
        locked.external_payment_id !== input.paymentId) ||
      conflictingOwner
    ) {
      const conflictCode = conflictingOwner
        ? "tbank_global_payment_id_conflict"
        : "tbank_init_payment_id_conflict";
      const conflictMessage = conflictingOwner
        ? "T-Bank Init PaymentId is already owned by another local payment attempt"
        : "T-Bank Init PaymentId conflicts with the payment recorded by webhook";
      const storedPaymentId = locked.external_payment_id ?? input.paymentId;
      const redactedConflictResponse = sanitizedTbankPayload(
        input.responsePayload,
      );
      delete redactedConflictResponse.PaymentURL;
      await client.query(
        `
          update public.merch_payment_attempts
          set provider_status = 'INIT_REVIEW',
              payment_url = null,
              error_code = $2,
              error_message = $3,
              request_payload = $4::jsonb,
              response_payload = coalesce(response_payload, '{}'::jsonb) || $5::jsonb,
              reconciliation_next_at = null
          where id = $1
        `,
        [
          input.attemptId,
          conflictCode,
          conflictMessage,
          JSON.stringify(sanitizedTbankPayload(input.requestPayload)),
          JSON.stringify({
            late_init_identity_conflict: redactedConflictResponse,
            init_payment_id_conflict: {
              stored_payment_id: locked.external_payment_id,
              received_payment_id: input.paymentId,
              conflicting_attempt_id: conflictingOwner?.id ?? null,
              conflicting_order_id: conflictingOwner?.order_id ?? null,
            },
          }),
        ],
      );
      const conflictedOrder = await client.query<{ status: string }>(
        `
          update public.merch_customer_orders
          set status = case
                when status in (
                  'created',
                  'pending_payment',
                  'payment_unknown',
                  'authorized',
                  'paid',
                  'partially_refunded',
                  'refunded',
                  'payment_failed',
                  'canceled'
                ) then 'payment_review'
                else status
              end,
              metadata = metadata || $2::jsonb
          where id = $1::uuid
          returning status
        `,
        [
          input.orderId,
          JSON.stringify({
            payment_review_reason: "payment_identity_conflict",
            payment_review_code: conflictCode,
            stored_payment_id: locked.external_payment_id,
            received_payment_id: input.paymentId,
            conflicting_attempt_id: conflictingOwner?.id ?? null,
            conflicting_order_id: conflictingOwner?.order_id ?? null,
          }),
        ],
      );
      const resultingOrderStatus =
        conflictedOrder.rows[0]?.status ??
        ([
                "created",
                "pending_payment",
                "payment_unknown",
                "authorized",
                "paid",
                "partially_refunded",
                "refunded",
                "payment_failed",
                "canceled",
              ].includes(locked.order_status)
            ? "payment_review"
            : locked.order_status);
      if (
        resultingOrderStatus === "payment_review" &&
        ["paid", "partially_refunded", "refunded"].includes(
          locked.order_status,
        )
      ) {
        await enqueueCdekEffect(client, "cdek_cancel", input.orderId, {
          source: "tbank_init",
          reason: "payment_identity_conflict",
          stored_payment_id: locked.external_payment_id,
          received_payment_id: input.paymentId,
          conflicting_attempt_id: conflictingOwner?.id ?? null,
          conflicting_order_id: conflictingOwner?.order_id ?? null,
        });
      }
      return {
        kind: "conflict",
        storedPaymentId,
        receivedPaymentId: input.paymentId,
        orderStatus: resultingOrderStatus,
      };
    }

    const disposition = lateInitDisposition(
      locked.attempt_status,
      locked.order_status,
    );
    const cancellationWasAttempted =
      locked.response_payload?.tbank_cancel_attempted === true;
    const reconciliationInFlight =
      disposition === "reconciling" ||
      (disposition === "persisted" && cancellationWasAttempted);
    if (reconciliationInFlight) {
      // CheckOrder/GetState/Cancel may already be using the claimed attempt.
      // A late Init URL cannot be made actionable until that provider flow is
      // known to have completed without cancellation, so retain only a
      // redacted audit record and leave the lease-owned state untouched.
      const redactedResponse = sanitizedTbankPayload(input.responsePayload);
      delete redactedResponse.PaymentURL;
      await client.query(
        `
          update public.merch_payment_attempts
          set external_payment_id = case
                when $4::boolean then coalesce(external_payment_id, $5)
                else external_payment_id
              end,
              request_payload = $2::jsonb,
              response_payload = coalesce(response_payload, '{}'::jsonb) || $3::jsonb
          where id = $1
        `,
        [
          input.attemptId,
          JSON.stringify(sanitizedTbankPayload(input.requestPayload)),
          JSON.stringify({
            late_init_during_reconciliation: redactedResponse,
            payment_url_redacted: true,
          }),
          disposition === "reconciling" && !cancellationWasAttempted,
          input.paymentId,
        ],
      );
      return {
        kind: "reconciling",
        attemptStatus: locked.attempt_status,
        orderStatus: locked.order_status,
      };
    }
    const providerStatusApplied =
      disposition === "persisted" &&
      shouldApplyTbankProviderStatus(locked.attempt_status, input.providerStatus);

    if (disposition !== "persisted") {
      // Keep the signed Init response for operator audit, but never turn a
      // terminal/review attempt back into an actionable payment form.
      await client.query(
        `
          update public.merch_payment_attempts
          set request_payload = $2::jsonb,
              response_payload = coalesce(response_payload, '{}'::jsonb) || $3::jsonb,
              reconciliation_next_at = null
          where id = $1
        `,
        [
          input.attemptId,
          JSON.stringify(sanitizedTbankPayload(input.requestPayload)),
          JSON.stringify({
            late_init_ignored: sanitizedTbankPayload(input.responsePayload),
          }),
        ],
      );
      if (disposition === "review") {
        await client.query(
          `
            update public.merch_customer_orders
            set status = case
                  when status in (
                    'created',
                    'pending_payment',
                    'payment_unknown',
                    'authorized',
                    'payment_failed',
                    'canceled'
                  ) then 'payment_review'
                  else status
                end,
                metadata = metadata || $2::jsonb
            where id = $1::uuid
          `,
          [
            input.orderId,
            JSON.stringify({
              payment_review_reason: "late_init_after_non_resumable_state",
              attempt_status: locked.attempt_status,
              received_payment_id: input.paymentId,
            }),
          ],
        );
      }
      return {
        kind: disposition,
        attemptStatus: locked.attempt_status,
        orderStatus:
          disposition === "review" &&
          !["paid", "partially_refunded", "refunded"].includes(
            locked.order_status,
          )
            ? "payment_review"
            : locked.order_status,
      };
    }

    await client.query(
      `
        update public.merch_payment_attempts
        set external_payment_id = coalesce(external_payment_id, $2),
            provider_status = case when $3::boolean then $4 else provider_status end,
            payment_url = $5,
            error_code = $6,
            error_message = $7,
            request_payload = $8::jsonb,
            response_payload = coalesce(response_payload, '{}'::jsonb) || $9::jsonb,
            reconciliation_next_at = null
        where id = $1
      `,
      [
        input.attemptId,
        input.paymentId,
        providerStatusApplied,
        input.providerStatus,
        input.paymentUrl,
        input.errorCode,
        input.errorMessage,
        JSON.stringify(sanitizedTbankPayload(input.requestPayload)),
        JSON.stringify({ init: sanitizedTbankPayload(input.responsePayload) }),
      ],
    );
    await client.query(
      `
        update public.merch_customer_orders
        set status = 'pending_payment'
        where id = $1::uuid
          and status in ('created', 'payment_unknown')
      `,
      [input.orderId],
    );
    return {
      kind: "persisted",
      attemptStatus: providerStatusApplied
        ? input.providerStatus
        : locked.attempt_status,
      orderStatus:
        ["created", "payment_unknown"].includes(locked.order_status)
          ? "pending_payment"
          : locked.order_status,
    };
  });
}

export function startTbankInitReconciler(
  config: AppConfig,
  db: Db,
  logger: ReconciliationLogger,
): () => Promise<void> {
  if (
    !config.TBANK_RECONCILIATION_ENABLED ||
    config.TBANK_MOCK_PAYMENTS ||
    config.NODE_ENV === "test"
  ) {
    return async () => undefined;
  }

  let provider: TbankProviderConfig;
  try {
    provider = tbankRuntimeConfig(config);
  } catch (error) {
    logger.warn?.({ err: error }, "T-Bank Init reconciler is disabled");
    return async () => undefined;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  const run = () => {
    if (stopped || inFlight) return;
    inFlight = reconcilePendingTbankInits(db, provider, {
      limit: config.TBANK_RECONCILIATION_BATCH_SIZE,
      staleMs: config.TBANK_RECONCILIATION_STALE_MS,
      leaseMs: config.TBANK_RECONCILIATION_LEASE_MS,
      intervalMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
      maxAttempts: config.TBANK_RECONCILIATION_MAX_ATTEMPTS,
      createCdekShipments: config.CDEK_CREATE_SHIPMENTS,
    })
      .then((results) => {
        if (results.length) {
          logger.info?.(
            {
              count: results.length,
              outcomes: results.map((result) => ({
                orderNumber: result.orderNumber,
                kind: result.kind,
                providerStatus: result.providerStatus,
              })),
            },
            "T-Bank Init reconciliation batch completed",
          );
        }
      })
      .catch((error) => {
        logger.error?.({ err: error }, "T-Bank Init reconciliation batch failed");
      })
      .finally(() => {
        inFlight = null;
      });
  };

  timer = setInterval(run, config.TBANK_RECONCILIATION_INTERVAL_MS);
  timer.unref();
  run();

  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    await inFlight;
  };
}
