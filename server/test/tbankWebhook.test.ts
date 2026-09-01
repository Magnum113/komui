import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  createTbankToken,
  sanitizedTbankPayload,
  sha256Hex,
} from "../src/crypto";
import type { Db } from "../src/db";
import {
  canApplyTbankOrderProjection,
  canApplyTbankOrderStatus,
  processTbankWebhookEvent,
  shouldApplyTbankProviderStatus,
  TbankWebhookOrderMismatchError,
  tbankOrderStatus,
  tbankOrderStatusForCurrentOrder,
  type TbankWebhookEventInput,
} from "../src/tbankWebhook";

const orderId = "7c169f01-b459-4e25-b74f-a4909a1b4149";

type FakeState = {
  order: {
    id: string;
    order_number: string;
    total_amount: number;
    status: string;
    paid_at: string | null;
    metadata: Record<string, unknown>;
  };
  attempt: {
    id: number;
    order_id: string;
    amount: number;
    external_payment_id: string | null;
    provider_status: string;
    terminal_key: string;
    payment_url: string | null;
    error_code: string | null;
    error_message: string | null;
    response_payload: Record<string, unknown>;
  };
  eventHashes: Map<string, number>;
  nextEventId: number;
  promoRedeemed: number;
  promoReleased: number;
  orderUpdates: number;
  attemptUpdates: number;
  cdekEffects: string[];
  cdekEffectPayloads: Array<Record<string, unknown>>;
  emailOutbox: string[];
  emailOutboxContexts: Array<Record<string, unknown>>;
  queryLog: string[];
  transactionActive: boolean;
};

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function fakeDb(overrides: {
  orderStatus?: string;
  providerStatus?: string;
  paymentId?: string | null;
  attemptAmount?: number;
  terminalKey?: string;
  responsePayload?: Record<string, unknown>;
  orderMetadata?: Record<string, unknown>;
  identityOwner?: { id: number; order_id: string } | null;
} = {}) {
  const state: FakeState = {
    order: {
      id: orderId,
      order_number: "KOM-TEST-1",
      total_amount: 300_000,
      status: overrides.orderStatus ?? "pending_payment",
      paid_at: null,
      metadata: overrides.orderMetadata ?? {},
    },
    attempt: {
      id: 17,
      order_id: orderId,
      amount: overrides.attemptAmount ?? 300_000,
      external_payment_id:
        overrides.paymentId === undefined ? "payment-1" : overrides.paymentId,
      provider_status: overrides.providerStatus ?? "NEW",
      terminal_key: overrides.terminalKey ?? "demo-terminal",
      payment_url: "https://pay.tbank.ru/new/existing-form",
      error_code: null,
      error_message: null,
      response_payload: overrides.responsePayload ?? {},
    },
    eventHashes: new Map(),
    nextEventId: 1,
    promoRedeemed: 0,
    promoReleased: 0,
    orderUpdates: 0,
    attemptUpdates: 0,
    cdekEffects: [],
    cdekEffectPayloads: [],
    emailOutbox: [],
    emailOutboxContexts: [],
    queryLog: [],
    transactionActive: false,
  };

  let transactionTail = Promise.resolve();
  const query = async (sql: string, values: unknown[] = []) => {
    const normalized = compactSql(sql);
    state.queryLog.push(normalized);

    if (normalized.includes("/* tbank_payment_identity:lock */")) {
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (normalized.includes("/* tbank_payment_identity:owner */")) {
      return { rows: overrides.identityOwner ? [overrides.identityOwner] : [] };
    }

    if (
      normalized.startsWith("select id, order_id from public.merch_payment_attempts") &&
      normalized.includes("external_payment_id = $1")
    ) {
      return {
        rows:
          state.attempt.external_payment_id === values[0]
            ? [{ id: state.attempt.id, order_id: state.attempt.order_id }]
            : [],
      };
    }
    if (
      normalized.startsWith("select id from public.merch_customer_orders")
    ) {
      return {
        rows:
          values[0] === state.order.order_number
            ? [{ id: state.order.id }]
            : [],
      };
    }
    if (
      normalized.startsWith("select id, order_id from public.merch_payment_attempts") &&
      normalized.includes("where order_id = $1::uuid")
    ) {
      return {
        rows:
          values[0] === state.attempt.order_id
            ? [{ id: state.attempt.id, order_id: state.attempt.order_id }]
            : [],
      };
    }
    if (
      normalized.startsWith(
        "select id, order_number, total_amount, status, paid_at from public.merch_customer_orders",
      )
    ) {
      const matches =
        normalized.includes("where id =")
          ? values[0] === state.order.id
          : values[0] === state.order.order_number;
      return { rows: matches ? [{ ...state.order }] : [] };
    }
    if (
      normalized.startsWith(
        "select id, order_id, amount, external_payment_id, provider_status, terminal_key, response_payload from public.merch_payment_attempts",
      )
    ) {
      const matches = normalized.includes("where id =")
        ? values[0] === state.attempt.id
        : values[0] === state.attempt.order_id;
      return { rows: matches ? [{ ...state.attempt }] : [] };
    }
    if (normalized.startsWith("insert into public.merch_payment_events")) {
      const eventHash = String(values[4]);
      if (state.eventHashes.has(eventHash)) return { rows: [] };
      const id = state.nextEventId++;
      state.eventHashes.set(eventHash, id);
      return { rows: [{ id }] };
    }
    if (normalized.startsWith("select id, order_id, payment_attempt_id")) {
      const id = state.eventHashes.get(String(values[0]));
      return {
        rows: id
          ? [{ id, order_id: state.order.id, payment_attempt_id: state.attempt.id }]
          : [],
      };
    }
    if (normalized.startsWith("update public.merch_payment_attempts")) {
      state.attemptUpdates += 1;
      if (normalized.includes("set provider_status = 'init_review'")) {
        const audit = JSON.parse(String(values[3])) as Record<string, unknown>;
        state.attempt.provider_status = "INIT_REVIEW";
        state.attempt.payment_url = null;
        if (!state.attempt.error_code) {
          state.attempt.error_code = String(values[1]);
          state.attempt.error_message = String(values[2]);
        }
        if (!("payment_review_quarantine" in state.attempt.response_payload)) {
          state.attempt.response_payload = {
            ...state.attempt.response_payload,
            ...audit,
          };
        }
        return { rows: [] };
      }
      if (
        normalized.includes("external_payment_id = coalesce(external_payment_id, $2)") &&
        !state.attempt.external_payment_id &&
        values[1]
      ) {
        state.attempt.external_payment_id = String(values[1]);
      }
      if (values[2] === true) state.attempt.provider_status = String(values[3]);
      return { rows: [] };
    }
    if (normalized.startsWith("update public.merch_customer_orders")) {
      if (
        normalized.includes("set metadata = metadata || $2::jsonb") &&
        normalized.includes("status = 'payment_review'")
      ) {
        state.order.metadata = {
          ...state.order.metadata,
          ...(JSON.parse(String(values[1])) as Record<string, unknown>),
        };
        return { rows: [] };
      }
      assert.equal(values[3], state.order.status, "compare-and-set uses locked status");
      state.orderUpdates += 1;
      state.order.status = String(values[1]);
      state.order.metadata = {
        ...state.order.metadata,
        ...(JSON.parse(String(values[2])) as Record<string, unknown>),
      };
      if (state.order.status === "paid" && !state.order.paid_at) {
        state.order.paid_at = new Date().toISOString();
      }
      return { rows: [] };
    }
    if (normalized.startsWith("update public.merch_promo_redemptions")) {
      if (normalized.includes("set status = 'redeemed'")) state.promoRedeemed += 1;
      else state.promoReleased += 1;
      return { rows: [] };
    }
    if (normalized.includes("/* cdek_effect:enqueue */")) {
      assert.equal(state.transactionActive, true, "CDEK effect is in payment transaction");
      const payload = JSON.parse(String(values[3])) as Record<string, unknown>;
      state.cdekEffects.push(String(values[0]));
      state.cdekEffectPayloads.push(payload);
      return {
        rows: [
          {
            id: state.cdekEffects.length,
            order_id: state.order.id,
            effect_type: values[0],
            dedupe_key: `${values[0]}:${state.order.id}`,
            status: "pending",
            payload,
            attempts: 0,
            locked_by: null,
          },
        ],
      };
    }
    if (normalized.includes("/* email_outbox:enqueue_order_paid */")) {
      assert.equal(state.transactionActive, true, "email intent is in payment transaction");
      if (state.emailOutbox.includes(state.order.id)) return { rows: [] };
      state.emailOutbox.push(state.order.id);
      state.emailOutboxContexts.push(
        JSON.parse(String(values[1])) as Record<string, unknown>,
      );
      return {
        rows: [
          {
            id: "5d703bc3-028f-4c4e-bf87-130c8294b991",
            order_id: state.order.id,
            idempotency_key: `order-paid:${state.order.id}`,
            status: "pending",
          },
        ],
      };
    }
    throw new Error(`Unexpected SQL in fake DB: ${normalized}`);
  };

  const db = {
    query,
    withTransaction: async <T>(callback: (client: PoolClient) => Promise<T>) => {
      const previous = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previous;
      state.transactionActive = true;
      const snapshot = {
        order: { ...state.order },
        attempt: { ...state.attempt },
        eventHashes: new Map(state.eventHashes),
        nextEventId: state.nextEventId,
        promoRedeemed: state.promoRedeemed,
        promoReleased: state.promoReleased,
        orderUpdates: state.orderUpdates,
        attemptUpdates: state.attemptUpdates,
        cdekEffects: [...state.cdekEffects],
        cdekEffectPayloads: state.cdekEffectPayloads.map((payload) => ({
          ...payload,
        })),
        emailOutbox: [...state.emailOutbox],
        emailOutboxContexts: state.emailOutboxContexts.map((payload) => ({
          ...payload,
        })),
      };
      try {
        return await callback({ query } as unknown as PoolClient);
      } catch (error) {
        state.order = snapshot.order;
        state.attempt = snapshot.attempt;
        state.eventHashes = snapshot.eventHashes;
        state.nextEventId = snapshot.nextEventId;
        state.promoRedeemed = snapshot.promoRedeemed;
        state.promoReleased = snapshot.promoReleased;
        state.orderUpdates = snapshot.orderUpdates;
        state.attemptUpdates = snapshot.attemptUpdates;
        state.cdekEffects = snapshot.cdekEffects;
        state.cdekEffectPayloads = snapshot.cdekEffectPayloads;
        state.emailOutbox = snapshot.emailOutbox;
        state.emailOutboxContexts = snapshot.emailOutboxContexts;
        throw error;
      } finally {
        state.transactionActive = false;
        releaseTransaction();
      }
    },
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;

  return { db, state };
}

function webhookEvent(
  providerStatus: string,
  eventHash: string,
  overrides: Partial<TbankWebhookEventInput> = {},
): TbankWebhookEventInput {
  return {
    terminalKey: "demo-terminal",
    paymentId: "payment-1",
    orderNumber: "KOM-TEST-1",
    providerStatus,
    amount: 300_000,
    eventHash,
    payload: { PaymentId: "payment-1", Status: providerStatus },
    ...overrides,
  };
}

function eventHashForPayload(payload: Record<string, unknown>): string {
  const canonicalPayload = sanitizedTbankPayload(payload);
  const sortedPayload = Object.fromEntries(
    Object.entries(canonicalPayload).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return sha256Hex(JSON.stringify(sortedPayload));
}

test("T-Bank state graph never regresses successful financial states", () => {
  assert.equal(shouldApplyTbankProviderStatus("CONFIRMED", "AUTHORIZED"), false);
  assert.equal(shouldApplyTbankProviderStatus("CONFIRMED", "REJECTED"), false);
  assert.equal(shouldApplyTbankProviderStatus("AUTHORIZED", "REVERSED"), true);
  assert.equal(shouldApplyTbankProviderStatus("REJECTED", "CONFIRMED"), true);
  assert.equal(shouldApplyTbankProviderStatus("REFUNDED", "CONFIRMED"), false);
  assert.equal(shouldApplyTbankProviderStatus("AUTH_FAIL", "CONFIRMED"), true);
  assert.equal(shouldApplyTbankProviderStatus("CONFIRMED", "AUTH_FAIL"), false);
  assert.equal(shouldApplyTbankProviderStatus("INIT_REVIEW", "CONFIRMED"), false);
  assert.equal(shouldApplyTbankProviderStatus("INIT_REVIEW", "REFUNDED"), false);
  assert.equal(
    shouldApplyTbankProviderStatus("CONFIRMED", "PARTIAL_REVERSED"),
    true,
  );
  assert.equal(
    shouldApplyTbankProviderStatus("PARTIAL_REVERSED", "CONFIRMED"),
    false,
  );

  assert.equal(canApplyTbankOrderStatus("paid", "payment_failed"), false);
  assert.equal(
    canApplyTbankOrderProjection("paid", "payment_review", {
      providerStatus: "PARTIAL_REVERSED",
      amountMismatch: false,
    }),
    true,
  );
  assert.equal(
    canApplyTbankOrderProjection("partially_refunded", "payment_review", {
      providerStatus: "PARTIAL_REVERSED",
      amountMismatch: false,
    }),
    true,
  );
  assert.equal(
    canApplyTbankOrderProjection("paid", "payment_review", {
      providerStatus: "CONFIRMED",
      amountMismatch: true,
    }),
    true,
  );
  assert.equal(canApplyTbankOrderStatus("paid", "authorized"), false);
  assert.equal(canApplyTbankOrderStatus("paid", "partially_refunded"), true);
  assert.equal(canApplyTbankOrderStatus("partially_refunded", "refunded"), true);
  assert.equal(canApplyTbankOrderStatus("refunded", "paid"), false);
  assert.equal(canApplyTbankOrderStatus("payment_unknown", "paid"), true);
  assert.equal(tbankOrderStatus("AUTH_FAIL"), null);
  assert.equal(tbankOrderStatus("PARTIAL_REVERSED"), "payment_review");
  for (const status of [
    "created",
    "pending_payment",
    "payment_unknown",
    "authorized",
    "payment_failed",
    "canceled",
    "payment_review",
  ]) {
    assert.equal(
      tbankOrderStatusForCurrentOrder(status, "PARTIAL_REFUNDED"),
      "payment_review",
    );
  }
  assert.equal(
    tbankOrderStatusForCurrentOrder("paid", "PARTIAL_REFUNDED"),
    "partially_refunded",
  );
});

test("duplicate webhook event is acknowledged without repeating transitions", async () => {
  const { db, state } = fakeDb();
  const first = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "same-event"),
  );
  const duplicate = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "same-event"),
  );

  assert.equal(first.duplicate, false);
  assert.equal(first.transition.becamePaid, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.order.status, "paid");
  assert.equal(state.orderUpdates, 1);
  assert.equal(state.promoRedeemed, 1);
  assert.equal(
    state.queryLog.some(
      (sql) => sql.includes("on conflict (event_hash) do nothing") && sql.includes("returning id"),
    ),
    true,
  );
});

