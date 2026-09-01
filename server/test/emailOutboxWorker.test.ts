import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import {
  emailWorkerConfigurationError,
  processEmailOutbox,
  startEmailOutboxWorker,
} from "../src/email/outboxWorker";
import { EmailProviderError } from "../src/email/unisenderGo";

const rowId = "5d703bc3-028f-4c4e-bf87-130c8294b991";
const orderId = "7c169f01-b459-4e25-b74f-a4909a1b4149";

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "staging",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    EMAIL_ENABLED: "true",
    EMAIL_WORKER_ENABLED: "true",
    EMAIL_TEST_MODE: "true",
    EMAIL_ALLOWED_RECIPIENTS: "owner@example.com",
    EMAIL_FROM: "hello@komui.ru",
    EMAIL_REPLY_TO: "reply@example.com",
    UNISENDER_GO_API_KEY: "secret-project-api-key",
    ...overrides,
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    customerFirstName: "Иван",
    orderNumber: "KOM-123456789",
    items: [
      {
        name: "Футболка KOMUI",
        size: "L",
        quantity: 1,
        lineTotalAmount: 290_000,
      },
    ],
    subtotalAmount: 290_000,
    discountAmount: 0,
    deliveryAmount: 35_000,
    totalAmount: 325_000,
    currency: "RUB",
    deliveryCity: "Москва",
    deliveryAddress: "Пункт СДЭК",
    deliveryEta: "2–4 дня",
    ...overrides,
  };
}

