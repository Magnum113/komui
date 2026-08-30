import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import {
  enqueueCdekEffect,
  processCdekEffects,
  type CdekEffectRow,
  type CdekEffectStatus,
} from "../src/cdekEffects";
import { createCdekShipmentForOrder } from "../src/cdekShipments";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import { HttpError } from "../src/errors";

const orderId = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const orderNumber = "KOM-123456789";

type FakeShipment = {
  id: number;
  order_id: string;
  status: string;
  cdek_uuid: string | null;
  cdek_number: string | null;
};

type FakeState = {
  effects: CdekEffectRow[];
  shipments: FakeShipment[];
  orderStatus?: string;
  orderReviewReason?: string | null;
  transactionDepth?: number;
  onFinancialLock?: (state: FakeState) => void;
};

function samePayload(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function effect(
  effectType: "cdek_create" | "cdek_cancel",
  status: CdekEffectStatus = "pending",
  id = 1,
): CdekEffectRow {
  return {
    id,
    order_id: orderId,
    effect_type: effectType,
    dedupe_key: `${effectType}:${orderId}`,
    status,
    payload: {},
    attempts: 0,
    locked_by: null,
  };
}

function fakeEffectDb(state: FakeState): Db {
  const query = async <T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[] }> => {
    if (sql.includes("cdek_effect:enqueue")) {
      const [effectType, queuedOrderId, dedupe, rawPayload] = values as [
        "cdek_create" | "cdek_cancel",
        string,
        string,
        string,
      ];
      if (effectType === "cdek_cancel") {
        const create = state.effects.find(
          (item) => item.dedupe_key === `cdek_create:${queuedOrderId}`,
        );
        if (create && ["pending", "retry"].includes(create.status)) {
          create.status = "canceled";
        }
      }
      let row = state.effects.find((item) => item.dedupe_key === dedupe);
      if (!row) {
        row = {
          ...effect(effectType, "pending", state.effects.length + 1),
          order_id: queuedOrderId,
          dedupe_key: dedupe,
          payload: JSON.parse(rawPayload),
        };
        state.effects.push(row);
      } else {
        const incomingPayload = JSON.parse(rawPayload) as Record<string, unknown>;
        const rearmTerminalEffect =
          row.effect_type === effectType &&
          ["completed", "needs_review", "canceled"].includes(row.status);
        if (rearmTerminalEffect) {
          row.status = "pending";
          row.attempts = 0;
          row.locked_by = null;
          const mutable = row as CdekEffectRow & {
            completed_at?: string | null;
            last_error?: string | null;
          };
          mutable.completed_at = null;
          mutable.last_error = null;
          for (const key of [
            "outcome",
            "shipmentId",
            "cdekCancellation",
            "providerFailure",
            "providerDeleteAttempted",
            "cancellationIntentRestored",
            "currentOrderStatus",
            "shipmentStatus",
            "fulfillmentRecovery",
            "cdekReconciliation",
          ]) {
            delete row.payload[key];
          }
        }
        const mergedPayload = { ...row.payload, ...incomingPayload };
        if (
          ["pending", "retry", "processing"].includes(row.status) &&
          !samePayload(row.payload, mergedPayload)
        ) {
          row.attempts = 0;
          const mutable = row as CdekEffectRow & { last_error?: string | null };
          mutable.last_error = null;
        }
        row.payload = mergedPayload;
      }
      return { rows: [row as unknown as T] };
    }

    if (sql.includes("cdek_effect:claim")) {
      const [workerId] = values as [string];
      const row = [...state.effects]
        .filter((item) => ["pending", "retry", "processing"].includes(item.status))
        .sort((left, right) => {
          const leftPriority = left.effect_type === "cdek_cancel" ? 0 : 1;
          const rightPriority = right.effect_type === "cdek_cancel" ? 0 : 1;
          return leftPriority - rightPriority || left.id - right.id;
        })[0];
      if (!row) return { rows: [] };
      row.status = "processing";
      row.attempts += 1;
      row.locked_by = workerId;
      return {
        rows: [
          {
            ...row,
            payload: { ...row.payload },
          } as unknown as T,
        ],
      };
    }

    if (sql.includes("cdek_effect:load_shipment")) {
      return {
        rows: state.shipments.filter(
          (item) => item.order_id === values[0],
        ) as unknown as T[],
      };
    }

    if (sql.includes("cdek_effect:load_create_status")) {
      const create = state.effects.find(
        (item) => item.dedupe_key === `cdek_create:${values[0]}`,
      );
      return {
        rows: create ? ([{ status: create.status }] as unknown as T[]) : [],
      };
    }

    if (sql.includes("cdek_effect:lock_order_financial_state")) {
      const hook = state.onFinancialLock;
      state.onFinancialLock = undefined;
      hook?.(state);
      const reviewReason =
        state.orderReviewReason === undefined
          ? state.effects.find((item) => item.effect_type === "cdek_cancel")
              ?.payload.reason
          : state.orderReviewReason;
      return {
        rows: [
          {
            order_number: orderNumber,
            status: state.orderStatus ?? "refunded",
            metadata: reviewReason
              ? { payment_review_reason: reviewReason }
              : {},
          } as unknown as T,
        ],
      };
    }

    if (sql.includes("cdek_effect:adopt_reconciled_shipment")) {
      const shipment = state.shipments.find((item) => item.id === values[0]);
      if (
        !shipment ||
        shipment.cdek_uuid ||
        ["deleting", "deleted"].includes(shipment.status)
      ) {
        return { rows: [] };
      }
      shipment.cdek_uuid = String(values[1]);
      shipment.cdek_number = values[2] ? String(values[2]) : null;
      shipment.status = String(values[3]);
      return { rows: [shipment as unknown as T] };
    }

    if (sql.includes("cdek_effect:mark_cancel_intent")) {
      const shipment = state.shipments.find((item) => item.id === values[0]);
      if (
        !shipment ||
        shipment.cdek_uuid !== values[1] ||
        shipment.status !== values[2] ||
        ["deleting", "deleted"].includes(shipment.status)
      ) {
        return { rows: [] };
      }
      shipment.status = "deleting";
      return { rows: [shipment as unknown as T] };
    }

    if (sql.includes("cdek_effect:restore_cancel_intent")) {
      const shipment = state.shipments.find((item) => item.id === values[0]);
      if (
        !shipment ||
        shipment.cdek_uuid !== values[1] ||
        shipment.status !== "deleting"
      ) {
        return { rows: [] };
      }
      shipment.status = String(values[2]);
      return { rows: [shipment as unknown as T] };
    }

    if (sql.includes("cdek_effect:terminal")) {
      const [id, workerId, status, rawPayload, , rawExpectedPayload] = values as [
        number,
        string,
        CdekEffectStatus,
        string,
        string | null,
        string,
      ];
      const row = state.effects.find(
        (item) => item.id === id && item.locked_by === workerId,
      );
      if (row && samePayload(row.payload, JSON.parse(rawExpectedPayload))) {
        row.status = status;
        row.payload = { ...row.payload, ...JSON.parse(rawPayload) };
        row.locked_by = null;
      } else if (row) {
        row.status = "pending";
        row.locked_by = null;
      }
      return { rows: [] };
    }

    if (sql.includes("cdek_effect:retry")) {
      const [id, workerId, , , rawPayload, rawExpectedPayload] = values as [
        number,
        string,
        number,
        string,
        string,
        string,
      ];
      const row = state.effects.find(
        (item) => item.id === id && item.locked_by === workerId,
      );
      if (row && samePayload(row.payload, JSON.parse(rawExpectedPayload))) {
        row.status = "retry";
        row.payload = { ...row.payload, ...JSON.parse(rawPayload) };
        row.locked_by = null;
      } else if (row) {
        row.status = "pending";
        row.locked_by = null;
      }
      return { rows: [] };
    }

    if (sql.includes("cdek_effect:mark_shipment_deleting")) {
      const shipment = state.shipments.find((item) => item.id === values[0]);
      if (shipment && shipment.status !== "deleted") shipment.status = "deleting";
      return { rows: [] };
    }

    if (sql.includes("cdek_effect:mark_shipment_deleted")) {
      const shipment = state.shipments.find((item) => item.id === values[0]);
      if (
        shipment &&
        shipment.cdek_uuid === values[1] &&
        ["deleting", "deleted"].includes(shipment.status)
      ) {
        shipment.status = "deleted";
        return { rows: [shipment as unknown as T] };
      }
      return { rows: [] };
    }

    throw new Error(`Unexpected SQL in fake effect DB: ${sql}`);
  };

  return {
    query,
    withTransaction: async (callback) => {
      state.transactionDepth = (state.transactionDepth ?? 0) + 1;
      try {
        return await callback({ query } as never);
      } finally {
        state.transactionDepth -= 1;
      }
    },
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;
}

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    CDEK_MOCK: "true",
    CDEK_CREATE_SHIPMENTS: "true",
    ...overrides,
  });
}

