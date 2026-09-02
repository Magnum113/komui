import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { upsertCheckoutEmailContact } from "../src/email/contacts";

const contactId = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const orderId = "fa187b7f-3cd1-4fec-96ac-06a92fa0ba2c";
const consentAt = "2026-09-02T13:43:44.000Z";

test("checkout consent succeeds through the restricted suppression function", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });

    if (/delete\s+from\s+public\.merch_email_suppressions/i.test(sql)) {
      throw new Error("simulated komui_app DELETE denial");
    }
    if (sql.includes("checkout_suppression")) return { rows: [] };
    if (sql.includes("checkout_lock")) {
      return {
        rows: [{ id: contactId, marketing_status: "not_subscribed" }],
      };
    }
    if (sql.includes("checkout_update")) {
      return {
        rows: [{ id: contactId, marketing_status: "subscribed" }],
      };
    }
    return { rows: [] };
  };

  const result = await upsertCheckoutEmailContact(
    { query } as unknown as Pick<PoolClient, "query">,
    {
      orderId,
      email: " Buyer@Example.COM ",
      displayName: " Buyer Name ",
      marketingConsent: true,
      consentAt,
      consentVersion: "checkout-marketing-v1",
      consentSource: "checkout",
      evidence: {
        requestIpHash: "a".repeat(64),
        userAgent: "KOMUI checkout test browser",
      },
    },
  );

  assert.deepEqual(result, {
    contactId,
    marketingStatus: "subscribed",
  });

  const removalIndex = queries.findIndex(({ sql }) =>
    sql.includes("email_contacts:remove_checkout_unsubscribe")
  );
  const suppressionIndex = queries.findIndex(({ sql }) =>
    sql.includes("email_contacts:checkout_suppression")
  );
  assert.notEqual(removalIndex, -1);
  assert.match(
    queries[removalIndex].sql,
    /select\s+private\.merch_remove_unsubscribed_email_suppression\(\$1\)/i,
  );
  assert.deepEqual(queries[removalIndex].values, ["buyer@example.com"]);
  assert.equal(
    queries.some(({ sql }) =>
      /delete\s+from\s+public\.merch_email_suppressions/i.test(sql)
    ),
    false,
  );
  assert.equal(removalIndex < suppressionIndex, true);

  const consentEvent = queries.find(({ sql }) =>
    sql.includes("email_contacts:checkout_consent_event")
  );
  assert.ok(consentEvent);
  assert.equal(consentEvent.values[0], contactId);
  assert.equal(consentEvent.values[1], orderId);
  assert.equal(consentEvent.values[2], consentAt);
});