test("duplicate inbox row from the previous implementation can finish an incomplete transition", async () => {
  const { db, state } = fakeDb();
  state.eventHashes.set("legacy-incomplete-event", 41);
  let hookCalls = 0;
  const replay = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "legacy-incomplete-event"),
    {
      onTransition: async () => {
        hookCalls += 1;
      },
    },
  );

  assert.equal(replay.duplicate, true);
  assert.equal(replay.transition.eventId, 41);
  assert.equal(replay.transition.becamePaid, true);
  assert.equal(state.order.status, "paid");
  assert.equal(state.promoRedeemed, 1);
  assert.equal(hookCalls, 1);
});

test("late AUTHORIZED and REJECTED notifications cannot regress CONFIRMED", async () => {
  const { db, state } = fakeDb();
  await processTbankWebhookEvent(db, webhookEvent("CONFIRMED", "confirmed"));
  const authorized = await processTbankWebhookEvent(
    db,
    webhookEvent("AUTHORIZED", "late-authorized"),
  );
  const rejected = await processTbankWebhookEvent(
    db,
    webhookEvent("REJECTED", "late-rejected"),
  );

  assert.equal(authorized.providerStatusApplied, false);
  assert.equal(authorized.orderStatusChanged, false);
  assert.equal(rejected.providerStatusApplied, false);
  assert.equal(rejected.orderStatusChanged, false);
  assert.equal(state.attempt.provider_status, "CONFIRMED");
  assert.equal(state.order.status, "paid");
  assert.equal(state.promoReleased, 0);
});