function exactCdekOrder(uuid: string) {
  return {
    entity: { uuid, number: orderNumber },
    requests: [{ type: "GET", state: "SUCCESSFUL" }],
  };
}

test("enqueueCdekEffect is idempotent and cancellation supersedes queued creation", async () => {
  const state: FakeState = {
    effects: [effect("cdek_create")],
    shipments: [],
  };
  const db = fakeEffectDb(state);

  const first = await enqueueCdekEffect(
    db as never,
    "cdek_cancel",
    orderId,
    { eventHash: "event-1" },
  );
  const duplicate = await enqueueCdekEffect(
    db as never,
    "cdek_cancel",
    orderId,
    { providerStatus: "REFUNDED" },
  );

  assert.equal(state.effects.length, 2);
  assert.equal(first.status, "pending");
  assert.equal(state.effects[0]?.status, "canceled");
  assert.equal(duplicate.status, "pending");
  assert.deepEqual(duplicate.payload, {
    eventHash: "event-1",
    providerStatus: "REFUNDED",
  });
});

test("a new causal payload resets the retry budget without duplicating the effect", async () => {
  const stale = effect("cdek_cancel", "retry");
  stale.attempts = 12;
  stale.payload = {
    payment_event_hash: "old-reversed-event",
    provider_status: "REVERSED",
  };
  const state: FakeState = { effects: [stale], shipments: [] };
  const db = fakeEffectDb(state);

  const requeued = await enqueueCdekEffect(db as never, "cdek_cancel", orderId, {
    payment_event_hash: "new-partial-reversed-event",
    provider_status: "PARTIAL_REVERSED",
    reason: "partial_reversed",
  });

  assert.equal(state.effects.length, 1);
  assert.equal(requeued.status, "retry");
  assert.equal(requeued.attempts, 0);
  assert.equal(requeued.payload.reason, "partial_reversed");
});

