import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { Db } from "../src/db";
import { subscribeFooterEmailContact } from "../src/email/subscriptions";

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