test("a lower-rank provider event cannot drive a newer order projection", async () => {
  const { db, state } = fakeDb({
    orderStatus: "payment_review",
    providerStatus: "PARTIAL_REFUNDED",
  });
  const outcome = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "stale-confirmed-after-partial-refund"),
  );

  assert.equal(outcome.providerStatusApplied, false);
  assert.equal(outcome.orderStatusChanged, false);
  assert.equal(outcome.transition.resultingOrderStatus, "payment_review");
  assert.equal(state.attempt.provider_status, "PARTIAL_REFUNDED");
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.promoRedeemed, 0);
  assert.equal(state.eventHashes.size, 1);
});

test("INIT_REVIEW identity conflict cannot be auto-healed by a later CONFIRMED replay", async () => {
  const { db, state } = fakeDb({
    orderStatus: "payment_review",
    providerStatus: "INIT_REVIEW",
  });
  state.cdekEffects.push("cdek_cancel");
  state.cdekEffectPayloads.push({ reason: "payment_identity_conflict" });

  const outcome = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "confirmed-after-identity-conflict"),
  );

  assert.equal(outcome.providerStatusApplied, false);
  assert.equal(outcome.orderStatusChanged, false);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.promoRedeemed, 0);
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
});

test("AUTH_FAIL remains resumable and a later CONFIRMED can complete payment", async () => {
  const { db, state } = fakeDb();
  const authFail = await processTbankWebhookEvent(
    db,
    webhookEvent("AUTH_FAIL", "auth-fail"),
  );

  assert.equal(authFail.providerStatusApplied, true);
  assert.equal(authFail.orderStatusChanged, false);
  assert.equal(state.attempt.provider_status, "AUTH_FAIL");
  assert.equal(state.order.status, "pending_payment");
  assert.equal(state.promoReleased, 0);

  const confirmed = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "confirmed-after-auth-fail"),
  );
  assert.equal(confirmed.providerStatusApplied, true);
  assert.equal(confirmed.transition.becamePaid, true);
  assert.equal(state.attempt.provider_status, "CONFIRMED");
  assert.equal(state.order.status, "paid");
  assert.equal(state.promoRedeemed, 1);
});