test("a new financial cancellation rearms a terminal cancel effect", async () => {
  const terminal = effect("cdek_cancel", "completed");
  terminal.attempts = 12;
  terminal.locked_by = "old-worker";
  terminal.payload = {
    outcome: "no_shipment",
    shipmentId: 10,
    providerDeleteAttempted: true,
    payment_event_hash: "old-event",
  };
  const mutable = terminal as CdekEffectRow & {
    completed_at?: string | null;
    last_error?: string | null;
  };
  mutable.completed_at = "2026-08-30T10:00:00.000Z";
  mutable.last_error = "old terminal result";
  const shipment: FakeShipment = {
    id: 15,
    order_id: orderId,
    status: "created",
    cdek_uuid: "late-created-uuid",
    cdek_number: "5555555555",
  };
  const state: FakeState = { effects: [terminal], shipments: [shipment] };
  const db = fakeEffectDb(state);

  const rearmed = await enqueueCdekEffect(db as never, "cdek_cancel", orderId, {
    payment_event_hash: "new-refund-event",
    provider_status: "REFUNDED",
  });

  assert.equal(rearmed.status, "pending");
  assert.equal(rearmed.attempts, 0);
  assert.equal(rearmed.locked_by, null);
  assert.equal(mutable.completed_at, null);
  assert.equal(mutable.last_error, null);
  assert.equal(rearmed.payload.outcome, undefined);
  assert.equal(rearmed.payload.shipmentId, undefined);
  assert.equal(rearmed.payload.providerDeleteAttempted, undefined);
  assert.equal(rearmed.payload.payment_event_hash, "new-refund-event");

  const result = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-rearmed-cancel",
      limit: 1,
      getOrder: async (_config, uuid) => exactCdekOrder(uuid),
      cancelOrder: async (_config, uuid) => ({
        entity: { uuid },
        requests: [{ type: "DELETE", state: "SUCCESSFUL" }],
      }),
    },
  );

  assert.equal(result.completed, 1);
  assert.equal(shipment.status, "deleted");
  assert.equal(terminal.status, "completed");
});

test("a recovered payment rearms a terminal create effect", async () => {
  const terminal = effect("cdek_create", "canceled");
  terminal.attempts = 7;
  terminal.locked_by = "old-create-worker";
  terminal.payload = {
    outcome: "shipment_already_deleted",
    shipmentId: 19,
    payment_event_hash: "old-payment-event",
  };
  const mutable = terminal as CdekEffectRow & {
    completed_at?: string | null;
    last_error?: string | null;
  };
  mutable.completed_at = "2026-08-30T10:00:00.000Z";
  mutable.last_error = "Superseded by CDEK cancellation";
  const state: FakeState = { effects: [terminal], shipments: [] };

  const rearmed = await enqueueCdekEffect(
    fakeEffectDb(state) as never,
    "cdek_create",
    orderId,
    {
      payment_event_hash: "late-confirmation-event",
      provider_status: "CONFIRMED",
    },
  );

  assert.equal(rearmed.status, "pending");
  assert.equal(rearmed.attempts, 0);
  assert.equal(rearmed.locked_by, null);
  assert.equal(mutable.completed_at, null);
  assert.equal(mutable.last_error, null);
  assert.equal(rearmed.payload.outcome, undefined);
  assert.equal(rearmed.payload.shipmentId, undefined);
  assert.equal(rearmed.payload.payment_event_hash, "late-confirmation-event");
});

test("late payment recovery makes queued cancellation non-causal and keeps an existing shipment", async () => {
  const cancelEffect = effect("cdek_cancel", "pending", 1);
  const createEffect = effect("cdek_create", "canceled", 2);
  createEffect.attempts = 4;
  createEffect.payload = { outcome: "superseded_by_cancellation" };
  const shipment: FakeShipment = {
    id: 20,
    order_id: orderId,
    status: "created",
    cdek_uuid: "recovered-shipment-uuid",
    cdek_number: "8888888888",
  };
  const state: FakeState = {
    effects: [cancelEffect, createEffect],
    shipments: [shipment],
    orderStatus: "paid",
  };
  const db = fakeEffectDb(state);
  let deleteCalls = 0;
  let createFlowCalls = 0;

  const rearmedCreate = await enqueueCdekEffect(
    db as never,
    "cdek_create",
    orderId,
    { provider_status: "CONFIRMED" },
  );
  assert.equal(rearmedCreate.status, "pending");
  assert.equal(rearmedCreate.attempts, 0);

  const guarded = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-non-causal-cancel",
      limit: 1,
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
    },
  );

  assert.equal(guarded.canceled, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(cancelEffect.status, "canceled");
  assert.equal(
    cancelEffect.payload.outcome,
    "cancellation_superseded_by_financial_state",
  );
  assert.equal(cancelEffect.payload.currentOrderStatus, "paid");
  assert.equal(cancelEffect.payload.providerDeleteAttempted, false);
  assert.equal(shipment.status, "created");

  const converged = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-recovered-create",
      limit: 1,
      createShipment: async () => {
        createFlowCalls += 1;
        return shipment as never;
      },
    },
  );

  assert.equal(converged.completed, 1);
  assert.equal(createFlowCalls, 1);
  assert.equal(createEffect.status, "completed");
  assert.equal(createEffect.payload.outcome, "shipment_created");
  assert.equal(deleteCalls, 0);
});

test("payment recovery after a deleted shipment requires operator review", async () => {
  const createEffect = effect("cdek_create", "canceled");
  const shipment: FakeShipment = {
    id: 21,
    order_id: orderId,
    status: "deleted",
    cdek_uuid: "deleted-shipment-uuid",
    cdek_number: "9999999999",
  };
  const state: FakeState = {
    effects: [createEffect],
    shipments: [shipment],
    orderStatus: "paid",
  };
  const db = fakeEffectDb(state);
  let createFlowCalls = 0;

  await enqueueCdekEffect(db as never, "cdek_create", orderId, {
    provider_status: "CONFIRMED",
  });
  const result = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-deleted-recovery",
      limit: 1,
      createShipment: async () => {
        createFlowCalls += 1;
        return shipment as never;
      },
    },
  );

  assert.equal(createFlowCalls, 1);
  assert.equal(result.needsReview, 1);
  assert.equal(createEffect.status, "needs_review");
  assert.equal(
    (createEffect.payload.fulfillmentRecovery as Record<string, unknown>)
      .shipmentStatus,
    "deleted",
  );
  assert.equal(
    (createEffect.payload.fulfillmentRecovery as Record<string, unknown>)
      .automaticCreateRetried,
    false,
  );
});

