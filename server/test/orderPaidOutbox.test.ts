import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { enqueueOrderPaidEmail } from "../src/email/orderPaidOutbox";

const orderId = "7c169f01-b459-4e25-b74f-a4909a1b4149";

test("order_paid intent is inserted from the paid order snapshot with a stable key", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return {
      rows: [
        {
          id: "5d703bc3-028f-4c4e-bf87-130c8294b991",
          order_id: orderId,
          idempotency_key: `order-paid:${orderId}`,
          status: "pending",
        },
      ],
    };
  };

  const first = await enqueueOrderPaidEmail(
    { query } as unknown as Pick<PoolClient, "query">,
    orderId,
    {
      source: "tbank_webhook",
      payment_event_id: 42,
      ignored_object: { secret: true },
    },
  );
  const replay = await enqueueOrderPaidEmail(
    { query } as unknown as Pick<PoolClient, "query">,
    orderId,
    { source: "tbank_webhook" },
  );

  assert.equal(first?.idempotency_key, `order-paid:${orderId}`);
  assert.equal(replay.idempotency_key, `order-paid:${orderId}`);
  assert.match(calls[0].sql, /email_outbox:enqueue_order_paid/);
  assert.match(calls[0].sql, /orders\.status = 'paid'/);
  assert.match(calls[0].sql, /on conflict \(idempotency_key\) do nothing/);
  assert.match(calls[0].sql, /merch_customer_order_items/);
  assert.equal(calls[0].values[0], orderId);
  assert.deepEqual(JSON.parse(String(calls[0].values[1])), {
    source: "tbank_webhook",
    payment_event_id: 42,
  });
});

test("order_paid enqueue fails the transaction when a paid snapshot is missing", async () => {
  const query = async () => ({ rows: [] });
  await assert.rejects(
    () =>
      enqueueOrderPaidEmail(
        { query } as unknown as Pick<PoolClient, "query">,
        orderId,
      ),
    /snapshot is unavailable/,
  );
});

test("order_paid enqueue rejects a non-UUID before database access", async () => {
  let queried = false;
  const query = async () => {
    queried = true;
    return { rows: [] };
  };

  await assert.rejects(
    () =>
      enqueueOrderPaidEmail(
        { query } as unknown as Pick<PoolClient, "query">,
        "not-an-order-id",
      ),
    /must be a UUID/,
  );
  assert.equal(queried, false);
});
