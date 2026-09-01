import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config";
import { enqueueStageOrderPaidAcceptance } from "../src/emailStageAcceptance";

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

test("staging acceptance queues a synthetic order_paid only for the allowlist", async () => {
  let capturedValues: unknown[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      assert.match(sql, /insert into public\.merch_email_outbox/i);
      assert.match(sql, /order_id[\s\S]*null/i);
      capturedValues = values;
      return { rows: [{ id: "outbox-id", status: "pending" }] };
    },
  };

  const result = await enqueueStageOrderPaidAcceptance(
    config(),
    db as never,
    "Owner@Example.com",
    "12345678-abcd-4abc-8abc-1234567890ab",
  );

  assert.deepEqual(result, {
    outboxId: "outbox-id",
    status: "pending",
    recipient: "o***@e***.com",
    orderNumber: "STAGE-EMAIL-12345678",
  });
  assert.equal(capturedValues[0], "owner@example.com");
  assert.equal(String(capturedValues[1]).includes("Тестовое письмо KOMUI"), true);
  assert.equal(String(capturedValues[2]).startsWith("stage-acceptance:"), true);
  assert.equal(JSON.stringify(result).includes("owner@example.com"), false);
});

test("staging acceptance fails closed outside staging and outside allowlist", async () => {
  let queried = false;
  const db = {
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  };

  await assert.rejects(
    () =>
      enqueueStageOrderPaidAcceptance(
        config({ NODE_ENV: "production" }),
        db as never,
        "owner@example.com",
      ),
    /restricted to staging/,
  );
  await assert.rejects(
    () =>
      enqueueStageOrderPaidAcceptance(
        config(),
        db as never,
        "buyer@example.net",
      ),
    /not in the staging allowlist/,
  );
  assert.equal(queried, false);
});