test("provider DELETE runs outside transactions and recovery during I/O is surfaced", async () => {
  const cancelEffect = effect("cdek_cancel");
  const shipment: FakeShipment = {
    id: 22,
    order_id: orderId,
    status: "created",
    cdek_uuid: "slow-delete-uuid",
    cdek_number: "1010101010",
  };
  const state: FakeState = {
    effects: [cancelEffect],
    shipments: [shipment],
    orderStatus: "refunded",
  };
  const db = fakeEffectDb(state);

  const result = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-recovery-during-delete",
      limit: 1,
      getOrder: async (_config, uuid) => {
        assert.equal(state.transactionDepth, 0);
        return exactCdekOrder(uuid);
      },
      cancelOrder: async (_config, uuid) => {
        assert.equal(state.transactionDepth, 0);
        assert.equal(uuid, "slow-delete-uuid");
        state.orderStatus = "paid";
        return {
          entity: { uuid },
          requests: [{ type: "DELETE", state: "SUCCESSFUL" }],
        };
      },
    },
  );

  assert.equal(state.transactionDepth, 0);
  assert.equal(result.needsReview, 1);
  assert.equal(result.completed, 0);
  assert.equal(shipment.status, "deleted");
  assert.equal(cancelEffect.status, "needs_review");
  assert.equal(
    cancelEffect.payload.outcome,
    "shipment_deleted_after_financial_recovery",
  );
  assert.equal(cancelEffect.payload.providerDeleteAttempted, true);
});

test("recovery after intent but before DELETE restores the shipment and skips provider mutation", async () => {
  const cancelEffect = effect("cdek_cancel");
  const shipment: FakeShipment = {
    id: 23,
    order_id: orderId,
    status: "created",
    cdek_uuid: "guarded-delete-uuid",
    cdek_number: "2020202020",
  };
  const state: FakeState = {
    effects: [cancelEffect],
    shipments: [shipment],
    orderStatus: "refunded",
  };
  let deleteCalls = 0;

  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-recovery-before-delete",
      limit: 1,
      getOrder: async (_config, uuid) => {
        state.orderStatus = "paid";
        return exactCdekOrder(uuid);
      },
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
    },
  );

  assert.equal(result.canceled, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(shipment.status, "created");
  assert.equal(cancelEffect.status, "canceled");
  assert.equal(cancelEffect.payload.cancellationIntentRestored, true);
});

test("payment_review cancellation requires an explicit trusted causal reason", async (context) => {
  for (const scenario of [
    "partial_reversed",
    "amount_mismatch",
    "payment_identity_conflict",
    "payment_state_conflict",
    "generic_review",
  ] as const) {
    await context.test(scenario, async () => {
      const cancelEffect = effect("cdek_cancel");
      cancelEffect.payload =
        scenario === "generic_review"
          ? { provider_status: "CONFIRMED" }
          : {
              reason: scenario,
              provider_status:
                scenario === "partial_reversed"
                  ? "PARTIAL_REVERSED"
                  : "CONFIRMED",
            };
      const shipment: FakeShipment = {
        id: scenario === "generic_review" ? 26 : 24,
        order_id: orderId,
        status: "created",
        cdek_uuid: `${scenario}-uuid`,
        cdek_number: null,
      };
      const state: FakeState = {
        effects: [cancelEffect],
        shipments: [shipment],
        orderStatus: "payment_review",
      };
      let deleteCalls = 0;

      const result = await processCdekEffects(
        { config: config(), db: fakeEffectDb(state) },
        {
          workerId: `worker-${scenario}`,
          limit: 1,
          getOrder: async (_config, uuid) => exactCdekOrder(uuid),
          cancelOrder: async (_config, uuid) => {
            deleteCalls += 1;
            return {
              entity: { uuid },
              requests: [{ type: "DELETE", state: "SUCCESSFUL" }],
            };
          },
        },
      );

      if (scenario === "generic_review") {
        assert.equal(result.canceled, 1);
        assert.equal(deleteCalls, 0);
        assert.equal(shipment.status, "created");
      } else {
        assert.equal(result.completed, 1);
        assert.equal(deleteCalls, 1);
        assert.equal(shipment.status, "deleted");
      }
    });
  }
});

