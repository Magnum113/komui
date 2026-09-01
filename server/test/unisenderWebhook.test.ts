import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import {
  computeUnisenderWebhookAuth,
  verifyUnisenderWebhookAuth,
} from "../src/email/unisenderWebhook";

const API_KEY = "project-api-key-used-for-webhook-tests";

type SuppressionState = {
  reason: string;
  source: string;
  providerEventId: string;
};

function compactSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function fakeDb() {
  const state = {
    suppressions: new Map<string, SuppressionState>(),
    outbox: [
      {
        email: "buyer@example.com",
        messageClass: "marketing",
        status: "pending",
      },
      {
        email: "buyer@example.com",
        messageClass: "marketing",
        status: "retry",
      },
      {
        email: "buyer@example.com",
        messageClass: "transactional",
        status: "pending",
      },
      {
        email: "other@example.com",
        messageClass: "marketing",
        status: "pending",
      },
    ],
    queryLog: [] as string[],
  };

  const priority = (reason: string) =>
    ({ manual: 40, spam_complaint: 30, hard_bounce: 20, unsubscribed: 10 })[
      reason
    ] ?? 0;

  const query = async (sql: string, values: unknown[] = []) => {
    const normalized = compactSql(sql);
    state.queryLog.push(normalized);
    if (normalized.includes("/* email_webhook:upsert_suppression */")) {
      const actions = JSON.parse(String(values[0])) as Array<{
        email: string;
        reason: string;
        provider_event_id: string;
      }>;
      for (const action of actions) {
        const current = state.suppressions.get(action.email);
        if (!current || priority(action.reason) >= priority(current.reason)) {
          state.suppressions.set(action.email, {
            reason: action.reason,
            source: "unisender_go_webhook",
            providerEventId: action.provider_event_id,
          });
        }
      }
      return { rows: [], rowCount: actions.length };
    }
    if (normalized.includes("/* email_webhook:cancel_marketing */")) {
      const actions = JSON.parse(String(values[0])) as Array<{
        email: string;
        reason: string;
      }>;
      const emails = new Set(actions.map((action) => action.email));
      let rowCount = 0;
      for (const row of state.outbox) {
        if (
          emails.has(row.email) &&
          row.messageClass === "marketing" &&
          ["pending", "retry"].includes(row.status)
        ) {
          row.status = "cancelled";
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    }
    throw new Error(`Unexpected SQL in webhook test: ${normalized}`);
  };

  const client = { query } as unknown as PoolClient;
  const db = {
    query,
    withTransaction: async <T>(callback: (value: PoolClient) => Promise<T>) =>
      callback(client),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;

  return { db, state };
}

function signedBody(
  eventsByUser: Array<Record<string, unknown>>,
  apiKey = API_KEY,
) {
  const placeholder = "0".repeat(32);
  const unsigned = JSON.stringify(
    { auth: placeholder, events_by_user: eventsByUser },
    null,
    2,
  );
  const auth = computeUnisenderWebhookAuth(unsigned, apiKey);
  assert.ok(auth);
  return unsigned.replace(placeholder, auth);
}

function event(status: string, email = "buyer@example.com") {
  return {
    event_name: "transactional_email_status",
    event_data: {
      job_id: `job-${status}`,
      email,
      status,
      event_time: "2026-09-01 10:00:00",
    },
  };
}

function user(events: Array<Record<string, unknown>>, userId = 456) {
  return {
    user_id: userId,
    project_id: "6432890213745872",
    project_name: "KOMUI",
    events,
  };
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    UNISENDER_GO_API_KEY: API_KEY,
    UNISENDER_GO_WEBHOOK_ENABLED: "true",
    ...overrides,
  });
}

test("Unisender webhook auth preserves the exact JSON representation", () => {
  const raw = signedBody([user([event("unsubscribed")])]);
  const parsed = JSON.parse(raw) as { auth: string };

  assert.equal(verifyUnisenderWebhookAuth(raw, parsed.auth, API_KEY), true);
  assert.equal(
    verifyUnisenderWebhookAuth(raw.replace("KOMUI", "KOMUI changed"), parsed.auth, API_KEY),
    false,
  );
  assert.equal(computeUnisenderWebhookAuth('{"auth":"a","auth":"b"}', API_KEY), null);

  const nestedAuth = signedBody([
    user([
      {
        ...event("opened"),
        event_data: {
          ...event("opened").event_data,
          metadata: { auth: "customer-defined-metadata" },
        },
      },
    ]),
  ]);
  const nestedParsed = JSON.parse(nestedAuth) as { auth: string };
  assert.equal(
    verifyUnisenderWebhookAuth(nestedAuth, nestedParsed.auth, API_KEY),
    true,
  );
});

test("Unisender webhook exposes the provider GET check without configuration details", async () => {
  const { db } = fakeDb();
  const app = buildApp({ config: config(), db });

  const response = await app.inject({
    method: "GET",
    url: "/v1/webhooks/unisender-go",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(response.headers["cache-control"], "no-store");
  await app.close();
});

test("Unisender webhook rejects disabled or invalidly signed callbacks before DB access", async () => {
  const raw = signedBody([user([event("unsubscribed")])]);

  const disabledDb = fakeDb();
  const disabledApp = buildApp({
    config: config({ UNISENDER_GO_WEBHOOK_ENABLED: "false" }),
    db: disabledDb.db,
  });
  const disabled = await disabledApp.inject({
    method: "POST",
    url: "/v1/webhooks/unisender-go",
    headers: { "content-type": "application/json" },
    payload: raw,
  });
  assert.equal(disabled.statusCode, 503);
  assert.equal(disabledDb.state.queryLog.length, 0);
  await disabledApp.close();

  const invalidDb = fakeDb();
  const invalidApp = buildApp({ config: config(), db: invalidDb.db });
  const invalid = await invalidApp.inject({
    method: "POST",
    url: "/v1/webhooks/unisender-go",
    headers: { "content-type": "application/json" },
    payload: raw.replace('"status": "unsubscribed"', '"status": "spam"'),
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalidDb.state.queryLog.length, 0);
  await invalidApp.close();
});

test("Unisender suppression events are normalized, prioritized and cancel only queued marketing", async () => {
  const { db, state } = fakeDb();
  const duplicateUnsubscribe = event("unsubscribed", " Buyer@Example.COM ");
  const raw = signedBody([
    user([
      duplicateUnsubscribe,
      duplicateUnsubscribe,
      event("opened"),
      event("hard_bounced", "BUYER@example.com"),
      event("spam", "other@example.com"),
      {
        event_name: "transactional_spam_block",
        event_data: { domain: "example.com", domain_status: "blocked" },
      },
    ]),
  ]);
  const app = buildApp({ config: config(), db });

  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/unisender-go",
    headers: { "content-type": "application/json" },
    payload: raw,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(state.suppressions.size, 2);
  assert.equal(state.suppressions.get("buyer@example.com")?.reason, "hard_bounce");
  assert.equal(state.suppressions.get("other@example.com")?.reason, "spam_complaint");
  assert.match(
    state.suppressions.get("buyer@example.com")?.providerEventId ?? "",
    /^unisender:[a-f0-9]{64}$/,
  );
  assert.deepEqual(
    state.outbox.map((row) => row.status),
    ["cancelled", "cancelled", "pending", "cancelled"],
  );
  assert.equal(state.queryLog.length, 2);

  const replay = await app.inject({
    method: "POST",
    url: "/v1/webhooks/unisender-go",
    headers: { "content-type": "application/json" },
    payload: raw,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(state.suppressions.size, 2);
  assert.equal(state.queryLog.length, 4);
  assert.deepEqual(
    state.outbox.map((row) => row.status),
    ["cancelled", "cancelled", "pending", "cancelled"],
  );
  await app.close();
});

test("Unisender webhook never weakens a manual suppression", async () => {
  const { db, state } = fakeDb();
  state.suppressions.set("buyer@example.com", {
    reason: "manual",
    source: "operator",
    providerEventId: "manual-1",
  });
  const app = buildApp({ config: config(), db });
  const raw = signedBody([user([event("spam")])]);

  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks/unisender-go",
    headers: { "content-type": "application/json" },
    payload: raw,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(state.suppressions.get("buyer@example.com"), {
    reason: "manual",
    source: "operator",
    providerEventId: "manual-1",
  });
  assert.deepEqual(
    state.outbox.slice(0, 3).map((row) => row.status),
    ["cancelled", "cancelled", "pending"],
  );
  await app.close();
});

test("Unisender poison events are ignored while a batch above 100 is rejected", async () => {
  const { db, state } = fakeDb();
  const app = buildApp({ config: config(), db });
  const invalidAddress = signedBody([
    user([event("unsubscribed", "not-an-email"), event("soft_bounced")]),
  ]);

  const ignored = await app.inject({
    method: "POST",
    url: "/v1/webhooks/unisender-go",
    headers: { "content-type": "application/json" },
    payload: invalidAddress,
  });
  assert.equal(ignored.statusCode, 200);
  assert.equal(state.suppressions.size, 0);

  const tooMany = signedBody([
    user(Array.from({ length: 60 }, (_, index) => event("opened", `a${index}@example.com`)), 1),
    user(Array.from({ length: 60 }, (_, index) => event("opened", `b${index}@example.com`)), 2),
  ]);
  const rejected = await app.inject({
    method: "POST",
    url: "/v1/webhooks/unisender-go",
    headers: { "content-type": "application/json" },
    payload: tooMany,
  });
  assert.equal(rejected.statusCode, 400);
  await app.close();
});
