import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import {
  confirmFooterEmailSubscription,
  requestFooterEmailSubscription,
} from "../src/email/subscriptions";
import { renderSubscriptionConfirmationEmail } from "../src/email/templates/subscription-confirmation";

const contactId = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const evidence = {
  requestIpHash: "a".repeat(64),
  userAgent: "KOMUI test browser",
};

function config() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    SITE_URL: "https://komui.ru",
  });
}

test("footer subscription creates a pending contact, evidence and confirmation outbox job", async () => {
  const queries: string[] = [];
  const payloads: unknown[][] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    payloads.push(values);
    if (sql.includes("footer_suppression")) return { rows: [] };
    if (sql.includes("footer_lock")) {
      return {
        rows: [{
          id: contactId,
          marketing_status: "pending",
          confirmation_sent_at: null,
        }],
      };
    }
    return { rows: [] };
  };
  const db = {
    query,
    withTransaction: async <T>(callback: (client: PoolClient) => Promise<T>) =>
      callback({ query } as unknown as PoolClient),
  } as unknown as Db;

  const result = await requestFooterEmailSubscription(
    { config: config(), db },
    { email: " Buyer@Example.COM ", evidence },
    {
      now: new Date("2026-09-01T12:00:00.000Z"),
      token: "T".repeat(43),
    },
  );

  assert.deepEqual(result, { queued: true });
  assert.equal(queries.some((sql) => sql.includes("footer_pending")), true);
  assert.equal(queries.some((sql) => sql.includes("footer_requested_event")), true);
  const outboxIndex = queries.findIndex((sql) => sql.includes("enqueue_confirmation"));
  assert.notEqual(outboxIndex, -1);
  assert.match(queries[outboxIndex], /'confirmationUrl', \$3::text/);
  assert.match(queries[outboxIndex], /'tokenFingerprint', \$4::text/);
  assert.equal(payloads[outboxIndex][1], "buyer@example.com");
  assert.match(String(payloads[outboxIndex][2]), /^https:\/\/komui\.ru\/email-confirm#token=/);
});

test("footer confirmation activates contact, removes unsubscribe and records immutable evidence", async () => {
  const queries: string[] = [];
  const query = async (sql: string) => {
    queries.push(sql);
    if (sql.includes("confirmation_lock")) {
      return { rows: [{ id: contactId, email_normalized: "buyer@example.com" }] };
    }
    if (sql.includes("confirmation_suppression")) {
      return { rows: [{ reason: "unsubscribed" }] };
    }
    return { rows: [] };
  };
  const db = {
    query,
    withTransaction: async <T>(callback: (client: PoolClient) => Promise<T>) =>
      callback({ query } as unknown as PoolClient),
  } as unknown as Db;

  const result = await confirmFooterEmailSubscription(
    { config: config(), db },
    { token: "C".repeat(43), evidence },
    { now: new Date("2026-09-01T12:05:00.000Z") },
  );

  assert.deepEqual(result, { confirmed: true, alreadyConfirmed: false });
  assert.equal(queries.some((sql) => sql.includes("remove_confirmed_unsubscribe")), true);
  assert.equal(queries.some((sql) => sql.includes("email_contacts:confirm")), true);
  assert.equal(queries.some((sql) => sql.includes("footer_confirmed_event")), true);
  assert.equal(queries.some((sql) => sql.includes("redact_confirmation_url")), true);
});

test("subscription confirmation template contains one safe KOMUI confirmation action", () => {
  const rendered = renderSubscriptionConfirmationEmail({
    confirmationUrl: `https://komui.ru/email-confirm#token=${"A".repeat(43)}`,
  });
  assert.match(rendered.subject, /Подтвердите подписку/);
  assert.match(rendered.html, /komui-wordmark-white/);
  assert.match(rendered.html, /Подтвердить подписку/);
  assert.match(rendered.text, /Ссылка действует 24 часа/);
  assert.doesNotMatch(rendered.html, /акци[яи]|промокод/i);
});

test("subscription confirmation template rejects external confirmation URLs", () => {
  assert.throws(
    () => renderSubscriptionConfirmationEmail({
      confirmationUrl: `https://evil.example/email-confirm#token=${"A".repeat(43)}`,
    }),
    /invalid URL/,
  );
});