test("concurrent AUTHORIZED and CONFIRMED notifications serialize to paid", async () => {
  const { db, state } = fakeDb();
  await Promise.all([
    processTbankWebhookEvent(db, webhookEvent("AUTHORIZED", "authorized")),
    processTbankWebhookEvent(db, webhookEvent("CONFIRMED", "confirmed")),
  ]);

  assert.equal(state.attempt.provider_status, "CONFIRMED");
  assert.equal(state.order.status, "paid");
  assert.equal(state.promoRedeemed, 1);
  assert.equal(
    state.queryLog.filter((sql) => sql.includes("for update")).length >= 4,
    true,
  );
});

test("amount mismatch moves an unpaid order to payment_review", async () => {
  const { db, state } = fakeDb();
  const outcome = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "wrong-amount", { amount: 299_999 }),
  );

  assert.equal(outcome.transition.amountMismatch, true);
  assert.equal(outcome.transition.resultingOrderStatus, "payment_review");
  assert.equal(outcome.transition.becamePaid, false);
  assert.equal(outcome.providerStatusApplied, false);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attempt.payment_url, null);
  assert.equal(state.attempt.error_code, "tbank_amount_mismatch");
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.promoRedeemed, 0);
  assert.equal(state.eventHashes.size, 1);
});

test("early AUTHORIZED with wrong amount is audited without binding PaymentId", async () => {
  const { db, state } = fakeDb({ paymentId: null });
  const outcome = await processTbankWebhookEvent(
    db,
    webhookEvent("AUTHORIZED", "early-wrong-amount", { amount: 299_999 }),
  );

  assert.equal(outcome.transition.amountMismatch, true);
  assert.equal(outcome.providerStatusApplied, false);
  assert.equal(state.eventHashes.size, 1);
  assert.equal(state.attempt.external_payment_id, null);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attemptUpdates, 1);
  assert.equal(state.order.status, "payment_review");
});