test("a causal payment_review enqueue survives a stale processing worker", async (context) => {
  for (const scenario of [
    "partial_reversed",
    "amount_mismatch",
    "payment_state_conflict",
  ] as const) {
    await context.test(scenario, async () => {
      const cancelEffect = effect("cdek_cancel");
      cancelEffect.payload = {
        payment_event_hash: "old-reversed-event",
        provider_status: "REVERSED",
      };
      cancelEffect.attempts = 11;
      const shipment: FakeShipment = {
        id:
          scenario === "partial_reversed"
            ? 32
            : scenario === "amount_mismatch"
              ? 33
              : 35,
        order_id: orderId,
        status: "created",
        cdek_uuid: `${scenario}-generation-uuid`,
        cdek_number: null,
      };
      const state: FakeState = {
        effects: [cancelEffect],
        shipments: [shipment],
        orderStatus: "payment_review",
        onFinancialLock: (mutable) => {
          const row = mutable.effects[0]!;
          row.payload = {
            ...row.payload,
            payment_event_hash: `new-${scenario}-event`,
            reason: scenario,
            provider_status:
              scenario === "partial_reversed"
                ? "PARTIAL_REVERSED"
                : "CONFIRMED",
          };
          row.attempts = 0;
        },
      };
      const db = fakeEffectDb(state);
      let deleteCalls = 0;

      const stale = await processCdekEffects(
        { config: config(), db },
        {
          workerId: `worker-stale-${scenario}`,
          limit: 1,
          cancelOrder: async () => {
            deleteCalls += 1;
            return {};
          },
        },
      );

      assert.equal(stale.canceled, 1);
      assert.equal(deleteCalls, 0);
      assert.equal(cancelEffect.status, "pending");
      assert.equal(cancelEffect.locked_by, null);
      assert.equal(cancelEffect.attempts, 0);
      assert.equal(cancelEffect.payload.reason, scenario);

      const fresh = await processCdekEffects(
        { config: config(), db },
        {
          workerId: `worker-fresh-${scenario}`,
          limit: 1,
          getOrder: async (_config, uuid) => exactCdekOrder(uuid),
          cancelOrder: async (_config, uuid) => {
            deleteCalls += 1;
            return {
              entity: { uuid },
              requests: [{ type: "DELETE", state: "SUCCESSFUL" }],
            };
          },
        },
      );

      assert.equal(fresh.completed, 1);
      assert.equal(deleteCalls, 1);
      assert.equal(cancelEffect.status, "completed");
      assert.equal(shipment.status, "deleted");
    });
  }
});

test("a stale causal reason cannot cancel a shipment for a different current review", async () => {
  const cancelEffect = effect("cdek_cancel");
  cancelEffect.payload = {
    reason: "partial_reversed",
    provider_status: "PARTIAL_REVERSED",
  };
  const shipment: FakeShipment = {
    id: 34,
    order_id: orderId,
    status: "created",
    cdek_uuid: "stale-review-reason-uuid",
    cdek_number: null,
  };
  const state: FakeState = {
    effects: [cancelEffect],
    shipments: [shipment],
    orderStatus: "payment_review",
    orderReviewReason: "partial_refunded",
  };
  let deleteCalls = 0;

  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-stale-review-reason",
      limit: 1,
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
    },
  );

  assert.equal(result.canceled, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(shipment.status, "created");
  assert.equal(cancelEffect.status, "canceled");
});

test("legacy shipment identity must be complete and exact before DELETE", async (context) => {
  for (const scenario of ["foreign_uuid", "missing_identity"] as const) {
    await context.test(scenario, async () => {
      const cancelEffect = effect("cdek_cancel");
      const shipment: FakeShipment = {
        id: scenario === "foreign_uuid" ? 27 : 28,
        order_id: orderId,
        status: "created",
        cdek_uuid: "legacy-stored-uuid",
        cdek_number: null,
      };
      const state: FakeState = {
        effects: [cancelEffect],
        shipments: [shipment],
      };
      let deleteCalls = 0;

      const result = await processCdekEffects(
        { config: config(), db: fakeEffectDb(state) },
        {
          workerId: `worker-legacy-${scenario}`,
          limit: 1,
          getOrder: async () =>
            scenario === "foreign_uuid"
              ? {
                  entity: {
                    uuid: "foreign-provider-uuid",
                    number: orderNumber,
                  },
                  requests: [{ type: "GET", state: "SUCCESSFUL" }],
                }
              : {
                  entity: {},
                  requests: [{ type: "GET", state: "SUCCESSFUL" }],
                },
          cancelOrder: async () => {
            deleteCalls += 1;
            return {};
          },
        },
      );

      assert.equal(result.needsReview, 1);
      assert.equal(deleteCalls, 0);
      assert.equal(shipment.status, "deleting");
      assert.equal(cancelEffect.status, "needs_review");
    });
  }
});

test("UUID 404 cannot hide a live shipment found by merchant number", async () => {
  const cancelEffect = effect("cdek_cancel");
  const shipment: FakeShipment = {
    id: 29,
    order_id: orderId,
    status: "created",
    cdek_uuid: "stale-local-uuid",
    cdek_number: null,
  };
  const state: FakeState = { effects: [cancelEffect], shipments: [shipment] };
  let deleteCalls = 0;

  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-stale-uuid",
      limit: 1,
      getOrder: async () => {
        throw new HttpError(400, "cdek_request_failed", "Not found", {
          providerStatus: 404,
        });
      },
      getOrderByImNumber: async (_config, number) => ({
        entity: { uuid: "live-provider-uuid", im_number: number },
        requests: [{ type: "GET", state: "SUCCESSFUL" }],
      }),
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
    },
  );

  assert.equal(result.needsReview, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(shipment.status, "deleting");
  assert.equal(cancelEffect.status, "needs_review");
});

