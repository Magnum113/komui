import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createTbankToken, sha256Hex } from "../src/crypto";
import type { Db } from "../src/db";
import { assertTbankInitPersistenceAllowsRedirect } from "../src/stage5";
import {
  markTbankInitUnknown,
  persistTbankInitSuccess,
  queryTbankInitState,
  reconcileTbankInitForOrder,
  startTbankInitReconciler,
  tbankInitResponseMatchesBoundary,
  validTbankPaymentUrl,
  type TbankProviderConfig,
} from "../src/tbankReconciliation";

const provider: TbankProviderConfig = {
  terminalKey: "test-terminal",
  password: "test-password",
  apiUrl: "https://securepay.tinkoff.ru/v2",
  mock: false,
  requestTimeoutMs: 5_000,
};

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerFetch(
  responses: Record<string, Record<string, unknown>>,
  calls: Array<{ method: string; body: Record<string, unknown> }>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop() || "";
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    const response = responses[method];
    if (!response) throw new Error(`Unexpected provider method ${method}`);
    return jsonResponse(response);
  }) as typeof fetch;
}

async function runCancelVsConfirmedWebhookRace(
  cancelOutcome: "timeout" | "reversed",
) {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const effects = ["cdek_create"];
  const claimed = {
    id: cancelOutcome === "timeout" ? 71 : 72,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number:
      cancelOutcome === "timeout" ? "KOM-CANCEL-TIMEOUT" : "KOM-CANCEL-REVERSED",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: "cancel-race-payment",
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("/* tbank_cancel_intent:lock */")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            order_number: claimed.order_number,
            external_payment_id: claimed.external_payment_id,
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
            response_payload: {},
          },
        ],
      };
    }
    if (sql.includes("/* tbank_cancel_intent:acquire */")) {
      return { rows: [{ id: claimed.id }] };
    }
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "CONFIRMED",
            order_status: "paid",
            external_payment_id: claimed.external_payment_id,
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (
      sql.includes("update public.merch_customer_orders") &&
      sql.includes("returning status")
    ) {
      return { rows: [{ status: "payment_review" }] };
    }
    if (sql.includes("cdek_effect:enqueue")) {
      effects.push("cdek_cancel");
      return {
        rows: [
          {
            id: 12,
            order_id: claimed.order_id,
            effect_type: "cdek_cancel",
            dedupe_key: `cdek_cancel:${claimed.order_id}`,
            status: "pending",
            payload: JSON.parse(String(params[3])),
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;
  const fetchImpl = (async (input: string | URL | Request) => {
    const method = String(input).split("/").pop();
    if (method === "CheckOrder") {
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        Success: true,
        Payments: [
          {
            PaymentId: claimed.external_payment_id,
            Amount: claimed.amount,
            Status: "NEW",
            Success: true,
          },
        ],
      });
    }
    if (method === "GetState") {
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        PaymentId: claimed.external_payment_id,
        Amount: claimed.amount,
        Status: "NEW",
        Success: true,
      });
    }
    if (method === "Cancel") {
      if (cancelOutcome === "timeout") throw new Error("Cancel timeout");
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        PaymentId: claimed.external_payment_id,
        OriginalAmount: claimed.amount,
        NewAmount: 0,
        Status: "REVERSED",
        Success: true,
        ErrorCode: "0",
      });
    }
    throw new Error(`Unexpected provider method ${method}`);
  }) as typeof fetch;

  const result = await reconcileTbankInitForOrder(
    db,
    provider,
    claimed.order_id,
    {
      staleMs: 1,
      leaseMs: 60_000,
      intervalMs: 30_000,
      maxAttempts: 20,
      fetchImpl,
    },
  );
  return { result, sqlLog, effects };
}

async function runSignedWebhookDuringPausedCancel(
  webhookStatus: "AUTH_FAIL" | "CONFIRMED" | null,
  options: {
    advanceSecondLease?: boolean;
    pauseSecondConfirmed?: boolean;
    abandonAfterWebhook?: boolean;
  } = {},
) {
  const state = {
    attemptStatus: "INIT_UNKNOWN",
    orderStatus: "payment_unknown",
    externalPaymentId: "signed-race-payment",
    paymentUrl: "https://pay.tbank.ru/new/stale-before-cancel" as string | null,
    responsePayload: {} as Record<string, unknown>,
    reconciliationAttempts: 0,
    orderMetadata: {} as Record<string, unknown>,
    eventInserted: false,
    effects: [] as Array<{ type: string; payload: Record<string, unknown> }>,
  };
  const claimed = {
    id: options.advanceSecondLease
      ? webhookStatus === "CONFIRMED"
        ? 76
        : 75
      : webhookStatus === "AUTH_FAIL"
        ? 73
        : 74,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: options.advanceSecondLease
      ? webhookStatus === "CONFIRMED"
        ? "KOM-TWO-LEASE-CONFIRMED-RACE"
        : "KOM-TWO-LEASE-PENDING-RACE"
      : webhookStatus === "AUTH_FAIL"
        ? "KOM-SIGNED-AUTH-FAIL-RACE"
        : "KOM-SIGNED-CONFIRMED-RACE",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: state.externalPaymentId,
    reconciliation_attempts: 0,
  };
  let claimsRemaining = options.advanceSecondLease ? 2 : 1;
  const query = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.includes("/* tbank_payment_identity:lock */")) {
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (normalized.includes("/* tbank_payment_identity:owner */")) {
      return { rows: [] };
    }
    if (
      normalized.startsWith("select a.id, a.order_id") &&
      normalized.includes("for update of a, o skip locked")
    ) {
      if (claimsRemaining <= 0) return { rows: [] };
      claimsRemaining -= 1;
      return {
        rows: [
          {
            ...claimed,
            external_payment_id: state.externalPaymentId,
            reconciliation_attempts: state.reconciliationAttempts,
          },
        ],
      };
    }
    if (
      normalized.startsWith(
        "select id, order_id from public.merch_payment_attempts",
      ) &&
      normalized.includes("external_payment_id = $1")
    ) {
      return params[0] === state.externalPaymentId
        ? { rows: [{ id: claimed.id, order_id: claimed.order_id }] }
        : { rows: [] };
    }
    if (
      normalized.startsWith(
        "select id, order_id, amount, external_payment_id, provider_status, terminal_key, response_payload",
      )
    ) {
      return {
        rows: [
          {
            id: claimed.id,
            order_id: claimed.order_id,
            amount: claimed.amount,
            external_payment_id: state.externalPaymentId,
            provider_status: state.attemptStatus,
            terminal_key: claimed.terminal_key,
            response_payload: state.responsePayload,
          },
        ],
      };
    }
    if (
      normalized.startsWith(
        "select id, order_number, total_amount, status, paid_at",
      )
    ) {
      return {
        rows: [
          {
            id: claimed.order_id,
            order_number: claimed.order_number,
            total_amount: claimed.amount,
            status: state.orderStatus,
            paid_at: state.orderStatus === "paid" ? new Date().toISOString() : null,
          },
        ],
      };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("as attempt_status") &&
      normalized.includes("for update of a, o")
    ) {
      return {
        rows: [
          {
            attempt_status: state.attemptStatus,
            order_status: state.orderStatus,
            external_payment_id: state.externalPaymentId,
            response_payload: state.responsePayload,
            reconciliation_attempts: state.reconciliationAttempts,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (normalized.includes("/* tbank_cancel_intent:lock */")) {
      return {
        rows: [
          {
            attempt_status: state.attemptStatus,
            order_status: state.orderStatus,
            order_number: claimed.order_number,
            external_payment_id: state.externalPaymentId,
            response_payload: state.responsePayload,
            reconciliation_attempts: state.reconciliationAttempts,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (
      normalized.startsWith("select a.external_payment_id") &&
      normalized.includes("a.response_payload")
    ) {
      return {
        rows: [
          {
            external_payment_id: state.externalPaymentId,
            attempt_status: state.attemptStatus,
            order_status: state.orderStatus,
            response_payload: state.responsePayload,
          },
        ],
      };
    }
    if (normalized.startsWith("insert into public.merch_payment_events")) {
      if (state.eventInserted) return { rows: [] };
      state.eventInserted = true;
      return { rows: [{ id: 1 }] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("set provider_status = 'reconciling_init'")
    ) {
      state.attemptStatus = "RECONCILING_INIT";
      state.reconciliationAttempts += 1;
      return { rows: [] };
    }
    if (normalized.includes("/* tbank_cancel_intent:acquire */")) {
      state.externalPaymentId = state.externalPaymentId ?? String(params[1]);
      state.paymentUrl = null;
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[3])) as Record<string, unknown>),
      };
      return { rows: [{ id: claimed.id }] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("external_payment_id = coalesce(external_payment_id, $2)") &&
      normalized.includes("provider_status = case when $3::boolean")
    ) {
      if (params[2] === true) state.attemptStatus = String(params[3]);
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("set payment_url = null") &&
      normalized.includes("response_payload = coalesce")
    ) {
      state.paymentUrl = null;
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[1])) as Record<string, unknown>),
      };
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("external_payment_id = coalesce(external_payment_id, $2)") &&
      normalized.includes("provider_status = $3")
    ) {
      state.attemptStatus = String(params[2]);
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[5])) as Record<string, unknown>),
      };
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("provider_status = 'init_review'")
    ) {
      state.attemptStatus = "INIT_REVIEW";
      state.paymentUrl = null;
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[3])) as Record<string, unknown>),
      };
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("request_payload = $2::jsonb") &&
      normalized.includes("response_payload = coalesce")
    ) {
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[2])) as Record<string, unknown>),
      };
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_customer_orders") &&
      normalized.includes("returning status")
    ) {
      state.orderStatus = "payment_review";
      state.orderMetadata = {
        ...state.orderMetadata,
        ...(JSON.parse(String(params[1])) as Record<string, unknown>),
      };
      return { rows: [{ status: state.orderStatus }] };
    }
    if (
      normalized.startsWith("update public.merch_customer_orders") &&
      normalized.includes("set status = $2")
    ) {
      state.orderStatus = String(params[1]);
      if (params[2]) {
        state.orderMetadata = {
          ...state.orderMetadata,
          ...(JSON.parse(String(params[2])) as Record<string, unknown>),
        };
      }
      return normalized.includes("returning id")
        ? { rows: [{ id: claimed.order_id }] }
        : { rows: [] };
    }
    if (normalized.startsWith("update public.merch_customer_orders")) {
      return { rows: [] };
    }
    if (normalized.startsWith("update public.merch_promo_redemptions")) {
      return { rows: [] };
    }
    if (normalized.includes("/* cdek_effect:enqueue */")) {
      const payload = JSON.parse(String(params[3])) as Record<string, unknown>;
      state.effects.push({ type: String(params[0]), payload });
      return {
        rows: [
          {
            id: state.effects.length,
            order_id: claimed.order_id,
            effect_type: params[0],
            dedupe_key: `${params[0]}:${claimed.order_id}`,
            status: "pending",
            payload,
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    throw new Error(`Unexpected SQL in signed Cancel race fake: ${normalized}`);
  };
  const db = {
    query,
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;

  let cancelStartedResolve!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    cancelStartedResolve = resolve;
  });
  let releaseCancel!: () => void;
  const cancelReleased = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let secondProviderStartedResolve!: () => void;
  const secondProviderStarted = new Promise<void>((resolve) => {
    secondProviderStartedResolve = resolve;
  });
  let releaseSecondProvider!: () => void;
  const secondProviderReleased = new Promise<void>((resolve) => {
    releaseSecondProvider = resolve;
  });
  let checkOrderCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const method = String(input).split("/").pop();
    if (method === "CheckOrder") {
      checkOrderCalls += 1;
      if (options.pauseSecondConfirmed && checkOrderCalls === 2) {
        secondProviderStartedResolve();
        await secondProviderReleased;
        return jsonResponse({
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: claimed.external_payment_id,
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        });
      }
      if (options.advanceSecondLease && checkOrderCalls === 2) {
        return jsonResponse({
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [],
        });
      }
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        Success: true,
        Payments: [
          {
            PaymentId: claimed.external_payment_id,
            Amount: claimed.amount,
            Status: "NEW",
            Success: true,
          },
        ],
      });
    }
    if (method === "GetState") {
      if (options.pauseSecondConfirmed && checkOrderCalls >= 2) {
        return jsonResponse({
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: claimed.external_payment_id,
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        });
      }
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        PaymentId: claimed.external_payment_id,
        Amount: claimed.amount,
        Status: "NEW",
        Success: true,
      });
    }
    if (method === "Cancel") {
      cancelStartedResolve();
      await cancelReleased;
      throw new Error("deterministic Cancel timeout");
    }
    throw new Error(`Unexpected provider method ${method}`);
  }) as typeof fetch;

  const reconciliation = reconcileTbankInitForOrder(
    db,
    provider,
    claimed.order_id,
    {
      staleMs: 1,
      leaseMs: 60_000,
      intervalMs: 30_000,
      maxAttempts: 20,
      fetchImpl,
    },
  );
  await cancelStarted;

  const secondLease = options.advanceSecondLease
    ? reconcileTbankInitForOrder(db, provider, claimed.order_id, {
        staleMs: 1,
        leaseMs: 60_000,
        intervalMs: 30_000,
        maxAttempts: 20,
        fetchImpl,
      })
    : null;
  let reconciliationResult: Awaited<typeof reconciliation> | null = null;
  let secondLeaseResult: Awaited<ReturnType<typeof reconcileTbankInitForOrder>> =
    null;
  let cancelAlreadyReleased = false;
  if (secondLease && options.pauseSecondConfirmed) {
    await secondProviderStarted;
    releaseCancel();
    cancelAlreadyReleased = true;
    reconciliationResult = await reconciliation;
    releaseSecondProvider();
    secondLeaseResult = await secondLease;
  } else if (secondLease) {
    secondLeaseResult = await secondLease;
  }

  let app: ReturnType<typeof buildApp> | null = null;
  if (webhookStatus) {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      TBANK_DEMO_TERMINAL_KEY: provider.terminalKey,
      TBANK_DEMO_PASSWORD: provider.password,
      CDEK_CREATE_SHIPMENTS: "true",
      CDEK_MOCK: "true",
    });
    app = buildApp({ config, db });
    const unsignedWebhook = {
      TerminalKey: provider.terminalKey,
      OrderId: claimed.order_number,
      Success: webhookStatus === "CONFIRMED",
      Status: webhookStatus,
      PaymentId: claimed.external_payment_id,
      ErrorCode: webhookStatus === "AUTH_FAIL" ? "7" : "0",
      Amount: claimed.amount,
    };
    const webhookResponse = await app.inject({
      method: "POST",
      url: "/v1/webhooks/tbank",
      payload: {
        ...unsignedWebhook,
        Token: createTbankToken(unsignedWebhook, provider.password),
      },
    });
    assert.equal(webhookResponse.statusCode, 200);
  }

  if (!cancelAlreadyReleased && !options.abandonAfterWebhook) {
    releaseCancel();
    reconciliationResult = await reconciliation;
  }
  await app?.close();
  return { db, state, claimed, reconciliationResult, secondLeaseResult };
}