test("signed early webhook from a rotated terminal is audited without binding PaymentId", async () => {
  const { db, state } = fakeDb({
    paymentId: null,
    terminalKey: "retired-terminal",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "AUTHORIZED",
    PaymentId: "new-terminal-payment",
    ErrorCode: "0",
    Amount: 300_000,
  };

  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.eventHashes.size, 1);
  assert.equal(state.attempt.external_payment_id, null);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attempt.error_code, "tbank_terminal_boundary_mismatch");
  assert.equal(state.attemptUpdates, 1);
  assert.equal(state.order.status, "payment_review");
  assert.equal(
    state.order.metadata.payment_review_reason,
    "payment_identity_conflict",
  );
  assert.deepEqual(state.cdekEffects, []);
  await app.close();
});

test("terminal webhook with wrong amount is audited without applying failure", async () => {
  const { db, state } = fakeDb({
    orderStatus: "authorized",
    providerStatus: "AUTHORIZED",
  });
  const outcome = await processTbankWebhookEvent(
    db,
    webhookEvent("REVERSED", "terminal-wrong-amount", { amount: 299_999 }),
  );

  assert.equal(outcome.transition.amountMismatch, true);
  assert.equal(outcome.providerStatusApplied, false);
  assert.equal(state.eventHashes.size, 1);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attemptUpdates, 1);
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.promoReleased, 0);
});

test("effect enqueue failure rolls back inbox and financial transition", async () => {
  const { db, state } = fakeDb();
  await assert.rejects(
    processTbankWebhookEvent(db, webhookEvent("CONFIRMED", "effect-failed"), {
      onTransition: async () => {
        throw new Error("outbox unavailable");
      },
    }),
    /outbox unavailable/,
  );

  assert.equal(state.eventHashes.size, 0);
  assert.equal(state.attempt.provider_status, "NEW");
  assert.equal(state.order.status, "pending_payment");
  assert.equal(state.promoRedeemed, 0);
});

test("a second signed PaymentId for one order is quarantined and cancels fulfillment", async () => {
  const { db, state } = fakeDb({
    orderStatus: "paid",
    providerStatus: "CONFIRMED",
    paymentId: "bound-payment",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "CONFIRMED",
    PaymentId: "other-payment",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.eventHashes.size, 1);
  assert.equal(state.attempt.external_payment_id, "bound-payment");
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attempt.error_code, "tbank_payment_id_boundary_mismatch");
  assert.equal(state.order.status, "payment_review");
  assert.equal(
    state.order.metadata.payment_review_reason,
    "payment_identity_conflict",
  );
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "payment_identity_conflict");
  await app.close();
});