test("provider absence is terminal only after a durable prior DELETE attempt", async () => {
  const cancelEffect = effect("cdek_cancel");
  const shipment: FakeShipment = {
    id: 30,
    order_id: orderId,
    status: "created",
    cdek_uuid: "ambiguous-delete-uuid",
    cdek_number: null,
  };
  const state: FakeState = { effects: [cancelEffect], shipments: [shipment] };
  const db = fakeEffectDb(state);
  let deleteCalls = 0;

  const first = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-ambiguous-delete",
      limit: 1,
      getOrder: async (_config, uuid) => exactCdekOrder(uuid),
      cancelOrder: async () => {
        deleteCalls += 1;
        throw new TypeError("connection closed after request write");
      },
    },
  );

  assert.equal(first.retried, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(shipment.status, "deleting");
  assert.equal(cancelEffect.payload.providerDeleteAttempted, true);

  const transient = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-preserve-delete-proof",
      limit: 1,
      getOrder: async () => {
        throw new TypeError("temporary exact lookup failure");
      },
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
    },
  );

  assert.equal(transient.retried, 1);
  assert.equal(cancelEffect.payload.providerDeleteAttempted, true);
  assert.equal(shipment.status, "deleting");

  const confirmed = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-confirm-ambiguous-delete",
      limit: 1,
      getOrder: async () => {
        throw new HttpError(400, "cdek_request_failed", "Not found", {
          providerStatus: 404,
        });
      },
      getOrderByImNumber: async () => null,
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
    },
  );

  assert.equal(confirmed.completed, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(shipment.status, "deleted");
  assert.equal(cancelEffect.status, "completed");
});

test("absence before any DELETE stays retryable and never marks local deletion", async () => {
  const cancelEffect = effect("cdek_cancel");
  const shipment: FakeShipment = {
    id: 31,
    order_id: orderId,
    status: "created",
    cdek_uuid: "not-yet-visible-uuid",
    cdek_number: null,
  };
  const state: FakeState = { effects: [cancelEffect], shipments: [shipment] };

  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-absence-before-delete",
      limit: 1,
      getOrder: async () => {
        throw new HttpError(400, "cdek_request_failed", "Not found", {
          providerStatus: 404,
        });
      },
      getOrderByImNumber: async () => null,
      cancelOrder: async () => {
        throw new Error("DELETE must not run without a verified identity");
      },
    },
  );

  assert.equal(result.retried, 1);
  assert.equal(shipment.status, "deleting");
  assert.equal(cancelEffect.status, "retry");
  assert.equal(cancelEffect.payload.providerDeleteAttempted, false);
});

test("cancel effect keeps ACCEPTED deletion pending, then confirms a GET 404", async () => {
  const cancelEffect = effect("cdek_cancel");
  const shipment: FakeShipment = {
    id: 11,
    order_id: orderId,
    status: "created",
    cdek_uuid: "cdek-order-uuid",
    cdek_number: "1234567890",
  };
  const state: FakeState = { effects: [cancelEffect], shipments: [shipment] };
  const db = fakeEffectDb(state);
  let deleteCalls = 0;
  let getCalls = 0;

  const accepted = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-test",
      limit: 1,
      cancelOrder: async (_config, uuid) => {
        deleteCalls += 1;
        assert.equal(uuid, "cdek-order-uuid");
        return {
          entity: { uuid },
          requests: [{ type: "DELETE", state: "ACCEPTED", request_uuid: "delete-1" }],
        };
      },
      getOrder: async (_config, uuid) => exactCdekOrder(uuid),
    },
  );

  assert.deepEqual(accepted, {
    claimed: 1,
    completed: 0,
    retried: 1,
    needsReview: 0,
    canceled: 0,
  });
  assert.equal(deleteCalls, 1);
  assert.equal(shipment.status, "deleting");
  assert.equal(cancelEffect.status, "retry");
  assert.equal(
    (cancelEffect.payload.cdekCancellation as Record<string, unknown>).state,
    "ACCEPTED",
  );

  const confirmed = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-test",
      limit: 1,
      cancelOrder: async () => {
        throw new Error("DELETE must not repeat after GET confirms deletion");
      },
      getOrder: async (_config, uuid) => {
        getCalls += 1;
        assert.equal(uuid, "cdek-order-uuid");
        throw new HttpError(400, "cdek_request_failed", "Order not found", {
          providerStatus: 404,
        });
      },
      getOrderByImNumber: async () => null,
    },
  );

  assert.equal(confirmed.completed, 1);
  assert.equal(getCalls, 1);
  assert.equal(shipment.status, "deleted");
  assert.equal(cancelEffect.status, "completed");
});

test("cancel provider failures retry or require review without escaping processor", async () => {
  const retryState: FakeState = {
    effects: [effect("cdek_cancel")],
    shipments: [
      {
        id: 12,
        order_id: orderId,
        status: "created",
        cdek_uuid: "retry-uuid",
        cdek_number: null,
      },
    ],
  };
  const retryResult = await processCdekEffects(
    { config: config(), db: fakeEffectDb(retryState) },
    {
      workerId: "worker-retry",
      limit: 1,
      getOrder: async (_config, uuid) => exactCdekOrder(uuid),
      cancelOrder: async () => {
        throw new HttpError(400, "cdek_request_failed", "Rate limited", {
          providerStatus: 429,
        });
      },
    },
  );
  assert.equal(retryResult.retried, 1);
  assert.equal(retryState.effects[0]?.status, "retry");
  assert.equal(retryState.shipments[0]?.status, "deleting");

  const reviewState: FakeState = {
    effects: [effect("cdek_cancel")],
    shipments: [
      {
        id: 13,
        order_id: orderId,
        status: "created",
        cdek_uuid: "review-uuid",
        cdek_number: null,
      },
    ],
  };
  const reviewResult = await processCdekEffects(
    { config: config(), db: fakeEffectDb(reviewState) },
    {
      workerId: "worker-review",
      limit: 1,
      getOrder: async (_config, uuid) => exactCdekOrder(uuid),
      cancelOrder: async () => ({
        requests: [
          {
            type: "DELETE",
            state: "INVALID",
            errors: [{ code: "order_status", message: "Order already moving" }],
          },
        ],
      }),
    },
  );
  assert.equal(reviewResult.needsReview, 1);
  assert.equal(reviewState.effects[0]?.status, "needs_review");
  assert.equal(reviewState.shipments[0]?.status, "deleting");
  assert.equal(
    (reviewState.effects[0]?.payload.cdekCancellation as Record<string, unknown>)
      .errorCode,
    "order_status",
  );
});