async function runRejectedPreCancelIntent(
  mode: "generation_mismatch" | "duplicate_owner",
) {
  const state = {
    attemptStatus: "INIT_UNKNOWN",
    orderStatus: "payment_unknown",
    reconciliationAttempts: 0,
  };
  const claimed = {
    id: mode === "generation_mismatch" ? 93 : 94,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number:
      mode === "generation_mismatch"
        ? "KOM-CANCEL-CAS-LOST"
        : "KOM-CANCEL-DUPLICATE-OWNER",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: "pre-cancel-payment",
    reconciliation_attempts: 0,
  };
  let claimAvailable = true;
  const query = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (
      normalized.startsWith("select a.id, a.order_id") &&
      normalized.includes("for update of a, o skip locked")
    ) {
      if (!claimAvailable) return { rows: [] };
      claimAvailable = false;
      return { rows: [{ ...claimed }] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("set provider_status = 'reconciling_init'")
    ) {
      state.attemptStatus = "RECONCILING_INIT";
      state.reconciliationAttempts += 1;
      return { rows: [] };
    }
    if (normalized.includes("/* tbank_cancel_intent:lock */")) {
      return {
        rows: [
          {
            attempt_status: state.attemptStatus,
            order_status: state.orderStatus,
            order_number: claimed.order_number,
            external_payment_id: claimed.external_payment_id,
            reconciliation_attempts:
              mode === "generation_mismatch"
                ? state.reconciliationAttempts + 1
                : state.reconciliationAttempts,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
            response_payload: {},
          },
        ],
      };
    }
    if (normalized.includes("/* tbank_payment_identity:lock */")) {
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (normalized.includes("/* tbank_payment_identity:owner */")) {
      return mode === "duplicate_owner"
        ? {
            rows: [
              {
                id: 999,
                order_id: "f2784a17-4ac6-44e9-ac3c-c36753b62e62",
              },
            ],
          }
        : { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("provider_status = 'init_review'")
    ) {
      state.attemptStatus = "INIT_REVIEW";
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_customer_orders") &&
      normalized.includes("returning status")
    ) {
      state.orderStatus = "payment_review";
      return { rows: [{ status: state.orderStatus }] };
    }
    if (normalized.startsWith("update public.merch_customer_orders")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in pre-Cancel intent fake: ${normalized}`);
  };
  const db = {
    query,
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
  } as unknown as Db;
  const providerCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const method = String(input).split("/").pop() || "";
    providerCalls.push(method);
    if (method === "CheckOrder") {
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        Success: true,
        Payments: [
          {
            PaymentId: claimed.external_payment_id,
            Amount: claimed.amount,
            Status: "NEW",
            Success: true,
          },
        ],
      });
    }
    if (method === "GetState") {
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        PaymentId: claimed.external_payment_id,
        Amount: claimed.amount,
        Status: "NEW",
        Success: true,
      });
    }
    if (method === "Cancel") {
      throw new Error("Cancel must not run when its durable intent is rejected");
    }
    throw new Error(`Unexpected provider method ${method}`);
  }) as typeof fetch;

  const result = await reconcileTbankInitForOrder(
    db,
    provider,
    claimed.order_id,
    {
      staleMs: 1,
      leaseMs: 60_000,
      intervalMs: 30_000,
      maxAttempts: 20,
      fetchImpl,
    },
  );
  return { result, state, providerCalls };
}

test("ambiguous Init cancels an orphaned NEW payment before allowing retry", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-123456789",
      expectedAmount: 339_000,
      beforeCancel: async () => true,
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-123456789",
          Success: true,
          ErrorCode: "0",
          Payments: [
            { PaymentId: "91234567", Amount: 339_000, Status: "NEW", Success: true },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-123456789",
          PaymentId: "91234567",
          Amount: 339_000,
          Status: "NEW",
          Success: true,
          ErrorCode: "0",
        },
        Cancel: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-123456789",
          PaymentId: "91234567",
          Status: "CANCELED",
          OriginalAmount: 339_000,
          NewAmount: 0,
          Success: true,
          ErrorCode: "0",
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "failed");
  assert.equal(result.providerStatus, "CANCELED");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder", "GetState", "Cancel"]);
  for (const call of calls) {
    assert.equal(typeof call.body.Token, "string");
    assert.equal(String(call.body.Token).length, 64);
  }
  assert.equal(calls[2].body.PaymentId, "91234567");
  assert.equal(
    calls[2].body.ExternalRequestId,
    "komui-init-KOM-123456789-91234567",
  );
  assert.equal("Amount" in calls[2].body, false);
});

test("a lost pre-Cancel lease never reaches the provider Cancel endpoint", async () => {
  const { result, state, providerCalls } = await runRejectedPreCancelIntent(
    "generation_mismatch",
  );

  assert.equal(result?.kind, "superseded");
  assert.equal(state.attemptStatus, "RECONCILING_INIT");
  assert.equal(state.orderStatus, "payment_unknown");
  assert.deepEqual(providerCalls, ["CheckOrder", "GetState"]);
});

test("a bound PaymentId with another local owner is quarantined before Cancel", async () => {
  const { result, state, providerCalls } = await runRejectedPreCancelIntent(
    "duplicate_owner",
  );

  assert.equal(result?.kind, "review");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_reconciliation_payment_id_conflict",
  );
  assert.equal(state.attemptStatus, "INIT_REVIEW");
  assert.equal(state.orderStatus, "payment_review");
  assert.deepEqual(providerCalls, ["CheckOrder", "GetState"]);
});

test("reconciliation applies a confirmed provider fact without trying Cancel", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    { orderNumber: "KOM-223456789", expectedAmount: 290_000 },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-223456789",
          Success: true,
          Payments: [
            {
              PaymentId: "92234567",
              Amount: 290_000,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-223456789",
          PaymentId: "92234567",
          Amount: 290_000,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "processed");
  assert.equal(result.providerStatus, "CONFIRMED");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder", "GetState"]);
});

test("provider errors and an empty CheckOrder are not treated as proof of failure", async () => {
  const errorResult = await queryTbankInitState(
    provider,
    { orderNumber: "KOM-323456789", expectedAmount: 100_000 },
    (async () => {
      throw new Error("temporary provider outage");
    }) as typeof fetch,
  );
  assert.equal(errorResult.kind, "pending");

  const providerErrorResult = await queryTbankInitState(
    provider,
    { orderNumber: "KOM-323456789", expectedAmount: 100_000 },
    providerFetch(
      {
        CheckOrder: {
          Success: false,
          ErrorCode: "9999",
          Message: "Temporary processing error",
        },
      },
      [],
    ),
  );
  assert.equal(providerErrorResult.kind, "pending");
  assert.equal(providerErrorResult.errorCode, "9999");

  const emptyResult = await queryTbankInitState(
    provider,
    { orderNumber: "KOM-323456789", expectedAmount: 100_000 },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-323456789",
          Success: true,
          Payments: [],
        },
      },
      [],
    ),
  );
  assert.equal(emptyResult.kind, "pending");
  assert.equal(emptyResult.errorCode, "tbank_payment_not_visible");
});

test("reconciliation rejects amount mismatches without canceling a foreign payment", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    { orderNumber: "KOM-423456789", expectedAmount: 100_000 },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-423456789",
          Success: true,
          Payments: [
            { PaymentId: "94234567", Amount: 99_000, Status: "NEW", Success: true },
          ],
        },
      },
      calls,
    ),
  );
  assert.equal(result.kind, "review");
  assert.equal(result.errorCode, "tbank_payment_ambiguous");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("known PaymentId with an explicit CheckOrder amount mismatch requires review", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-428456789",
      expectedAmount: 100_000,
      knownPaymentId: "known-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-428456789",
          Success: true,
          Payments: [
            {
              PaymentId: "known-payment-id",
              Amount: 99_000,
              Status: "CANCELED",
              Success: true,
            },
          ],
        },
        // If the mismatch guard regresses, the missing GetState fixture acts
        // like a timeout and must still never become retry-safe failure.
      },
      calls,
    ),
  );

  assert.equal(result.kind, "review");
  assert.equal(result.errorCode, "tbank_check_order_amount_mismatch");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("terminal CheckOrder without Amount requires review before GetState", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-429456789",
      expectedAmount: 100_000,
      knownPaymentId: "known-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-429456789",
          Success: true,
          Payments: [
            {
              PaymentId: "known-payment-id",
              Status: "CANCELED",
              Success: true,
            },
          ],
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "review");
  assert.equal(
    result.kind === "review" ? result.errorCode : null,
    "tbank_check_order_amount_mismatch",
  );
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("missing CheckOrder Amount cannot use an unsuccessful GetState fallback", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-430456789",
      expectedAmount: 100_000,
      knownPaymentId: "known-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-430456789",
          Success: true,
          Payments: [
            {
              PaymentId: "known-payment-id",
              Status: "CANCELED",
              Success: true,
            },
          ],
        },
        GetState: {
          Success: false,
          ErrorCode: "9999",
          Message: "Temporary provider error",
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "review");
  assert.equal(
    result.kind === "review" ? result.errorCode : null,
    "tbank_check_order_amount_mismatch",
  );
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("exact CheckOrder amount preserves terminal fallback when GetState times out", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-431456789",
      expectedAmount: 100_000,
      knownPaymentId: "known-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-431456789",
          Success: true,
          Payments: [
            {
              PaymentId: "known-payment-id",
              Amount: 100_000,
              Status: "CANCELED",
              Success: true,
            },
          ],
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "failed");
  assert.equal(result.providerStatus, "CANCELED");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder", "GetState"]);
});

test("AUTH_FAIL is not a terminal fallback when GetState times out", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-432456789",
      expectedAmount: 100_000,
      knownPaymentId: "known-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-432456789",
          Success: true,
          Payments: [
            {
              PaymentId: "known-payment-id",
              Amount: 100_000,
              Status: "AUTH_FAIL",
              Success: true,
            },
          ],
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "pending");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder", "GetState"]);
});

test("known PaymentId never falls back to a different CheckOrder payment", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-433456789",
      expectedAmount: 100_000,
      knownPaymentId: "stored-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-433456789",
          Success: true,
          Payments: [
            {
              PaymentId: "different-payment-id",
              Amount: 100_000,
              Status: "NEW",
              Success: true,
            },
          ],
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "review");
  assert.equal(result.errorCode, "tbank_payment_id_mismatch");
  assert.equal(result.paymentId, "stored-payment-id");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("known PaymentId plus a second provider payment requires review", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-443456789",
      expectedAmount: 100_000,
      knownPaymentId: "stored-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-443456789",
          Success: true,
          Payments: [
            {
              PaymentId: "stored-payment-id",
              Amount: 100_000,
              Status: "NEW",
              Success: true,
            },
            {
              PaymentId: "second-payment-id",
              Amount: 100_000,
              Status: "AUTHORIZED",
              Success: true,
            },
          ],
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "review");
  assert.equal(result.errorCode, "tbank_payment_ambiguous");
  assert.equal(result.paymentId, "stored-payment-id");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("conflicting duplicate CheckOrder rows for one PaymentId require review before terminal fallback", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-453456789",
      expectedAmount: 100_000,
      knownPaymentId: "duplicate-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-453456789",
          Success: true,
          Payments: [
            {
              PaymentId: "duplicate-payment-id",
              Amount: 100_000,
              Status: "NEW",
              Success: true,
            },
            {
              PaymentId: "duplicate-payment-id",
              Amount: 100_000,
              Status: "REJECTED",
              Success: true,
            },
          ],
        },
        // No GetState response: accepting the last duplicate row would turn
        // this provider ambiguity into a retry-safe terminal failure.
      },
      calls,
    ),
  );

  assert.equal(result.kind, "review");
  assert.equal(result.providerStatus, "INIT_REVIEW");
  assert.equal(
    result.kind === "review" ? result.errorCode : null,
    "tbank_duplicate_payment_conflict",
  );
  assert.equal(result.paymentId, "duplicate-payment-id");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("identical duplicate CheckOrder rows are safely deduplicated", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const duplicate = {
    PaymentId: "identical-payment-id",
    Amount: 100_000,
    Status: "CONFIRMED",
    Success: true,
  };
  const result = await queryTbankInitState(
    provider,
    {
      orderNumber: "KOM-454456789",
      expectedAmount: 100_000,
      knownPaymentId: "identical-payment-id",
    },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-454456789",
          Success: true,
          Payments: [{ ...duplicate }, { ...duplicate }],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-454456789",
          PaymentId: "identical-payment-id",
          Amount: 100_000,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "processed");
  assert.equal(result.providerStatus, "CONFIRMED");
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder", "GetState"]);
});

test("a malformed CheckOrder row beside a valid payment requires review", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    { orderNumber: "KOM-MALFORMED-ROWS", expectedAmount: 100_000 },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-MALFORMED-ROWS",
          Success: true,
          Payments: [
            {
              PaymentId: "valid-payment-id",
              Amount: 100_000,
              Status: "CONFIRMED",
              Success: true,
            },
            { Amount: 100_000, Status: "CONFIRMED" },
          ],
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "review");
  assert.equal(
    result.kind === "review" ? result.errorCode : null,
    "tbank_malformed_payment_rows",
  );
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder"]);
});

test("GetState must provide an explicit status before financial projection", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const result = await queryTbankInitState(
    provider,
    { orderNumber: "KOM-MISSING-STATE", expectedAmount: 100_000 },
    providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-MISSING-STATE",
          Success: true,
          Payments: [
            {
              PaymentId: "missing-state-payment",
              Amount: 100_000,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: "KOM-MISSING-STATE",
          PaymentId: "missing-state-payment",
          Amount: 100_000,
          Success: true,
          ErrorCode: "0",
        },
      },
      calls,
    ),
  );

  assert.equal(result.kind, "pending");
  assert.equal(result.providerStatus, "INIT_UNKNOWN");
  assert.equal(
    result.kind === "pending" ? result.errorCode : null,
    "tbank_get_state_status_missing",
  );
  assert.deepEqual(calls.map((call) => call.method), ["CheckOrder", "GetState"]);
});

test("payment URL validation only accepts HTTPS T-Bank domains", () => {
  assert.equal(
    validTbankPaymentUrl("https://pay.tbank.ru/new/opaque-token"),
    "https://pay.tbank.ru/new/opaque-token",
  );
  assert.equal(validTbankPaymentUrl("http://pay.tbank.ru/new/token"), "");
  assert.equal(validTbankPaymentUrl("https://tbank.ru.attacker.example/new/token"), "");
});

test("successful Init response must match terminal, OrderId and amount", () => {
  const response = {
    TerminalKey: provider.terminalKey,
    OrderId: "KOM-500000001",
    Amount: 300_000,
    Status: "NEW",
  };
  const expected = {
    terminalKey: provider.terminalKey,
    orderNumber: "KOM-500000001",
    amount: 300_000,
  };
  assert.equal(tbankInitResponseMatchesBoundary(response, expected), true);
  assert.equal(
    tbankInitResponseMatchesBoundary({ ...response, Amount: 299_999 }, expected),
    false,
  );
  assert.equal(
    tbankInitResponseMatchesBoundary({ ...response, OrderId: "KOM-OTHER" }, expected),
    false,
  );
  assert.equal(
    tbankInitResponseMatchesBoundary({ ...response, Status: undefined }, expected),
    false,
  );
  assert.equal(
    tbankInitResponseMatchesBoundary({ ...response, Status: "CONFIRMED" }, expected),
    false,
  );
});

test("ambiguous Init is persisted atomically as payment_unknown", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          return sql.includes("returning id") ? { rows: [{ id: 42 }] } : { rows: [] };
        },
      }),
  } as unknown as Db;

  await markTbankInitUnknown(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 42,
    errorCode: "UND_ERR_CONNECT_TIMEOUT",
    errorMessage: "fetch failed",
    retryAtMs: 30_000,
    requestPayload: { TerminalKey: "test-terminal", OrderId: "KOM-1", Token: "secret" },
  });

  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /provider_status = 'INIT_UNKNOWN'/);
  assert.match(queries[1].sql, /status = 'payment_unknown'/);
  assert.doesNotMatch(String(queries[0].params[3]), /secret/);
});

test("late Init failure does not regress an attempt already advanced by webhook", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  await markTbankInitUnknown(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 43,
    errorCode: "init_persistence_failed",
    errorMessage: "late database error",
    retryAtMs: 30_000,
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /returning id/i);
  assert.equal(queries.some((query) => /set status = 'payment_unknown'/.test(query.sql)), false);
});

test("successful Init persistence keeps payment URL and all nine SQL parameters aligned", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: null,
                  attempt_status: "INITIATING",
                  order_status: "created",
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 81,
    paymentId: "98123456",
    paymentUrl: "https://pay.tbank.ru/new/opaque-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: {
      TerminalKey: provider.terminalKey,
      OrderId: "KOM-600000001",
      Amount: 300_000,
      Token: "must-not-be-persisted",
    },
    responsePayload: {
      TerminalKey: provider.terminalKey,
      OrderId: "KOM-600000001",
      Amount: 300_000,
      PaymentId: "98123456",
      PaymentURL: "https://pay.tbank.ru/new/opaque-token",
      Status: "NEW",
      Success: true,
    },
  });

  assert.equal(queries.length, 5);
  assert.match(queries[0].sql, /for update of a, o/i);
  const attemptUpdate = queries.find(({ sql }) =>
    /set external_payment_id = coalesce/.test(sql),
  );
  assert.ok(attemptUpdate);
  assert.equal(attemptUpdate.params.length, 9);
  assert.equal(attemptUpdate.params[1], "98123456");
  assert.equal(attemptUpdate.params[2], true);
  assert.equal(attemptUpdate.params[3], "NEW");
  assert.equal(attemptUpdate.params[4], "https://pay.tbank.ru/new/opaque-token");
  assert.doesNotMatch(String(attemptUpdate.params[7]), /must-not-be-persisted/);
  assert.match(queries.at(-1)?.sql ?? "", /status = 'pending_payment'/);
});

test("successful Init persistence fails as one transaction when order update fails", async () => {
  let queryCount = 0;
  let rolledBack = false;
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) => {
      try {
        return await callback({
          query: async () => {
            queryCount += 1;
            if (queryCount === 1) {
              return {
                rows: [
                  {
                    external_payment_id: null,
                    attempt_status: "INITIATING",
                    order_status: "created",
                  },
                ],
              };
            }
            if (queryCount === 2) return { rows: [] };
            throw new Error("order update failed");
          },
        });
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  } as unknown as Db;

  await assert.rejects(
    persistTbankInitSuccess(db, {
      orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
      attemptId: 91,
      paymentId: "99123456",
      paymentUrl: "https://pay.tbank.ru/new/opaque-token",
      providerStatus: "NEW",
      errorCode: null,
      errorMessage: null,
      requestPayload: { TerminalKey: provider.terminalKey },
      responsePayload: { Success: true },
    }),
    /order update failed/,
  );
  assert.equal(rolledBack, true);
});

test("late Init after CONFIRMED remains processed and does not store a form URL", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: "98123456",
                  attempt_status: "CONFIRMED",
                  order_status: "paid",
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 82,
    paymentId: "98123456",
    paymentUrl: "https://pay.tbank.ru/new/opaque-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: { Success: true, PaymentId: "98123456" },
  });

  assert.deepEqual(result, {
    kind: "processed",
    attemptStatus: "CONFIRMED",
    orderStatus: "paid",
  });
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1].sql, /payment_url\s*=/);
  assert.match(String(queries[1].params[2]), /late_init_ignored/);
  assert.throws(
    () =>
      assertTbankInitPersistenceAllowsRedirect(
        result,
        "KOM-CONFIRMED",
        30_000,
      ),
    (error: unknown) => {
      const typed = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(typed.code, "payment_already_processed");
      assert.equal(typed.details?.retryAllowed, false);
      assert.doesNotMatch(JSON.stringify(error), /opaque-token/);
      return true;
    },
  );
});

test("late valid Init after INIT_REVIEW remains fail-closed and stage5 cannot return its URL", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: "review-payment-id",
                  attempt_status: "INIT_REVIEW",
                  order_status: "payment_review",
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 86,
    paymentId: "review-payment-id",
    paymentUrl: "https://pay.tbank.ru/new/review-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: {
      Success: true,
      PaymentId: "review-payment-id",
      PaymentURL: "https://pay.tbank.ru/new/review-token",
    },
  });

  assert.deepEqual(result, {
    kind: "review",
    attemptStatus: "INIT_REVIEW",
    orderStatus: "payment_review",
  });
  assert.equal(queries.some(({ sql }) => /payment_url\s*=/.test(sql)), false);
  assert.equal(
    queries.some(
      ({ sql }) =>
        sql.includes("update public.merch_customer_orders") &&
        sql.includes("payment_review"),
    ),
    true,
  );
  assert.throws(
    () =>
      assertTbankInitPersistenceAllowsRedirect(
        result,
        "KOM-REVIEW",
        30_000,
      ),
    (error: unknown) => {
      const typed = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(typed.code, "payment_requires_review");
      assert.equal(typed.details?.retryAllowed, false);
      assert.doesNotMatch(JSON.stringify(error), /review-token/);
      return true;
    },
  );
});

test("late valid Init after terminal REJECTED remains retry-only without a form URL", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: "rejected-payment-id",
                  attempt_status: "REJECTED",
                  order_status: "payment_failed",
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 87,
    paymentId: "rejected-payment-id",
    paymentUrl: "https://pay.tbank.ru/new/rejected-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: {
      Success: true,
      PaymentId: "rejected-payment-id",
      PaymentURL: "https://pay.tbank.ru/new/rejected-token",
    },
  });

  assert.deepEqual(result, {
    kind: "retry",
    attemptStatus: "REJECTED",
    orderStatus: "payment_failed",
  });
  assert.equal(queries.length, 2);
  assert.equal(queries.some(({ sql }) => /payment_url\s*=/.test(sql)), false);
  assert.throws(
    () =>
      assertTbankInitPersistenceAllowsRedirect(
        result,
        "KOM-REJECTED",
        30_000,
      ),
    (error: unknown) => {
      const typed = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(typed.code, "payment_retry_required");
      assert.equal(typed.details?.retryAllowed, true);
      assert.doesNotMatch(JSON.stringify(error), /rejected-token/);
      return true;
    },
  );
});

test("matching Init success restores payment_unknown to pending_payment", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: null,
                  attempt_status: "INIT_UNKNOWN",
                  order_status: "payment_unknown",
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 84,
    paymentId: "98423456",
    paymentUrl: "https://pay.tbank.ru/new/opaque-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: { Success: true, PaymentId: "98423456" },
  });

  assert.deepEqual(result, {
    kind: "persisted",
    attemptStatus: "NEW",
    orderStatus: "pending_payment",
  });
  assert.match(
    queries.find(({ sql }) => /status = 'pending_payment'/.test(sql))?.sql ?? "",
    /status in \('created', 'payment_unknown'\)/,
  );
});

test("late Init during active reconciliation never stores an actionable payment URL", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: "98523456",
                  attempt_status: "RECONCILING_INIT",
                  order_status: "payment_unknown",
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 85,
    paymentId: "98523456",
    paymentUrl: "https://pay.tbank.ru/new/opaque-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: { Success: true, PaymentId: "98523456" },
  });

  assert.deepEqual(result, {
    kind: "reconciling",
    attemptStatus: "RECONCILING_INIT",
    orderStatus: "payment_unknown",
  });
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1].sql, /payment_url\s*=/);
  assert.doesNotMatch(queries[1].sql, /provider_status\s*=/);
  assert.doesNotMatch(
    JSON.stringify(queries[1].params),
    /opaque-token/,
  );
  assert.match(
    String(queries[1].params[2]),
    /late_init_during_reconciliation/,
  );
  assert.equal(queries.some((query) => /set status = 'pending_payment'/.test(query.sql)), false);
});

test("late Init racing an ambiguous Cancel never exposes its form URL on a subsequent retry", async () => {
  const accessToken = "R".repeat(40);
  const state = {
    attemptStatus: "INIT_UNKNOWN",
    orderStatus: "payment_unknown",
    externalPaymentId: null as string | null,
    paymentUrl: null as string | null,
    responsePayload: {} as Record<string, unknown>,
    reconciliationAttempts: 0,
  };
  const claimed = {
    id: 91,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-913456789",
    amount: 300_000,
    order_total_amount: 300_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  let claimAvailable = true;
  const query = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.includes("/* tbank_payment_identity:lock */")) {
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (normalized.includes("/* tbank_payment_identity:owner */")) {
      return { rows: [] };
    }
    if (
      normalized.startsWith("select a.id, a.order_id") &&
      normalized.includes("for update of a, o skip locked")
    ) {
      if (!claimAvailable) return { rows: [] };
      claimAvailable = false;
      return { rows: [{ ...claimed }] };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("as attempt_status") &&
      normalized.includes("for update of a, o")
    ) {
      return {
        rows: [
          {
            external_payment_id: state.externalPaymentId,
            attempt_status: state.attemptStatus,
            order_status: state.orderStatus,
            response_payload: state.responsePayload,
            reconciliation_attempts: state.reconciliationAttempts,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (normalized.includes("/* tbank_cancel_intent:lock */")) {
      return {
        rows: [
          {
            external_payment_id: state.externalPaymentId,
            attempt_status: state.attemptStatus,
            order_status: state.orderStatus,
            order_number: claimed.order_number,
            response_payload: state.responsePayload,
            reconciliation_attempts: state.reconciliationAttempts,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("provider_status = 'reconciling_init'") &&
      normalized.includes("reconciliation_attempts = reconciliation_attempts + 1")
    ) {
      state.attemptStatus = "RECONCILING_INIT";
      state.reconciliationAttempts += 1;
      return { rows: [] };
    }
    if (normalized.includes("/* tbank_cancel_intent:acquire */")) {
      state.externalPaymentId = state.externalPaymentId ?? String(params[1]);
      state.paymentUrl = null;
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[3])) as Record<string, unknown>),
      };
      return { rows: [{ id: claimed.id }] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("request_payload = $2::jsonb") &&
      normalized.includes("response_payload = coalesce")
    ) {
      assert.doesNotMatch(normalized, /payment_url\s*=/);
      const audit = JSON.parse(String(params[2])) as Record<string, unknown>;
      assert.doesNotMatch(JSON.stringify(audit), /form-token/);
      state.responsePayload = { ...state.responsePayload, ...audit };
      if (params[3] === true && !state.externalPaymentId) {
        state.externalPaymentId = String(params[4]);
      }
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("set payment_url = null") &&
      normalized.includes("response_payload = coalesce")
    ) {
      state.paymentUrl = null;
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[1])) as Record<string, unknown>),
      };
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_payment_attempts") &&
      normalized.includes("provider_status = $3")
    ) {
      state.externalPaymentId =
        state.externalPaymentId ?? (params[1] ? String(params[1]) : null);
      state.attemptStatus = String(params[2]);
      state.responsePayload = {
        ...state.responsePayload,
        ...(JSON.parse(String(params[5])) as Record<string, unknown>),
      };
      return { rows: [] };
    }
    if (
      normalized.startsWith("update public.merch_customer_orders") &&
      normalized.includes("set status = $2")
    ) {
      state.orderStatus = String(params[1]);
      return { rows: [] };
    }
    if (normalized.startsWith("update public.merch_customer_orders")) {
      return { rows: [] };
    }
    if (
      normalized.startsWith(
        "select id, order_number, access_token_hash, total_amount, status",
      )
    ) {
      return {
        rows: [
          {
            id: claimed.order_id,
            order_number: claimed.order_number,
            access_token_hash: sha256Hex(accessToken),
            total_amount: claimed.amount,
            status: state.orderStatus,
          },
        ],
      };
    }
    if (
      normalized.startsWith(
        "select id, payment_url, external_payment_id, provider_status",
      )
    ) {
      return {
        rows: [
          {
            id: claimed.id,
            payment_url: state.paymentUrl,
            external_payment_id: state.externalPaymentId,
            provider_status: state.attemptStatus,
          },
        ],
      };
    }
    throw new Error(`Unexpected SQL in late Init race fake: ${normalized}`);
  };
  const db = {
    query,
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;

  let cancelStartedResolve!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    cancelStartedResolve = resolve;
  });
  let releaseCancel!: () => void;
  const cancelRelease = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const method = String(input).split("/").pop();
    if (method === "CheckOrder") {
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        Success: true,
        Payments: [
          {
            PaymentId: "race-payment-id",
            Amount: claimed.amount,
            Status: "NEW",
            Success: true,
          },
        ],
      });
    }
    if (method === "GetState") {
      return jsonResponse({
        TerminalKey: provider.terminalKey,
        OrderId: claimed.order_number,
        PaymentId: "race-payment-id",
        Amount: claimed.amount,
        Status: "NEW",
        Success: true,
      });
    }
    if (method === "Cancel") {
      cancelStartedResolve();
      await cancelRelease;
      throw new Error("ambiguous Cancel timeout");
    }
    throw new Error(`Unexpected provider method ${method}`);
  }) as typeof fetch;

  const reconciliation = reconcileTbankInitForOrder(
    db,
    provider,
    claimed.order_id,
    {
      staleMs: 1,
      leaseMs: 60_000,
      intervalMs: 30_000,
      maxAttempts: 20,
      fetchImpl,
    },
  );
  await cancelStarted;

  const lateInit = await persistTbankInitSuccess(db, {
    orderId: claimed.order_id,
    attemptId: claimed.id,
    paymentId: "race-payment-id",
    paymentUrl: "https://pay.tbank.ru/new/racing-form-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: {
      Success: true,
      PaymentId: "race-payment-id",
      PaymentURL: "https://pay.tbank.ru/new/racing-form-token",
    },
  });
  assert.equal(lateInit.kind, "reconciling");
  assert.equal(
    state.externalPaymentId,
    "race-payment-id",
    "late Init binds only an identity candidate while reconciliation owns the attempt",
  );
  assert.equal(state.paymentUrl, null);

  releaseCancel();
  const reconciliationResult = await reconciliation;
  assert.equal(reconciliationResult?.kind, "pending");
  assert.equal(state.attemptStatus, "INIT_UNKNOWN");
  assert.equal(state.paymentUrl, null);
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);

  // A resumable webhook fact must not clear the durable Cancel quarantine.
  state.attemptStatus = "AUTH_FAIL";

  const postCancelLateInit = await persistTbankInitSuccess(db, {
    orderId: claimed.order_id,
    attemptId: claimed.id,
    paymentId: "race-payment-id",
    paymentUrl: "https://pay.tbank.ru/new/post-cancel-form-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: {
      Success: true,
      PaymentId: "race-payment-id",
      PaymentURL: "https://pay.tbank.ru/new/post-cancel-form-token",
    },
  });
  assert.equal(postCancelLateInit.kind, "reconciling");
  assert.equal(state.attemptStatus, "AUTH_FAIL");
  assert.equal(state.paymentUrl, null);

  const app = buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      TBANK_DEMO_TERMINAL_KEY: provider.terminalKey,
      TBANK_DEMO_PASSWORD: provider.password,
      CDEK_MOCK: "true",
    }),
    db,
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/payments",
    payload: {
      clientRequestId: claimed.order_id,
      accessToken,
      customer: {
        firstName: "Иван",
        lastName: "Иванов",
        phone: "+7 999 533-00-15",
        email: "ivan@example.com",
        legalConsent: true,
      },
      delivery: { code: "KOMUI-STAGE-PVZ", cityCode: 44 },
      items: [{ id: claimed.order_id, size: "M", qty: 1 }],
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "payment_reconciliation_pending");
  assert.doesNotMatch(response.body, /(?:racing|post-cancel)-form-token/);
  await app.close();
});

test("Init persistence records conflicting PaymentIds for manual review", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: "webhook-payment-id",
                  attempt_status: "AUTHORIZED",
                  order_status: "authorized",
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 83,
    paymentId: "init-payment-id",
    paymentUrl: "https://pay.tbank.ru/new/opaque-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: { Success: true, PaymentId: "init-payment-id" },
  });

  assert.equal(result.kind, "conflict");
  assert.equal(queries.length, 3);
  assert.equal(queries[1].params[1], "tbank_init_payment_id_conflict");
  assert.match(String(queries[2].params[1]), /webhook-payment-id/);
  assert.match(queries[2].sql, /then 'payment_review'/);
});

test("late Init PaymentId conflict after paid blocks fulfillment atomically", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let transactionActive = false;
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) => {
      transactionActive = true;
      try {
        return await callback({
          query: async (sql: string, params: unknown[] = []) => {
            queries.push({ sql, params });
            if (sql.includes("as attempt_status")) {
              return {
                rows: [
                  {
                    external_payment_id: "webhook-confirmed-payment",
                    attempt_status: "CONFIRMED",
                    order_status: "paid",
                  },
                ],
              };
            }
            if (
              sql.includes("update public.merch_customer_orders") &&
              sql.includes("returning status")
            ) {
              return { rows: [{ status: "payment_review" }] };
            }
            if (sql.includes("cdek_effect:enqueue")) {
              assert.equal(transactionActive, true);
              return {
                rows: [
                  {
                    id: 3,
                    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
                    effect_type: "cdek_cancel",
                    dedupe_key:
                      "cdek_cancel:7c169f01-b459-4e25-b74f-a4909a1b4149",
                    status: "pending",
                    payload: JSON.parse(String(params[3])),
                    attempts: 0,
                    locked_by: null,
                  },
                ],
              };
            }
            return { rows: [] };
          },
        });
      } finally {
        transactionActive = false;
      }
    },
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 93,
    paymentId: "late-init-payment",
    paymentUrl: "https://pay.tbank.ru/new/conflicting-form-token",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: {
      Success: true,
      PaymentId: "late-init-payment",
      PaymentURL: "https://pay.tbank.ru/new/conflicting-form-token",
    },
  });

  assert.deepEqual(result, {
    kind: "conflict",
    storedPaymentId: "webhook-confirmed-payment",
    receivedPaymentId: "late-init-payment",
    orderStatus: "payment_review",
  });
  const attemptUpdate = queries.find(({ sql }) =>
    sql.includes("update public.merch_payment_attempts"),
  );
  assert.ok(attemptUpdate);
  assert.match(attemptUpdate.sql, /provider_status = 'INIT_REVIEW'/);
  assert.match(attemptUpdate.sql, /payment_url = null/);
  assert.doesNotMatch(JSON.stringify(attemptUpdate.params), /conflicting-form-token/);
  const orderUpdate = queries.find(({ sql }) =>
    sql.includes("update public.merch_customer_orders"),
  );
  assert.ok(orderUpdate);
  assert.match(String(orderUpdate.params[1]), /payment_identity_conflict/);
  const cancelEffect = queries.find(({ sql }) =>
    sql.includes("cdek_effect:enqueue"),
  );
  assert.ok(cancelEffect);
  assert.equal(cancelEffect.params[0], "cdek_cancel");
  assert.deepEqual(JSON.parse(String(cancelEffect.params[3])), {
    source: "tbank_init",
    reason: "payment_identity_conflict",
    stored_payment_id: "webhook-confirmed-payment",
    received_payment_id: "late-init-payment",
    conflicting_attempt_id: null,
    conflicting_order_id: null,
  });
});

test("Init quarantines a PaymentId already owned by another local attempt", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("as attempt_status")) {
            return {
              rows: [
                {
                  external_payment_id: null,
                  attempt_status: "INITIATING",
                  order_status: "pending_payment",
                  response_payload: {},
                },
              ],
            };
          }
          if (sql.includes("tbank_payment_identity:lock")) {
            return { rows: [{ pg_advisory_xact_lock: null }] };
          }
          if (sql.includes("tbank_payment_identity:owner")) {
            return {
              rows: [
                {
                  id: 912,
                  order_id: "1acfe137-5826-49f7-b05b-7af476d1929d",
                },
              ],
            };
          }
          if (
            sql.includes("update public.merch_customer_orders") &&
            sql.includes("returning status")
          ) {
            return { rows: [{ status: "payment_review" }] };
          }
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await persistTbankInitSuccess(db, {
    orderId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    attemptId: 94,
    paymentId: "globally-owned-payment",
    paymentUrl: "https://pay.tbank.ru/new/must-not-leak",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: { TerminalKey: provider.terminalKey },
    responsePayload: {
      Success: true,
      PaymentId: "globally-owned-payment",
      PaymentURL: "https://pay.tbank.ru/new/must-not-leak",
    },
  });

  assert.equal(result.kind, "conflict");
  const quarantine = queries.find(
    ({ sql }) =>
      sql.includes("update public.merch_payment_attempts") &&
      sql.includes("provider_status = 'INIT_REVIEW'"),
  );
  assert.ok(quarantine);
  assert.equal(quarantine.params[1], "tbank_global_payment_id_conflict");
  assert.doesNotMatch(JSON.stringify(quarantine.params), /must-not-leak/);
  assert.equal(
    queries.some(({ sql }) => /set external_payment_id = coalesce/.test(sql)),
    false,
  );
  const review = queries.find(({ sql }) =>
    sql.includes("update public.merch_customer_orders"),
  );
  assert.ok(review);
  assert.match(String(review.params[1]), /payment_identity_conflict/);
  assert.match(String(review.params[1]), /1acfe137-5826-49f7-b05b-7af476d1929d/);
});

test("reconciliation claims attempts with a lease and SKIP LOCKED", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, params: unknown[] = []) => {
          sqlLog.push({ sql, params });
          return { rows: [] };
        },
      }),
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(
    db,
    provider,
    "7c169f01-b459-4e25-b74f-a4909a1b4149",
    {
      staleMs: 45_000,
      leaseMs: 90_000,
      intervalMs: 30_000,
      maxAttempts: 20,
    },
  );
  assert.equal(result, null);
  assert.match(sqlLog[0].sql, /for update of a, o skip locked/i);
  assert.match(sqlLog[0].sql, /a\.provider_status in \(/i);
  assert.match(sqlLog[0].sql, /a\.payment_url is null/i);
  assert.match(sqlLog[0].sql, /o\.total_amount as order_total_amount/i);
  assert.match(sqlLog[0].sql, /a\.terminal_key/i);
  assert.match(sqlLog[0].sql, /'FORM_SHOWED'/);
  assert.match(sqlLog[0].sql, /'AUTH_FAIL'/);
  assert.match(
    sqlLog[0].sql,
    /o\.status in \('created', 'pending_payment', 'payment_unknown'\)/i,
  );
  assert.deepEqual(sqlLog[0].params.slice(2), [45_000, 90_000]);
});

test("reconciliation rejects local amount or terminal boundary mismatches before provider I/O", async () => {
  const scenarios = [
    {
      name: "amount",
      amount: 290_000,
      orderTotalAmount: 300_000,
      terminalKey: provider.terminalKey,
      expectedCode: "tbank_local_amount_boundary_mismatch",
    },
    {
      name: "terminal",
      amount: 290_000,
      orderTotalAmount: 290_000,
      terminalKey: "retired-terminal",
      expectedCode: "tbank_terminal_boundary_mismatch",
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
    let claimReturned = false;
    let providerCalls = 0;
    const claimed = {
      id: 100 + index,
      order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
      order_number: `KOM-BOUNDARY-${index}`,
      amount: scenario.amount,
      order_total_amount: scenario.orderTotalAmount,
      terminal_key: scenario.terminalKey,
      external_payment_id: null,
      reconciliation_attempts: 0,
    };
    const query = async (sql: string, params: unknown[] = []) => {
      sqlLog.push({ sql, params });
      if (sql.includes("select\n          a.id") && !claimReturned) {
        claimReturned = true;
        return { rows: [{ ...claimed }] };
      }
      return { rows: [] };
    };
    const db = {
      query,
      withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
        callback({ query }),
    } as unknown as Db;

    const result = await reconcileTbankInitForOrder(
      db,
      provider,
      claimed.order_id,
      {
        staleMs: 1,
        leaseMs: 60_000,
        intervalMs: 30_000,
        maxAttempts: 20,
        fetchImpl: (async () => {
          providerCalls += 1;
          throw new Error("provider must not be called");
        }) as typeof fetch,
      },
    );

    assert.equal(result, null, scenario.name);
    assert.equal(providerCalls, 0, scenario.name);
    const attemptReview = sqlLog.find(
      ({ sql }) =>
        sql.includes("update public.merch_payment_attempts") &&
        sql.includes("provider_status = 'INIT_REVIEW'"),
    );
    assert.ok(attemptReview, scenario.name);
    assert.equal(attemptReview.params[1], scenario.expectedCode, scenario.name);
    const orderReview = sqlLog.find(
      ({ sql }) =>
        sql.includes("update public.merch_customer_orders") &&
        sql.includes("set status = 'payment_review'"),
    );
    assert.ok(orderReview, scenario.name);
    assert.match(String(orderReview.params[1]), new RegExp(scenario.expectedCode));
  }
});

test("reconciliation rechecks the locked order amount before projecting CONFIRMED", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 102,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-LOCKED-BOUNDARY",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  let claimReturned = false;
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id") && !claimReturned) {
      claimReturned = true;
      return { rows: [{ ...claimed }] };
    }
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            external_payment_id: null,
            reconciliation_attempts: 1,
            attempt_amount: 290_000,
            order_total_amount: 300_000,
            terminal_key: provider.terminalKey,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    query,
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "locked-boundary-payment",
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "locked-boundary-payment",
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "review");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_local_amount_boundary_mismatch",
  );
  assert.equal(
    sqlLog.some(({ sql }) => sql.includes("cdek_effect:enqueue")),
    false,
  );
  assert.equal(
    sqlLog.some(
      ({ sql }) =>
        sql.includes("update public.merch_customer_orders") &&
        sql.includes("returning id"),
    ),
    false,
  );
});

test("confirmed reconciliation atomically enqueues fulfillment and order email", async () => {
  const sqlLog: string[] = [];
  const claimed = {
    id: 51,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-523456789",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string) => {
    sqlLog.push(sql);
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            external_payment_id: null,
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (sql.includes("returning id") && sql.includes("merch_customer_orders")) {
      return { rows: [{ id: claimed.order_id }] };
    }
    if (sql.includes("cdek_effect:enqueue")) {
      return {
        rows: [
          {
            id: 1,
            order_id: claimed.order_id,
            effect_type: "cdek_create",
            dedupe_key: `cdek_create:${claimed.order_id}`,
            status: "pending",
            payload: {},
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;
  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "95234567",
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "95234567",
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "processed");
  assert.equal(result?.providerStatus, "CONFIRMED");
  assert.equal(sqlLog.some((sql) => sql.includes("set status = 'redeemed'")), true);
  assert.equal(sqlLog.some((sql) => sql.includes("cdek_effect:enqueue")), true);
  assert.equal(
    sqlLog.some((sql) => sql.includes("email_outbox:enqueue_order_paid")),
    true,
  );
});

test("direct PARTIAL_REFUNDED reconciliation keeps an unpaid order in payment_review", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 55,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-553456789",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            external_payment_id: null,
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (sql.includes("returning id") && sql.includes("merch_customer_orders")) {
      return { rows: [{ id: claimed.order_id }] };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;
  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "95534567",
              Amount: claimed.amount,
              Status: "PARTIAL_REFUNDED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "95534567",
          Amount: claimed.amount,
          Status: "PARTIAL_REFUNDED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "processed");
  assert.equal(result?.providerStatus, "PARTIAL_REFUNDED");
  const orderUpdate = sqlLog.find(
    ({ sql }) =>
      sql.includes("update public.merch_customer_orders") &&
      sql.includes("returning id"),
  );
  assert.ok(orderUpdate);
  assert.equal(orderUpdate.params[1], "payment_review");
  assert.equal(
    sqlLog.some(({ sql }) => sql.includes("cdek_effect:enqueue")),
    false,
  );
});

test("PARTIAL_REVERSED reconciliation persists review and queues a causal cancellation", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 56,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-563456789",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            external_payment_id: null,
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (sql.includes("returning id") && sql.includes("merch_customer_orders")) {
      return { rows: [{ id: claimed.order_id }] };
    }
    if (sql.includes("cdek_effect:enqueue")) {
      return {
        rows: [
          {
            id: 2,
            order_id: claimed.order_id,
            effect_type: "cdek_cancel",
            dedupe_key: `cdek_cancel:${claimed.order_id}`,
            status: "pending",
            payload: JSON.parse(String(params[3])),
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "95634567",
              Amount: claimed.amount,
              Status: "PARTIAL_REVERSED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "95634567",
          Amount: claimed.amount,
          Status: "PARTIAL_REVERSED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "review");
  assert.equal(result?.providerStatus, "PARTIAL_REVERSED");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_partial_reversal_requires_review",
  );
  const orderUpdate = sqlLog.find(
    ({ sql }) =>
      sql.includes("update public.merch_customer_orders") &&
      sql.includes("returning id"),
  );
  assert.ok(orderUpdate);
  assert.equal(orderUpdate.params[1], "payment_review");
  const cancelEffect = sqlLog.find(({ sql }) =>
    sql.includes("cdek_effect:enqueue"),
  );
  assert.ok(cancelEffect);
  assert.equal(cancelEffect.params[0], "cdek_cancel");
  assert.deepEqual(JSON.parse(String(cancelEffect.params[3])), {
    source: "tbank_init_reconciliation",
    providerStatus: "PARTIAL_REVERSED",
    paymentId: "95634567",
    reason: "partial_reversed",
  });
});

test("confirmed reconciliation respects disabled CDEK shipment creation", async () => {
  const sqlLog: string[] = [];
  const claimed = {
    id: 53,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-533456789",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string) => {
    sqlLog.push(sql);
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            external_payment_id: null,
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (sql.includes("returning id") && sql.includes("merch_customer_orders")) {
      return { rows: [{ id: claimed.order_id }] };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    createCdekShipments: false,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "95334567",
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "95334567",
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "processed");
  assert.equal(sqlLog.some((sql) => sql.includes("set status = 'redeemed'")), true);
  assert.equal(sqlLog.some((sql) => sql.includes("cdek_effect:enqueue")), false);
});

test("a concurrent CONFIRMED webhook supersedes a stale failed reconciliation", async () => {
  const sqlLog: string[] = [];
  const claimed = {
    id: 52,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-623456789",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string) => {
    sqlLog.push(sql);
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "CONFIRMED",
            order_status: "paid",
            external_payment_id: "96234567",
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "96234567",
              Amount: claimed.amount,
              Status: "CANCELED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "96234567",
          Amount: claimed.amount,
          Status: "CANCELED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.deepEqual(result, {
    kind: "superseded",
    paymentId: "96234567",
    providerStatus: "CONFIRMED",
    orderStatus: "paid",
    orderId: claimed.order_id,
    orderNumber: claimed.order_number,
  });
  assert.equal(
    sqlLog.some((sql) => /provider_status = case when/.test(sql)),
    false,
  );
});

test("Cancel timeout racing a CONFIRMED webhook quarantines fulfillment", async () => {
  const { result, sqlLog, effects } = await runCancelVsConfirmedWebhookRace(
    "timeout",
  );

  assert.equal(result?.kind, "review");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_cancel_payment_state_conflict",
  );
  assert.deepEqual(effects, ["cdek_create", "cdek_cancel"]);
  const markerUpdate = sqlLog.find(
    ({ sql, params }) =>
      sql.includes("set payment_url = null") &&
      String(params[1]).includes("tbank_cancel_attempted"),
  );
  assert.ok(markerUpdate);
  const orderUpdate = sqlLog.find(({ sql }) => sql.includes("returning status"));
  assert.ok(orderUpdate);
  assert.equal(
    (JSON.parse(String(orderUpdate.params[1])) as Record<string, unknown>)
      .payment_review_reason,
    "payment_state_conflict",
  );
  const cancelEffect = sqlLog.find(({ sql }) =>
    sql.includes("cdek_effect:enqueue"),
  );
  assert.ok(cancelEffect);
  assert.equal(
    (JSON.parse(String(cancelEffect.params[3])) as Record<string, unknown>).reason,
    "payment_state_conflict",
  );
});

test("Cancel REVERSED racing a CONFIRMED webhook quarantines fulfillment", async () => {
  const { result, sqlLog, effects } = await runCancelVsConfirmedWebhookRace(
    "reversed",
  );

  assert.equal(result?.kind, "review");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_cancel_payment_state_conflict",
  );
  assert.deepEqual(effects, ["cdek_create", "cdek_cancel"]);
  const cancelEffect = sqlLog.find(({ sql }) =>
    sql.includes("cdek_effect:enqueue"),
  );
  assert.ok(cancelEffect);
  assert.equal(
    (JSON.parse(String(cancelEffect.params[3])) as Record<string, unknown>)
      .cancel_provider_status,
    "REVERSED",
  );
});

test("a paused Cancel timeout preserves its marker across a signed AUTH_FAIL webhook", async () => {
  const { db, state, claimed, reconciliationResult } =
    await runSignedWebhookDuringPausedCancel("AUTH_FAIL");

  assert.equal(reconciliationResult?.kind, "superseded");
  assert.equal(state.attemptStatus, "AUTH_FAIL");
  assert.equal(state.orderStatus, "payment_unknown");
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.deepEqual(state.effects, []);

  const lateInit = await persistTbankInitSuccess(db, {
    orderId: claimed.order_id,
    attemptId: claimed.id,
    paymentId: claimed.external_payment_id,
    paymentUrl: "https://pay.tbank.ru/new/cancel-race-must-not-leak",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: {
      TerminalKey: provider.terminalKey,
      OrderId: claimed.order_number,
      Amount: claimed.amount,
    },
    responsePayload: {
      TerminalKey: provider.terminalKey,
      OrderId: claimed.order_number,
      Amount: claimed.amount,
      PaymentId: claimed.external_payment_id,
      PaymentURL: "https://pay.tbank.ru/new/cancel-race-must-not-leak",
      Status: "NEW",
      Success: true,
    },
  });

  assert.equal(lateInit.kind, "reconciling");
  assert.equal(state.paymentUrl, null);
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.doesNotMatch(JSON.stringify(state.responsePayload), /must-not-leak/);
});

test("a paused Cancel timeout quarantines a signed CONFIRMED webhook fulfillment", async () => {
  const { state, reconciliationResult } =
    await runSignedWebhookDuringPausedCancel("CONFIRMED");

  assert.equal(reconciliationResult?.kind, "superseded");
  assert.equal(state.attemptStatus, "INIT_REVIEW");
  assert.equal(state.orderStatus, "payment_review");
  assert.equal(
    state.orderMetadata.payment_review_reason,
    "payment_state_conflict",
  );
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.deepEqual(
    state.effects.map((effect) => effect.type),
    ["cdek_cancel"],
  );
  assert.equal(state.effects[0]?.payload.reason, "payment_state_conflict");
});

test("a durable pre-Cancel intent survives a killed worker and blocks fulfillment", async () => {
  const { state, reconciliationResult } =
    await runSignedWebhookDuringPausedCancel("CONFIRMED", {
      abandonAfterWebhook: true,
    });

  // The provider request is intentionally left unresolved: this models a
  // process dying after sending Cancel but before post-HTTP persistence.
  assert.equal(reconciliationResult, null);
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.equal(state.paymentUrl, null);
  assert.equal(
    typeof state.responsePayload.tbank_cancel_intent,
    "object",
  );
  assert.equal(state.attemptStatus, "INIT_REVIEW");
  assert.equal(state.orderStatus, "payment_review");
  assert.equal(
    state.orderMetadata.payment_review_reason,
    "payment_state_conflict",
  );
  assert.deepEqual(
    state.effects.map((effect) => effect.type),
    ["cdek_cancel"],
  );
  assert.equal(state.effects[0]?.payload.reason, "payment_state_conflict");
});

test("a persisted Cancel timeout marker blocks a later signed CONFIRMED webhook", async () => {
  const { db, state, claimed, reconciliationResult } =
    await runSignedWebhookDuringPausedCancel(null);

  assert.equal(reconciliationResult?.kind, "pending");
  assert.equal(state.attemptStatus, "INIT_UNKNOWN");
  assert.equal(state.orderStatus, "payment_unknown");
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: provider.terminalKey,
    TBANK_DEMO_PASSWORD: provider.password,
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedWebhook = {
    TerminalKey: provider.terminalKey,
    OrderId: claimed.order_number,
    Success: true,
    Status: "CONFIRMED",
    PaymentId: claimed.external_payment_id,
    ErrorCode: "0",
    Amount: claimed.amount,
  };
  const webhookResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedWebhook,
      Token: createTbankToken(unsignedWebhook, provider.password),
    },
  });

  assert.equal(webhookResponse.statusCode, 200);
  assert.equal(state.attemptStatus, "INIT_REVIEW");
  assert.equal(state.orderStatus, "payment_review");
  assert.equal(
    state.orderMetadata.payment_review_reason,
    "payment_state_conflict",
  );
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.deepEqual(
    state.effects.map((effect) => effect.type),
    ["cdek_cancel"],
  );
  assert.equal(state.effects[0]?.payload.reason, "payment_state_conflict");
  await app.close();
});

test("a stale Cancel marker survives a newer pending reconciliation lease", async () => {
  const { db, state, claimed, reconciliationResult, secondLeaseResult } =
    await runSignedWebhookDuringPausedCancel(null, {
      advanceSecondLease: true,
    });

  assert.equal(secondLeaseResult?.kind, "pending");
  assert.equal(reconciliationResult?.kind, "superseded");
  assert.equal(state.reconciliationAttempts, 2);
  assert.equal(state.attemptStatus, "INIT_UNKNOWN");
  assert.equal(state.orderStatus, "payment_unknown");
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);

  const lateInit = await persistTbankInitSuccess(db, {
    orderId: claimed.order_id,
    attemptId: claimed.id,
    paymentId: claimed.external_payment_id,
    paymentUrl: "https://pay.tbank.ru/new/two-lease-must-not-leak",
    providerStatus: "NEW",
    errorCode: null,
    errorMessage: null,
    requestPayload: {
      TerminalKey: provider.terminalKey,
      OrderId: claimed.order_number,
      Amount: claimed.amount,
    },
    responsePayload: {
      TerminalKey: provider.terminalKey,
      OrderId: claimed.order_number,
      Amount: claimed.amount,
      PaymentId: claimed.external_payment_id,
      PaymentURL: "https://pay.tbank.ru/new/two-lease-must-not-leak",
      Status: "NEW",
      Success: true,
    },
  });

  assert.equal(lateInit.kind, "reconciling");
  assert.equal(state.attemptStatus, "INIT_UNKNOWN");
  assert.equal(state.paymentUrl, null);
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.doesNotMatch(JSON.stringify(state.responsePayload), /two-lease-must-not-leak/);
});

test("a stale Cancel quarantines fulfillment created after a newer lease", async () => {
  const { state, reconciliationResult, secondLeaseResult } =
    await runSignedWebhookDuringPausedCancel("CONFIRMED", {
      advanceSecondLease: true,
    });

  assert.equal(secondLeaseResult?.kind, "pending");
  assert.equal(reconciliationResult?.kind, "superseded");
  assert.equal(state.reconciliationAttempts, 2);
  assert.equal(state.attemptStatus, "INIT_REVIEW");
  assert.equal(state.orderStatus, "payment_review");
  assert.equal(
    state.orderMetadata.payment_review_reason,
    "payment_state_conflict",
  );
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.deepEqual(
    state.effects.map((effect) => effect.type),
    ["cdek_cancel"],
  );
  assert.equal(state.effects[0]?.payload.reason, "payment_state_conflict");
});

test("a newer lease cannot fulfill after an older lease persists its Cancel marker", async () => {
  const { state, reconciliationResult, secondLeaseResult } =
    await runSignedWebhookDuringPausedCancel(null, {
      advanceSecondLease: true,
      pauseSecondConfirmed: true,
    });

  assert.equal(reconciliationResult?.kind, "superseded");
  assert.equal(secondLeaseResult?.kind, "review");
  assert.equal(
    secondLeaseResult?.kind === "review" ? secondLeaseResult.errorCode : null,
    "tbank_cancel_payment_state_conflict",
  );
  assert.equal(state.reconciliationAttempts, 2);
  assert.equal(state.attemptStatus, "INIT_REVIEW");
  assert.equal(state.orderStatus, "payment_review");
  assert.equal(
    state.orderMetadata.payment_review_reason,
    "payment_state_conflict",
  );
  assert.equal(state.responsePayload.tbank_cancel_attempted, true);
  assert.deepEqual(
    state.effects.map((effect) => effect.type),
    ["cdek_cancel"],
  );
  assert.equal(state.effects[0]?.payload.reason, "payment_state_conflict");
});

test("same-ID REFUNDED reconciliation outranks a concurrent CONFIRMED webhook and cancels fulfillment", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 57,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-REFUND-RACE",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "CONFIRMED",
            order_status: "paid",
            external_payment_id: "same-race-payment",
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (sql.includes("returning id") && sql.includes("merch_customer_orders")) {
      return { rows: [{ id: claimed.order_id }] };
    }
    if (sql.includes("cdek_effect:enqueue")) {
      return {
        rows: [
          {
            id: 7,
            order_id: claimed.order_id,
            effect_type: "cdek_cancel",
            dedupe_key: `cdek_cancel:${claimed.order_id}`,
            status: "pending",
            payload: JSON.parse(String(params[3])),
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "same-race-payment",
              Amount: claimed.amount,
              Status: "REFUNDED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "same-race-payment",
          Amount: claimed.amount,
          Status: "REFUNDED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "processed");
  assert.equal(result?.providerStatus, "REFUNDED");
  const attemptUpdate = sqlLog.find(({ sql }) =>
    /provider_status = case when/.test(sql),
  );
  assert.ok(attemptUpdate);
  assert.equal(attemptUpdate.params[2], true);
  assert.equal(attemptUpdate.params[3], "REFUNDED");
  const orderUpdate = sqlLog.find(
    ({ sql }) =>
      sql.includes("update public.merch_customer_orders") &&
      sql.includes("returning id"),
  );
  assert.equal(orderUpdate?.params[1], "refunded");
  const cancel = sqlLog.find(({ sql }) => sql.includes("cdek_effect:enqueue"));
  assert.ok(cancel);
  assert.equal(cancel.params[0], "cdek_cancel");
});

test("a concurrent webhook PaymentId conflict is quarantined after provider I/O", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 58,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-IDENTITY-RACE",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "CONFIRMED",
            order_status: "paid",
            external_payment_id: "webhook-payment-B",
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (
      sql.includes("update public.merch_customer_orders") &&
      sql.includes("returning status")
    ) {
      return { rows: [{ status: "payment_review" }] };
    }
    if (sql.includes("cdek_effect:enqueue")) {
      return {
        rows: [
          {
            id: 8,
            order_id: claimed.order_id,
            effect_type: "cdek_cancel",
            dedupe_key: `cdek_cancel:${claimed.order_id}`,
            status: "pending",
            payload: JSON.parse(String(params[3])),
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "reconciled-payment-A",
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "reconciled-payment-A",
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "review");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_reconciliation_payment_id_conflict",
  );
  const reviewUpdate = sqlLog.find(
    ({ sql }) =>
      sql.includes("update public.merch_payment_attempts") &&
      sql.includes("provider_status = 'INIT_REVIEW'"),
  );
  assert.ok(reviewUpdate);
  const cancel = sqlLog.find(({ sql }) => sql.includes("cdek_effect:enqueue"));
  assert.ok(cancel);
  assert.equal(
    (JSON.parse(String(cancel.params[3])) as Record<string, unknown>).reason,
    "payment_identity_conflict",
  );
});

test("a concurrent provider ambiguity quarantines an already paid webhook result", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 59,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-AMBIGUITY-RACE",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "CONFIRMED",
            order_status: "paid",
            external_payment_id: "ambiguous-payment",
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (
      sql.includes("update public.merch_customer_orders") &&
      sql.includes("returning status")
    ) {
      return { rows: [{ status: "payment_review" }] };
    }
    if (sql.includes("cdek_effect:enqueue")) {
      return {
        rows: [
          {
            id: 9,
            order_id: claimed.order_id,
            effect_type: "cdek_cancel",
            dedupe_key: `cdek_cancel:${claimed.order_id}`,
            status: "pending",
            payload: JSON.parse(String(params[3])),
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "ambiguous-payment",
              Amount: claimed.amount,
              Status: "NEW",
              Success: true,
            },
            {
              PaymentId: "ambiguous-payment",
              Amount: claimed.amount,
              Status: "REJECTED",
              Success: true,
            },
          ],
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "review");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_duplicate_payment_conflict",
  );
  const cancel = sqlLog.find(({ sql }) => sql.includes("cdek_effect:enqueue"));
  assert.ok(cancel);
  assert.equal(
    (JSON.parse(String(cancel.params[3])) as Record<string, unknown>).reason,
    "payment_identity_conflict",
  );
});

test("reconciliation cannot project lower-rank CONFIRMED over a concurrent PARTIAL_REFUNDED", async () => {
  const sqlLog: string[] = [];
  const claimed = {
    id: 56,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-653456789",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string) => {
    sqlLog.push(sql);
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "PARTIAL_REFUNDED",
            order_status: "payment_review",
            external_payment_id: "96534567",
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "96534567",
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "96534567",
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.deepEqual(result, {
    kind: "superseded",
    paymentId: "96534567",
    providerStatus: "PARTIAL_REFUNDED",
    orderStatus: "payment_review",
    orderId: claimed.order_id,
    orderNumber: claimed.order_number,
  });
  assert.equal(
    sqlLog.some((sql) => /provider_status = case when/.test(sql)),
    false,
  );
  assert.equal(
    sqlLog.some(
      (sql) =>
        sql.includes("update public.merch_customer_orders") &&
        sql.includes("returning id"),
    ),
    false,
  );
  assert.equal(sqlLog.some((sql) => sql.includes("cdek_effect:enqueue")), false);
});

test("active lease rejects a PaymentId concurrently bound by Init to another payment", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 54,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-723456789",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            external_payment_id: "payment-from-init-B",
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "payment-from-check-order-A",
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "payment-from-check-order-A",
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "review");
  assert.equal(result?.paymentId, "payment-from-init-B");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_reconciliation_payment_id_conflict",
  );
  assert.equal(
    sqlLog.some(({ sql }) => /provider_status = case when/.test(sql)),
    false,
  );
  assert.equal(
    sqlLog.some(({ sql }) => sql.includes("cdek_effect:enqueue")),
    false,
  );
  const reviewUpdate = sqlLog.find(
    ({ sql }) => /metadata = metadata \|\| \$2::jsonb/.test(sql),
  );
  assert.ok(reviewUpdate);
  assert.match(String(reviewUpdate.params[1]), /payment-from-init-B/);
  assert.match(String(reviewUpdate.params[1]), /payment-from-check-order-A/);
});

test("reconciliation never binds a PaymentId already owned by another local attempt", async () => {
  const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = {
    id: 60,
    order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    order_number: "KOM-GLOBAL-OWNER",
    amount: 290_000,
    order_total_amount: 290_000,
    terminal_key: provider.terminalKey,
    external_payment_id: null,
    reconciliation_attempts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    sqlLog.push({ sql, params });
    if (sql.includes("select\n          a.id")) return { rows: [{ ...claimed }] };
    if (sql.includes("as attempt_status")) {
      return {
        rows: [
          {
            attempt_status: "RECONCILING_INIT",
            order_status: "payment_unknown",
            external_payment_id: null,
            reconciliation_attempts: 1,
            attempt_amount: claimed.amount,
            order_total_amount: claimed.order_total_amount,
            terminal_key: claimed.terminal_key,
          },
        ],
      };
    }
    if (sql.includes("tbank_payment_identity:lock")) {
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (sql.includes("tbank_payment_identity:owner")) {
      return {
        rows: [
          {
            id: 991,
            order_id: "1acfe137-5826-49f7-b05b-7af476d1929d",
          },
        ],
      };
    }
    if (
      sql.includes("update public.merch_customer_orders") &&
      sql.includes("returning status")
    ) {
      return { rows: [{ status: "payment_review" }] };
    }
    return { rows: [] };
  };
  const db = {
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ query }),
    query,
  } as unknown as Db;

  const result = await reconcileTbankInitForOrder(db, provider, claimed.order_id, {
    staleMs: 1,
    leaseMs: 60_000,
    intervalMs: 30_000,
    maxAttempts: 20,
    fetchImpl: providerFetch(
      {
        CheckOrder: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          Success: true,
          Payments: [
            {
              PaymentId: "globally-owned-provider-payment",
              Amount: claimed.amount,
              Status: "CONFIRMED",
              Success: true,
            },
          ],
        },
        GetState: {
          TerminalKey: provider.terminalKey,
          OrderId: claimed.order_number,
          PaymentId: "globally-owned-provider-payment",
          Amount: claimed.amount,
          Status: "CONFIRMED",
          Success: true,
          ErrorCode: "0",
        },
      },
      [],
    ),
  });

  assert.equal(result?.kind, "review");
  assert.equal(
    result?.kind === "review" ? result.errorCode : null,
    "tbank_reconciliation_payment_id_conflict",
  );
  assert.equal(
    sqlLog.some(({ sql }) => /set external_payment_id = coalesce/.test(sql)),
    false,
  );
  const quarantine = sqlLog.find(
    ({ sql }) =>
      sql.includes("update public.merch_payment_attempts") &&
      sql.includes("provider_status = 'INIT_REVIEW'"),
  );
  assert.ok(quarantine);
  assert.match(String(quarantine.params[3]), /1acfe137-5826-49f7-b05b-7af476d1929d/);
});

test("background reconciler is inert in NODE_ENV=test", async () => {
  let queried = false;
  const db = {
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  } as unknown as Db;
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "test-terminal",
    TBANK_DEMO_PASSWORD: "test-password",
  });
  const stop = startTbankInitReconciler(config, db, {});
  await stop();
  assert.equal(queried, false);
});