test("a terminal rotation after fulfillment quarantines the attempt and cancels CDEK", async () => {
  const { db, state } = fakeDb({
    orderStatus: "paid",
    providerStatus: "CONFIRMED",
    terminalKey: "retired-terminal",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "CONFIRMED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attempt.error_code, "tbank_terminal_boundary_mismatch");
  assert.equal(state.order.status, "payment_review");
  assert.equal(
    state.order.metadata.payment_review_reason,
    "payment_identity_conflict",
  );
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "payment_identity_conflict");
  await app.close();
});

test("a second PaymentId keeps even a refunded order in identity review", async () => {
  const { db, state } = fakeDb({
    orderStatus: "refunded",
    providerStatus: "REFUNDED",
    paymentId: "refunded-payment-A",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "REFUNDED",
    PaymentId: "second-payment-B",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.order.status, "payment_review");
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "payment_identity_conflict");
  await app.close();
});

test("a terminal conflict keeps even a refunded order in identity review", async () => {
  const { db, state } = fakeDb({
    orderStatus: "refunded",
    providerStatus: "REFUNDED",
    terminalKey: "retired-terminal",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "CONFIRMED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attempt.error_code, "tbank_terminal_boundary_mismatch");
  assert.equal(state.order.status, "payment_review");
  assert.equal(
    state.order.metadata.payment_review_reason,
    "payment_identity_conflict",
  );
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "payment_identity_conflict");
  await app.close();
});

test("a cancel marker keeps an existing review causal and blocks later fulfillment", async () => {
  const { db, state } = fakeDb({
    orderStatus: "payment_review",
    providerStatus: "INIT_UNKNOWN",
    responsePayload: { tbank_cancel_attempted: true },
    orderMetadata: { payment_review_reason: "generic_review" },
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "CONFIRMED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    // payment_state_conflict must outrank a simultaneous amount mismatch.
    Amount: 299_999,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(
    state.attempt.error_code,
    "tbank_cancel_payment_state_conflict",
  );
  assert.equal(state.order.status, "payment_review");
  assert.equal(
    state.order.metadata.payment_review_reason,
    "payment_state_conflict",
  );
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "payment_state_conflict");
  await app.close();
});

test("early webhook may bind PaymentId only to the latest unbound Init attempt", async () => {
  const { db, state } = fakeDb({ paymentId: null });
  const outcome = await processTbankWebhookEvent(
    db,
    webhookEvent("CONFIRMED", "early-confirmed"),
  );

  assert.equal(outcome.transition.becamePaid, true);
  assert.equal(state.attempt.external_payment_id, "payment-1");
  assert.equal(state.attempt.provider_status, "CONFIRMED");
  assert.equal(state.order.status, "paid");
  const attemptLockIndex = state.queryLog.findIndex(
    (sql) =>
      sql.includes("from public.merch_payment_attempts") &&
      sql.includes("where id = $1") &&
      sql.includes("for update"),
  );
  const orderLockIndex = state.queryLog.findIndex(
    (sql) =>
      sql.includes("from public.merch_customer_orders") &&
      sql.includes("where id = $1::uuid") &&
      sql.includes("for update"),
  );
  assert.equal(attemptLockIndex >= 0 && attemptLockIndex < orderLockIndex, true);
});

test("known PaymentId cannot be applied to a different OrderId", async () => {
  const { db, state } = fakeDb();
  await assert.rejects(
    processTbankWebhookEvent(
      db,
      webhookEvent("CONFIRMED", "wrong-order", {
        orderNumber: "KOM-ANOTHER-ORDER",
      }),
    ),
    TbankWebhookOrderMismatchError,
  );

  assert.equal(state.eventHashes.size, 0);
  assert.equal(state.order.status, "pending_payment");
  assert.equal(state.orderUpdates, 0);
});

test("transaction effect hook sees paid and REVERSED transitions before commit", async () => {
  const paid = fakeDb();
  let paidHookCalls = 0;
  await processTbankWebhookEvent(paid.db, webhookEvent("CONFIRMED", "paid"), {
    onTransition: async (_client, transition) => {
      assert.equal(paid.state.transactionActive, true);
      assert.equal(transition.becamePaid, true);
      paidHookCalls += 1;
    },
  });
  assert.equal(paidHookCalls, 1);

  const reversed = fakeDb({
    orderStatus: "authorized",
    providerStatus: "AUTHORIZED",
  });
  let reversedHookCalls = 0;
  await processTbankWebhookEvent(
    reversed.db,
    webhookEvent("REVERSED", "reversed"),
    {
      onTransition: async (_client, transition) => {
        assert.equal(reversed.state.transactionActive, true);
        assert.equal(transition.providerStatus, "REVERSED");
        assert.equal(transition.resultingOrderStatus, "payment_failed");
        reversedHookCalls += 1;
      },
    },
  );
  assert.equal(reversedHookCalls, 1);

  const historicalAuthorizedShipment = fakeDb({
    orderStatus: "payment_review",
    providerStatus: "AUTHORIZED",
  });
  let historicalCancelCalls = 0;
  const historicalOutcome = await processTbankWebhookEvent(
    historicalAuthorizedShipment.db,
    webhookEvent("REVERSED", "historical-reversed"),
    {
      onTransition: async (_client, transition) => {
        assert.equal(transition.providerStatusApplied, true);
        historicalCancelCalls += 1;
      },
    },
  );
  assert.equal(historicalOutcome.orderStatusChanged, false);
  assert.equal(historicalCancelCalls, 1);

  const staleReversal = fakeDb({
    orderStatus: "paid",
    providerStatus: "CONFIRMED",
  });
  let staleHookCalls = 0;
  await processTbankWebhookEvent(
    staleReversal.db,
    webhookEvent("REVERSED", "stale-reversed"),
    {
      onTransition: async () => {
        staleHookCalls += 1;
      },
    },
  );
  assert.equal(staleHookCalls, 1);
});

test("signed HTTP webhook rejects empty required fields and non-positive or fractional Amount before DB access", async () => {
  const { db, state } = fakeDb();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const validPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "AUTHORIZED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const invalidOverrides: Array<Record<string, unknown>> = [
    { OrderId: "" },
    { PaymentId: "" },
    { Status: "" },
    { Amount: 0 },
    { Amount: 1.5 },
  ];

  for (const override of invalidOverrides) {
    const unsignedPayload = { ...validPayload, ...override };
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/tbank",
      payload: {
        ...unsignedPayload,
        Token: createTbankToken(unsignedPayload, "demo-password"),
      },
    });
    assert.equal(response.statusCode, 400, JSON.stringify(override));
    assert.equal(response.body, "Invalid payload");
  }

  assert.equal(state.queryLog.length, 0);
  assert.equal(state.eventHashes.size, 0);
  assert.equal(state.attemptUpdates, 0);
  assert.equal(state.orderUpdates, 0);
  assert.equal(state.order.status, "pending_payment");
  await app.close();
});

test("HTTP webhook acknowledges after atomically queuing paid CDEK effect", async () => {
  const { db, state } = fakeDb();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "CONFIRMED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });
  const duplicateResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "OK");
  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(duplicateResponse.body, "OK");
  assert.deepEqual(state.cdekEffects, ["cdek_create"]);
  assert.deepEqual(state.emailOutbox, [orderId]);
  assert.equal(state.emailOutboxContexts[0]?.source, "tbank_webhook");
  assert.equal(state.order.status, "paid");
  assert.equal(
    state.queryLog.some(
      (sql) =>
        sql.includes("error_code = case when $3::boolean then null") &&
        sql.includes("error_message = case when $3::boolean then null"),
    ),
    true,
    "an accepted provider fact clears stale Init errors",
  );
  await app.close();
});

