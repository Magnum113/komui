import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { Db } from "../src/db";
import {
  confirmFooterEmailSubscription,
  subscribeFooterEmailContact,
} from "../src/email/subscriptions";
import { renderSubscriptionConfirmationEmail } from "../src/email/templates/subscription-confirmation";

const contactId = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const evidence = {
  requestIpHash: "a".repeat(64),
  userAgent: "KOMUI test browser",
};

test("footer subscription immediately grants consent without a confirmation email", async () => {
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
          marketing_status: "not_subscribed",
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

  const result = await subscribeFooterEmailContact(
    { db },
    { email: " Buyer@Example.COM ", evidence },
    {
      now: new Date("2026-09-01T12:00:00.000Z"),
      eventNonce: "single-opt-in-event-0001",
    },
  );

  assert.deepEqual(result, { subscribed: true });
  assert.equal(queries.some((sql) => sql.includes("remove_footer_unsubscribe")), true);
  assert.equal(queries.some((sql) => sql.includes("footer_subscribe")), true);
  assert.equal(queries.some((sql) => sql.includes("footer_granted_event")), true);
  assert.equal(queries.some((sql) => sql.includes("enqueue_confirmation")), false);
  assert.equal(queries.some((sql) => /merch_email_outbox/.test(sql)), false);
  const eventIndex = queries.findIndex((sql) => sql.includes("footer_granted_event"));
  assert.match(queries[eventIndex], /'granted'/);
  assert.match(queries[eventIndex], /jsonb_build_object\('single_opt_in', true\)/);
  assert.match(String(payloads[eventIndex][0]), /^footer-granted:/);
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
    { db },
    { token: "C".repeat(43), evidence },
    { now: new Date("2026-09-01T12:05:00.000Z") },
  );

  assert.deepEqual(result, { confirmed: true, alreadyConfirmed: false });
  assert.match(
    queries.find((sql) => sql.includes("remove_confirmed_unsubscribe")) ?? "",
    /private\.merch_remove_unsubscribed_email_suppression/,
  );
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
  assert.match(rendered.html, /href="\{\{UnsubscribeUrl\}\}"/);
  assert.match(rendered.html, />Отписаться</);
  assert.match(rendered.text, /Ссылка действует 24 часа/);
  assert.match(rendered.text, /Отписаться: \{\{UnsubscribeUrl\}\}/);
  assert.doesNotMatch(rendered.html, /Это сообщение было отправлено/i);
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