test("empty cancel reconciliation moves to needs_review after the bounded retry budget", async () => {
  const exhausted = effect("cdek_cancel");
  exhausted.attempts = 11;
  const state: FakeState = {
    effects: [exhausted],
    shipments: [
      {
        id: 14,
        order_id: orderId,
        status: "creating",
        cdek_uuid: null,
        cdek_number: null,
      },
    ],
  };

  let deleteCalls = 0;
  let createCalls = 0;
  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-exhausted",
      limit: 1,
      getOrderByImNumber: async () => null,
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
      createShipment: async () => {
        createCalls += 1;
        return null;
      },
    },
  );

  assert.equal(result.needsReview, 1);
  assert.equal(state.effects[0]?.attempts, 12);
  assert.equal(state.effects[0]?.status, "needs_review");
  assert.equal(state.shipments[0]?.status, "creating");
  assert.equal(deleteCalls, 0);
  assert.equal(createCalls, 0);
});

test("cancel effect completes idempotently when no shipment exists", async () => {
  const state: FakeState = { effects: [effect("cdek_cancel")], shipments: [] };
  let providerCalled = false;
  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-no-shipment",
      limit: 1,
      cancelOrder: async () => {
        providerCalled = true;
        return {};
      },
    },
  );

  assert.equal(result.completed, 1);
  assert.equal(providerCalled, false);
  assert.equal(state.effects[0]?.status, "completed");
  assert.equal(state.effects[0]?.payload.outcome, "no_shipment");
});

test("create effect uses current order outcome and cancels work after refund", async () => {
  const state: FakeState = { effects: [effect("cdek_create")], shipments: [] };
  let calls = 0;
  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-create",
      limit: 1,
      createShipment: async (_context, input) => {
        calls += 1;
        assert.equal(input.orderId, orderId);
        return null;
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.canceled, 1);
  assert.equal(state.effects[0]?.status, "canceled");
  assert.equal(state.effects[0]?.payload.outcome, "order_not_fulfillable");
});

test("create effect keeps ACCEPTED pending until provider reconciliation is terminal", async (context) => {
  for (const terminalStatus of ["created", "invalid"] as const) {
    await context.test(`ACCEPTED -> ${terminalStatus}`, async () => {
      const createEffect = effect("cdek_create");
      const state: FakeState = { effects: [createEffect], shipments: [] };
      let calls = 0;
      const createShipment = async () => {
        calls += 1;
        return {
          id: 16,
          order_id: orderId,
          status: calls === 1 ? ("accepted" as const) : terminalStatus,
          cdek_uuid: "accepted-effect-uuid",
          cdek_number: terminalStatus === "created" ? "6666666666" : null,
        };
      };

      const accepted = await processCdekEffects(
        { config: config(), db: fakeEffectDb(state) },
        {
          workerId: `worker-accepted-${terminalStatus}`,
          limit: 1,
          createShipment,
        },
      );

      assert.equal(accepted.retried, 1);
      assert.equal(accepted.completed, 0);
      assert.equal(createEffect.status, "retry");

      const reconciled = await processCdekEffects(
        { config: config(), db: fakeEffectDb(state) },
        {
          workerId: `worker-terminal-${terminalStatus}`,
          limit: 1,
          createShipment,
        },
      );

      assert.equal(calls, 2);
      if (terminalStatus === "created") {
        assert.equal(reconciled.completed, 1);
        assert.equal(createEffect.status, "completed");
      } else {
        assert.equal(reconciled.needsReview, 1);
        assert.equal(createEffect.status, "needs_review");
      }
    });
  }
});

test("refund cancellation waits for a timed-out create, adopts it, then deletes it", async () => {
  const createEffect = effect("cdek_create", "retry", 1);
  const shipment: FakeShipment = {
    id: 17,
    order_id: orderId,
    status: "failed",
    cdek_uuid: null,
    cdek_number: null,
  };
  const state: FakeState = { effects: [createEffect], shipments: [shipment] };
  const db = fakeEffectDb(state);
  const cancelEffect = await enqueueCdekEffect(
    db as never,
    "cdek_cancel",
    orderId,
    { provider_status: "REFUNDED" },
  );
  let lookupCalls = 0;
  let deleteCalls = 0;
  let createCalls = 0;

  const first = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-refund-lookup-empty",
      limit: 1,
      createShipment: async () => {
        createCalls += 1;
        throw new Error("Cancellation reconciliation must never create again");
      },
      getOrderByImNumber: async (_config, number) => {
        lookupCalls += 1;
        assert.equal(number, orderNumber);
        return null;
      },
      cancelOrder: async () => {
        deleteCalls += 1;
        return {};
      },
    },
  );

  assert.equal(createEffect.status, "canceled");
  assert.equal(cancelEffect.status, "retry");
  assert.equal(first.retried, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(shipment.status, "failed");

  const second = await processCdekEffects(
    { config: config(), db },
    {
      workerId: "worker-refund-provider-visible",
      limit: 1,
      createShipment: async () => {
        createCalls += 1;
        throw new Error("Cancellation reconciliation must never create again");
      },
      getOrderByImNumber: async (_config, number) => {
        lookupCalls += 1;
        assert.equal(number, orderNumber);
        return {
          entity: {
            uuid: "late-visible-cdek-uuid",
            im_number: number,
            cdek_number: "7777777777",
          },
          requests: [{ type: "GET", state: "SUCCESSFUL" }],
        };
      },
      getOrder: async (_config, uuid) => exactCdekOrder(uuid),
      cancelOrder: async (_config, uuid) => {
        deleteCalls += 1;
        assert.equal(uuid, "late-visible-cdek-uuid");
        return {
          entity: { uuid },
          requests: [{ type: "DELETE", state: "SUCCESSFUL" }],
        };
      },
    },
  );

  assert.equal(second.completed, 1);
  assert.equal(lookupCalls, 2);
  assert.equal(deleteCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(cancelEffect.status, "completed");
  assert.equal(shipment.status, "deleted");
  assert.equal(shipment.cdek_uuid, "late-visible-cdek-uuid");
  assert.equal(shipment.cdek_number, "7777777777");
});