test("direct PARTIAL_REFUNDED enters review and a late lower-rank CONFIRMED is ignored", async () => {
  const { db, state } = fakeDb();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const partialPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "PARTIAL_REFUNDED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const partialResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...partialPayload,
      Token: createTbankToken(partialPayload, "demo-password"),
    },
  });

  assert.equal(partialResponse.statusCode, 200);
  assert.equal(state.attempt.provider_status, "PARTIAL_REFUNDED");
  assert.equal(state.order.status, "payment_review");
  assert.deepEqual(state.cdekEffects, []);

  const confirmedPayload = {
    ...partialPayload,
    Status: "CONFIRMED",
  };
  const confirmedResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...confirmedPayload,
      Token: createTbankToken(confirmedPayload, "demo-password"),
    },
  });

  assert.equal(confirmedResponse.statusCode, 200);
  assert.equal(state.attempt.provider_status, "PARTIAL_REFUNDED");
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.promoRedeemed, 0);
  assert.deepEqual(state.cdekEffects, []);
  await app.close();
});

test("direct PARTIAL_REVERSED blocks a late lower-rank CONFIRMED and fulfillment", async () => {
  const { db, state } = fakeDb();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const partialPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "PARTIAL_REVERSED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const partialResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...partialPayload,
      Token: createTbankToken(partialPayload, "demo-password"),
    },
  });

  assert.equal(partialResponse.statusCode, 200);
  assert.equal(state.attempt.provider_status, "PARTIAL_REVERSED");
  assert.equal(state.order.status, "payment_review");
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "partial_reversed");

  const confirmedPayload = { ...partialPayload, Status: "CONFIRMED" };
  const confirmedResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...confirmedPayload,
      Token: createTbankToken(confirmedPayload, "demo-password"),
    },
  });

  assert.equal(confirmedResponse.statusCode, 200);
  assert.equal(state.attempt.provider_status, "PARTIAL_REVERSED");
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.promoRedeemed, 0);
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  await app.close();
});

test("PARTIAL_REVERSED after paid moves the order to review, cancels fulfillment, and blocks late CONFIRMED", async () => {
  const { db, state } = fakeDb({
    orderStatus: "paid",
    providerStatus: "CONFIRMED",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const partialPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "PARTIAL_REVERSED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };

  const partialResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...partialPayload,
      Token: createTbankToken(partialPayload, "demo-password"),
    },
  });

  assert.equal(partialResponse.statusCode, 200);
  assert.equal(state.attempt.provider_status, "PARTIAL_REVERSED");
  assert.equal(state.order.status, "payment_review");
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "partial_reversed");
  assert.equal(
    state.cdekEffectPayloads[0]?.provider_status,
    "PARTIAL_REVERSED",
  );

  const confirmedPayload = { ...partialPayload, Status: "CONFIRMED" };
  const confirmedResponse = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...confirmedPayload,
      Token: createTbankToken(confirmedPayload, "demo-password"),
    },
  });

  assert.equal(confirmedResponse.statusCode, 200);
  assert.equal(state.attempt.provider_status, "PARTIAL_REVERSED");
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.promoRedeemed, 0);
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  await app.close();
});

test("PARTIAL_REVERSED after a partial refund also blocks fulfillment", async () => {
  const { db, state } = fakeDb({
    orderStatus: "partially_refunded",
    providerStatus: "PARTIAL_REFUNDED",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "PARTIAL_REVERSED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };

  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.attempt.provider_status, "PARTIAL_REVERSED");
  assert.equal(state.order.status, "payment_review");
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.cdekEffectPayloads[0]?.reason, "partial_reversed");
  await app.close();
});

test("signed amount mismatch quarantines fulfilled payments and exact replays cannot rearm fulfillment", async () => {
  const scenarios = [
    { orderStatus: "paid", providerStatus: "CONFIRMED" },
    {
      orderStatus: "partially_refunded",
      providerStatus: "PARTIAL_REFUNDED",
    },
  ];

  for (const scenario of scenarios) {
    const { db, state } = fakeDb(scenario);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
      TBANK_DEMO_PASSWORD: "demo-password",
      CDEK_CREATE_SHIPMENTS: "true",
      CDEK_MOCK: "true",
    });
    const app = buildApp({ config, db });
    const unsignedPayload = {
      TerminalKey: "demo-terminal",
      OrderId: "KOM-TEST-1",
      Success: true,
      Status: scenario.providerStatus,
      PaymentId: "payment-1",
      ErrorCode: "0",
      Amount: 299_999,
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/tbank",
      payload: {
        ...unsignedPayload,
        Token: createTbankToken(unsignedPayload, "demo-password"),
      },
    });

    assert.equal(response.statusCode, 200, scenario.orderStatus);
    assert.equal(state.order.status, "payment_review", scenario.orderStatus);
    assert.equal(
      state.attempt.provider_status,
      "INIT_REVIEW",
      scenario.orderStatus,
    );
    assert.equal(state.attempt.external_payment_id, "payment-1");
    assert.equal(state.attempt.payment_url, null);
    assert.equal(state.attempt.error_code, "tbank_amount_mismatch");
    assert.equal(state.attemptUpdates, 1);
    assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
    assert.equal(state.cdekEffectPayloads[0]?.reason, "amount_mismatch");
    assert.equal(
      state.cdekEffectPayloads[0]?.provider_status,
      scenario.providerStatus,
    );

    const correctPayload = { ...unsignedPayload, Amount: 300_000 };
    const correctReplay = await app.inject({
      method: "POST",
      url: "/v1/webhooks/tbank",
      payload: {
        ...correctPayload,
        Token: createTbankToken(correctPayload, "demo-password"),
      },
    });

    assert.equal(correctReplay.statusCode, 200, scenario.orderStatus);
    assert.equal(state.attempt.provider_status, "INIT_REVIEW");
    assert.equal(state.order.status, "payment_review");
    assert.equal(state.promoRedeemed, 0);
    assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
    await app.close();
  }
});