function fakeOutbox(options: {
  payload?: unknown;
  attemptCount?: number;
  suppression?: string | null;
} = {}) {
  const state = {
    status: "pending",
    attemptCount: options.attemptCount ?? 0,
    lockedBy: null as string | null,
    providerMessageId: null as string | null,
    lastError: null as string | null,
    retryDelay: null as number | null,
    queryLog: [] as string[],
  };
  const query = async (sql: string, values: unknown[] = []) => {
    state.queryLog.push(sql);
    if (sql.includes("email_outbox:claim")) {
      if (!["pending", "retry", "processing"].includes(state.status)) {
        return { rows: [] };
      }
      state.status = "processing";
      state.attemptCount += 1;
      state.lockedBy = String(values[0]);
      return {
        rows: [
          {
            id: rowId,
            order_id: orderId,
            event_type: "order_paid",
            message_class: "transactional",
            recipient_email: "owner@example.com",
            template_key: "order_paid",
            payload: options.payload ?? payload(),
            attempt_count: state.attemptCount,
            idempotency_key: `order-paid:${orderId}`,
            locked_by: state.lockedBy,
          },
        ],
      };
    }
    if (sql.includes("email_outbox:suppression")) {
      return {
        rows: options.suppression ? [{ reason: options.suppression }] : [],
      };
    }
    if (sql.includes("email_outbox:sent")) {
      assert.equal(values[1], state.lockedBy);
      state.status = "sent";
      state.providerMessageId = values[2] ? String(values[2]) : null;
      state.lastError = values[3] ? String(values[3]) : null;
      state.lockedBy = null;
      return { rows: [] };
    }
    if (sql.includes("email_outbox:retry")) {
      assert.equal(values[1], state.lockedBy);
      state.status = "retry";
      state.lastError = String(values[2]);
      state.retryDelay = Number(values[3]);
      state.lockedBy = null;
      return { rows: [] };
    }
    if (sql.includes("email_outbox:failed")) {
      assert.equal(values[1], state.lockedBy);
      state.status = "failed";
      state.lastError = String(values[2]);
      state.lockedBy = null;
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const db = {
    query,
    withTransaction: async <T>(callback: (client: PoolClient) => Promise<T>) =>
      callback({ query } as unknown as PoolClient),
  } as unknown as Db;
  return { db, state };
}

test("email worker claims with SKIP LOCKED and marks provider acceptance sent", async () => {
  const { db, state } = fakeOutbox();
  const requests: unknown[] = [];
  const result = await processEmailOutbox(
    { config: config(), db },
    {
      limit: 1,
      workerId: "worker-a",
      sender: {
        send: async (request) => {
          requests.push(request);
          return {
            provider: "unisender_go",
            providerMessageId: "provider-job-1",
            accepted: true,
          };
        },
      },
    },
  );

  assert.deepEqual(result, {
    claimed: 1,
    sent: 1,
    retried: 0,
    failed: 0,
    deduplicated: 0,
    suppressed: 0,
  });
  assert.equal(state.status, "sent");
  assert.equal(state.providerMessageId, "provider-job-1");
  assert.equal(requests.length, 1);
  assert.match(state.queryLog[0], /for update skip locked/i);
  assert.match(state.queryLog[0], /coalesce\(locked_at, updated_at, created_at\)/i);
});

test("temporary provider failures use bounded backoff and eventually fail", async () => {
  const first = fakeOutbox();
  const temporarySender = {
    send: async () => {
      throw new EmailProviderError(
        "temporary",
        "email_provider_network_error",
        "network unavailable",
      );
    },
  };
  const retried = await processEmailOutbox(
    { config: config(), db: first.db },
    { limit: 1, workerId: "worker-a", sender: temporarySender },
  );
  assert.equal(retried.retried, 1);
  assert.equal(first.state.status, "retry");
  assert.equal(first.state.retryDelay, 5 * 60_000);

  const exhausted = fakeOutbox({ attemptCount: 3 });
  const failed = await processEmailOutbox(
    { config: config(), db: exhausted.db },
    { limit: 1, workerId: "worker-b", sender: temporarySender },
  );
  assert.equal(failed.failed, 1);
  assert.equal(exhausted.state.status, "failed");
  assert.equal(exhausted.state.lastError, "email_provider_network_error");
});

test("provider duplicate after an ambiguous retry is finalized without resending", async () => {
  const { db, state } = fakeOutbox({ attemptCount: 1 });
  const result = await processEmailOutbox(
    { config: config(), db },
    {
      limit: 1,
      workerId: "worker-a",
      sender: {
        send: async () => {
          throw new EmailProviderError(
            "duplicate",
            "email_provider_duplicate",
            "already accepted",
          );
        },
      },
    },
  );

  assert.equal(result.sent, 1);
  assert.equal(result.deduplicated, 1);
  assert.equal(state.status, "sent");
  assert.equal(state.lastError, "email_provider_duplicate_idempotency_key");
});

test("invalid snapshots and hard-bounced recipients never call the provider", async (t) => {
  for (const scenario of [
    { name: "invalid payload", database: fakeOutbox({ payload: {} }) },
    {
      name: "hard bounce",
      database: fakeOutbox({ suppression: "hard_bounce" }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      let sendCalled = false;
      const result = await processEmailOutbox(
        { config: config(), db: scenario.database.db },
        {
          limit: 1,
          workerId: "worker-a",
          sender: {
            send: async () => {
              sendCalled = true;
              throw new Error("must not send");
            },
          },
        },
      );
      assert.equal(result.failed, 1);
      assert.equal(sendCalled, false);
      assert.equal(scenario.database.state.status, "failed");
    });
  }
});

test("disabled worker does not touch the database", async () => {
  let queried = false;
  const db = {
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  } as unknown as Db;
  const stop = startEmailOutboxWorker({
    config: config({ EMAIL_WORKER_ENABLED: "false" }),
    db,
  });
  await stop();
  assert.equal(queried, false);
});

test("worker configuration guard refuses unsafe startup before claiming jobs", () => {
  assert.equal(
    emailWorkerConfigurationError(
      config({ EMAIL_ENABLED: "false", EMAIL_WORKER_ENABLED: "true" }),
    ),
    "EMAIL_WORKER_ENABLED requires EMAIL_ENABLED=true",
  );
  assert.equal(
    emailWorkerConfigurationError(
      config({ EMAIL_TEST_MODE: "false", EMAIL_WORKER_ENABLED: "true" }),
    ),
    "Non-production email worker requires EMAIL_TEST_MODE=true",
  );
  assert.equal(
    emailWorkerConfigurationError(
      config({
        EMAIL_TEST_MODE: "true",
        EMAIL_ALLOWED_RECIPIENTS: "",
        EMAIL_WORKER_ENABLED: "true",
      }),
    ),
    "Email test mode requires a non-empty recipient allowlist",
  );
});