test("cancel reconciliation rejects a mismatching merchant order without DELETE", async () => {
  const cancelEffect = effect("cdek_cancel");
  const shipment: FakeShipment = {
    id: 18,
    order_id: orderId,
    status: "failed",
    cdek_uuid: null,
    cdek_number: null,
  };
  const state: FakeState = { effects: [cancelEffect], shipments: [shipment] };
  let providerCalled = false;

  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-ambiguous-refund",
      limit: 1,
      getOrderByImNumber: async () => ({
        entity: {
          uuid: "foreign-cdek-uuid",
          number: "KOM-DIFFERENT",
        },
        requests: [{ type: "GET", state: "SUCCESSFUL" }],
      }),
      cancelOrder: async () => {
        providerCalled = true;
        return {};
      },
    },
  );

  assert.equal(result.completed, 0);
  assert.equal(result.needsReview, 1);
  assert.equal(cancelEffect.status, "needs_review");
  assert.equal(shipment.status, "failed");
  assert.equal(shipment.cdek_uuid, null);
  assert.equal(providerCalled, false);
});

test("ambiguous CDEK create reconciliation moves the effect to needs_review", async () => {
  const state: FakeState = { effects: [effect("cdek_create")], shipments: [] };
  const result = await processCdekEffects(
    { config: config(), db: fakeEffectDb(state) },
    {
      workerId: "worker-create-review",
      limit: 1,
      createShipment: async () => {
        throw new HttpError(
          409,
          "cdek_reconciliation_mismatch",
          "CDEK lookup returned a different merchant order",
        );
      },
    },
  );

  assert.equal(result.needsReview, 1);
  assert.equal(state.effects[0]?.status, "needs_review");
  assert.equal(state.effects[0]?.payload.outcome, "provider_rejected");
});

test("createCdekShipmentForOrder does not create on authorized payment", async () => {
  let itemsQueried = false;
  const db = {
    query: async (sql: string) => {
      if (sql.includes("from public.merch_customer_orders")) {
        return {
          rows: [
            {
              id: orderId,
              order_number: "KOM-123456789",
              status: "authorized",
              customer_first_name: "Test",
              customer_last_name: "Customer",
              customer_phone: "+79990000000",
              delivery_point_code: "PVZ-1",
              delivery_city: "Test",
              delivery_address: "Test",
              metadata: {},
            },
          ],
        };
      }
      if (sql.includes("from public.merch_cdek_shipments")) return { rows: [] };
      if (sql.includes("from public.merch_customer_order_items")) {
        itemsQueried = true;
      }
      return { rows: [] };
    },
  } as unknown as Db;

  const shipment = await createCdekShipmentForOrder(
    { config: config(), db },
    { orderId },
  );

  assert.equal(shipment, null);
  assert.equal(itemsQueried, false);
});

test("createCdekShipmentForOrder rechecks payment before the provider request", async () => {
  let initialOrderReads = 0;
  let statusRechecks = 0;
  const db = {
    query: async (sql: string) => {
      if (
        sql.includes("select status") &&
        sql.includes("from public.merch_customer_orders")
      ) {
        statusRechecks += 1;
        return { rows: [{ status: "refunded" }] };
      }
      if (sql.includes("from public.merch_customer_orders")) {
        initialOrderReads += 1;
        return {
          rows: [
            {
              id: orderId,
              order_number: "KOM-123456789",
              status: "paid",
              customer_first_name: "Test",
              customer_last_name: "Customer",
              customer_phone: "+79990000000",
              delivery_point_code: "PVZ-1",
              delivery_city: "Test",
              delivery_address: "Test",
              metadata: {},
            },
          ],
        };
      }
      if (
        sql.includes("from public.merch_cdek_shipments") &&
        !sql.includes("update public.merch_cdek_shipments")
      ) {
        return { rows: [] };
      }
      if (sql.includes("from public.merch_customer_order_items")) {
        return {
          rows: [
            {
              product_id: null,
              offer_id: "offer-1",
              sku: "sku-1",
              product_name: "Футболка",
              size: "M",
              quantity: 1,
              unit_price_amount: 300_000,
              product_snapshot: { product_type_slug: "tshirt" },
            },
          ],
        };
      }
      if (sql.includes("insert into public.merch_cdek_shipments")) {
        return {
          rows: [
            {
              id: 21,
              order_id: orderId,
              status: "creating",
              cdek_uuid: null,
              cdek_number: null,
            },
          ],
        };
      }
      if (
        sql.includes("update public.merch_cdek_shipments") &&
        sql.includes("order_not_fulfillable")
      ) {
        return {
          rows: [
            {
              id: 21,
              order_id: orderId,
              status: "deleted",
              cdek_uuid: null,
              cdek_number: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as Db;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config({ CDEK_TARIFF_CODE: "136" }),
      db,
    },
    { orderId },
  );

  assert.equal(initialOrderReads, 1);
  assert.equal(statusRechecks, 1);
  assert.equal(shipment?.status, "deleted");
  assert.equal(shipment?.cdek_uuid, null);
});