test("signed amount mismatch cannot reopen a refunded order", async () => {
  const { db, state } = fakeDb({
    orderStatus: "refunded",
    providerStatus: "REFUNDED",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "REFUNDED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 299_999,
  };

  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.order.status, "refunded");
  assert.equal(state.attempt.provider_status, "REFUNDED");
  assert.equal(state.attemptUpdates, 0);
  assert.deepEqual(state.cdekEffects, []);
  await app.close();
});

test("HTTP REVERSED webhook atomically queues CDEK cancellation", async () => {
  const { db, state } = fakeDb({
    orderStatus: "authorized",
    providerStatus: "AUTHORIZED",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "false",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "REVERSED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "OK");
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.order.status, "payment_failed");
  await app.close();
});

test("HTTP REFUNDED webhook moves paid order to refunded and queues cancellation", async () => {
  const { db, state } = fakeDb({
    orderStatus: "paid",
    providerStatus: "CONFIRMED",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "false",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "REFUNDED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "OK");
  assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
  assert.equal(state.order.status, "refunded");
  await app.close();
});

test("legacy terminal-status webhook replays heal order state and queue CDEK cancellation", async () => {
  const scenarios = [
    {
      providerStatus: "REFUNDED",
      initialOrderStatus: "paid",
      expectedOrderStatus: "refunded",
    },
    {
      providerStatus: "REVERSED",
      initialOrderStatus: "authorized",
      expectedOrderStatus: "payment_failed",
    },
  ];

  for (const scenario of scenarios) {
    const { db, state } = fakeDb({
      orderStatus: scenario.initialOrderStatus,
      providerStatus: scenario.providerStatus,
    });
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
      TBANK_DEMO_PASSWORD: "demo-password",
      CDEK_CREATE_SHIPMENTS: "false",
      CDEK_MOCK: "true",
    });
    const app = buildApp({ config, db });
    const unsignedPayload = {
      TerminalKey: "demo-terminal",
      OrderId: "KOM-TEST-1",
      Success: true,
      Status: scenario.providerStatus,
      PaymentId: "payment-1",
      ErrorCode: "0",
      Amount: 300_000,
    };
    state.eventHashes.set(eventHashForPayload(unsignedPayload), 41);

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/tbank",
      payload: {
        ...unsignedPayload,
        Token: createTbankToken(unsignedPayload, "demo-password"),
      },
    });

    assert.equal(response.statusCode, 200, scenario.providerStatus);
    assert.equal(response.body, "OK");
    assert.equal(state.attempt.provider_status, scenario.providerStatus);
    assert.equal(state.attemptUpdates, 0);
    assert.equal(state.order.status, scenario.expectedOrderStatus);
    assert.equal(state.orderUpdates, 1);
    assert.deepEqual(state.cdekEffects, ["cdek_cancel"]);
    assert.equal(state.eventHashes.size, 1);
    await app.close();
  }
});

test("late REVERSED after CONFIRMED cannot cancel a valid paid shipment", async () => {
  const { db, state } = fakeDb({
    orderStatus: "paid",
    providerStatus: "CONFIRMED",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "REVERSED",
    PaymentId: "payment-1",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.order.status, "paid");
  assert.equal(state.attempt.provider_status, "CONFIRMED");
  assert.deepEqual(state.cdekEffects, []);
  await app.close();
});

test("signed HTTP webhook with a second PaymentId quarantines instead of marking paid", async () => {
  const { db, state } = fakeDb({ paymentId: "bound-payment" });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
    TBANK_DEMO_PASSWORD: "demo-password",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_MOCK: "true",
  });
  const app = buildApp({ config, db });
  const unsignedPayload = {
    TerminalKey: "demo-terminal",
    OrderId: "KOM-TEST-1",
    Success: true,
    Status: "CONFIRMED",
    PaymentId: "other-payment",
    ErrorCode: "0",
    Amount: 300_000,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/tbank",
    payload: {
      ...unsignedPayload,
      Token: createTbankToken(unsignedPayload, "demo-password"),
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.order.status, "payment_review");
  assert.equal(state.attempt.provider_status, "INIT_REVIEW");
  assert.equal(state.attempt.external_payment_id, "bound-payment");
  assert.equal(state.eventHashes.size, 1);
  assert.deepEqual(state.cdekEffects, []);
  await app.close();
});
