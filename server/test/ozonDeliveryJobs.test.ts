import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import {
  processOzonEffects,
  syncOzonShipment,
  ozonActions,
  type OzonShipment,
} from "../src/ozonDeliveryJobs";
import type { Db } from "../src/db";
const id = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const config = () =>
  loadConfig({
    DATABASE_URL: "postgresql://test:test@localhost/test",
    OZON_DELIVERY_CLIENT_ID: "id",
    OZON_DELIVERY_CLIENT_SECRET: "secret",
    OZON_DELIVERY_SHIPMENT_METHOD_ID: "1020005031453430",
    OZON_DELIVERY_WORKER_ENABLED: "true",
  });
function fixture(status = "paid", provider = "ozon") {
  const order: any = {
    id,
    order_number: "KOM-1",
    delivery_provider: provider,
    status,
    fulfillment_status: "new",
    customer_phone: "+79990000000",
    customer_first_name: "Иван",
    customer_last_name: "Иванов",
    metadata: {
      ozon: {
        point: { delivery_point_id: 1 },
        posting: {
          request_id: 1,
          shipment_method_id: 1020005031453430,
          cutoff_at: "2030-10-01T12:00:00Z",
          declared_value: { amount: "2500.00", currency_code: "RUB" },
          dimensions: {
            weight_g: 250,
            length_mm: 300,
            width_mm: 230,
            height_mm: 40,
          },
        },
      },
    },
  };
  const state: any = {
    order,
    stored: null,
    shipments: [],
    claimed: false,
    effect: {
      id: "1",
      order_id: id,
      effect_type: "ozon_create",
      attempts: 1,
      payload: {},
      status: "pending",
    },
    enqueued: [],
    released: false,
    queries: [],
  };
  const query = async (sql: string, values: any[] = []) => {
    state.queries.push(sql);
    if (sql.startsWith("with candidate")) {
      if (state.claimed) return { rows: [] };
      state.claimed = true;
      return { rows: [structuredClone(state.effect)] };
    }
    if (sql.includes("pg_try_advisory_lock"))
      return { rows: [{ locked: true }] };
    if (
      sql.includes("pg_advisory_unlock") ||
      ["begin", "commit", "rollback"].includes(sql)
    )
      return { rows: [] };
    if (sql.includes("select * from public.merch_customer_orders"))
      return { rows: [order] };
    if (sql.includes("select idempotency_key"))
      return { rows: state.stored ? [state.stored] : [] };
    if (sql.includes("insert into public.merch_ozon_delivery_orders")) {
      state.stored = {
        idempotency_key: values[1],
        request_payload: JSON.parse(values[2]),
        external_order_number: null,
      };
      return { rows: [] };
    }
    if (sql.includes("update public.merch_ozon_delivery_orders")) {
      state.stored.external_order_number = values[1];
      return { rows: [] };
    }
    if (sql.includes("insert into public.merch_ozon_delivery_shipments")) {
      state.shipments.push({
        order_id: values[0],
        posting_number: values[1],
        external_order_number: values[2],
      });
      return { rows: [{ id: 1 }] };
    }
    if (sql.includes("select status from public.merch_customer_orders"))
      return { rows: [{ status: order.status }] };
    if (sql.includes("select * from public.merch_ozon_delivery_shipments"))
      return { rows: state.shipments };
    if (sql.includes("select 1 from public.merch_ozon_delivery_orders"))
      return { rows: state.stored ? [{ exists: 1 }] : [] };
    if (sql.includes("insert into public.merch_order_effects")) {
      state.enqueued.push({ type: values[1], payload: JSON.parse(values[3]) });
      return { rows: [{ id: 2 }] };
    }
    if (sql.includes("effect_type='ozon_approve'")) return { rows: [] };
    if (sql.includes("set status='completed'")) {
      if (values[2] !== JSON.stringify(state.effect.payload))
        return { rows: [] };
      state.effect.status = "completed";
      return { rows: [{ id: 1 }] };
    }
    if (sql.includes("set status='pending',locked_by=null")) {
      state.effect.status = "pending";
      return { rows: [] };
    }
    if (sql.includes("set status=case when payload=$6")) {
      state.effect.status = values[2];
      state.effect.error = values[3];
      return { rows: [] };
    }
    if (sql.includes("fulfillment_status='canceled'")) {
      order.fulfillment_status = "canceled";
      return { rows: [] };
    }
    throw new Error("Unhandled fake SQL: " + sql.slice(0, 100));
  };
  const client: any = {
    query,
    release: () => {
      state.released = true;
    },
  };
  // A second connect during an operation would deadlock a real pool with max=1.
  let connected = false;
  const db = {
    query,
    pool: {
      connect: async () => {
        assert.equal(connected, false);
        connected = true;
        return {
          ...client,
          release: () => {
            connected = false;
            state.released = true;
          },
        };
      },
    },
    withTransaction: async (fn: any) => fn(client),
  } as unknown as Db;
  return { state, db, config: config() };
}
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
test("Ozon does not create for unpaid/authorized orders or canceled intent", async () => {
  for (const status of ["created", "authorized", "payment_failed", "paid"]) {
    const f = fixture(status);
    if (status === "paid") f.state.order.metadata.ozon_cancel_requested = true;
    const old = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("No provider request allowed");
    };
    try {
      await processOzonEffects(f);
      assert.equal(f.state.effect.status, "completed");
      assert.equal(f.state.stored, null);
      assert.equal(f.state.released, true);
    } finally {
      globalThis.fetch = old;
    }
  }
});
test("Wrong delivery provider is isolated without sending Ozon requests", async () => {
  const f = fixture("paid", "cdek");
  await processOzonEffects(f);
  assert.equal(f.state.effect.status, "needs_review");
  assert.equal(f.state.stored, null);
});
test("Ozon ambiguous create retry reuses exact persisted body and idempotency key", async () => {
  const f = fixture();
  const sent: Array<{ body: string; key: string }> = [];
  const old = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("/oauth/token"))
      return json({ access_token: "token", expires_in: 3600 });
    assert.ok(String(url).endsWith("/v1/order/create"));
    sent.push({
      body: String(init?.body),
      key: (init?.headers as Record<string, string>)["Idempotency-Key"],
    });
    if (sent.length === 1) throw new TypeError("network timeout after send");
    return json({
      order_number: "OZON-1",
      postings: [{ request_id: 1, posting_number: "POSTING-1" }],
    });
  }) as typeof fetch;
  try {
    await processOzonEffects(f);
    assert.equal(f.state.effect.status, "retry");
    assert.ok(f.state.stored);
    assert.equal(f.state.shipments.length, 0);
    f.state.claimed = false;
    f.state.effect.attempts++;
    f.state.order.customer_phone = "+79990000001";
    await processOzonEffects(f);
    assert.equal(f.state.effect.status, "completed");
    assert.equal(f.state.shipments.length, 1);
    assert.deepEqual(sent[0], sent[1]);
    assert.match(sent[0].key, /^[a-f\d-]{36}$/);
  } finally {
    globalThis.fetch = old;
  }
});
test("Payment reversal during create schedules cancellation atomically after identity saved", async () => {
  const f = fixture();
  const old = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (String(url).includes("/oauth/token"))
      return json({ access_token: "token", expires_in: 3600 });
    f.state.order.status = "refunded";
    return json({
      order_number: "OZON-1",
      postings: [{ request_id: 1, posting_number: "POSTING-1" }],
    });
  }) as typeof fetch;
  try {
    await processOzonEffects(f);
    assert.equal(f.state.shipments.length, 1);
    assert.equal(f.state.enqueued[0].type, "ozon_cancel");
    assert.equal(f.state.effect.status, "completed");
  } finally {
    globalThis.fetch = old;
  }
});
test("Cancel before shipment creation leaves persistent intent and closes internal fulfillment", async () => {
  const f = fixture();
  f.state.order.metadata.ozon_cancel_requested = true;
  f.state.effect.effect_type = "ozon_cancel";
  f.state.effect.payload = { manual: true };
  await processOzonEffects(f);
  assert.equal(f.state.effect.status, "completed");
  assert.equal(f.state.order.fulfillment_status, "canceled");
  assert.equal(f.state.shipments.length, 0);
});
test("Stale provider snapshot cannot regress stored status or emit delivery email", async () => {
  const c = config();
  c.OZON_DELIVERY_STATUS_EMAILS_SINCE = "2026-09-28T00:00:00Z";
  const queries: string[] = [];
  const savedPosting = {
    posting_number: "P",
    order_number: "O",
    status: "delivered",
    status_changed_at: "2026-10-01T10:00:00Z",
  };
  const query = async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith("update public.merch_ozon_delivery_shipments")) {
      assert.ok(sql.includes("status_at<$3::timestamptz"));
      return { rows: [] };
    }
    if (sql.startsWith("select raw")) return { rows: [{ raw: savedPosting }] };
    if (sql.startsWith("insert into public.merch_ozon_delivery_events"))
      return { rows: [] };
    throw new Error("Stale event must not mutate order or queue email");
  };
  const db = {
    query,
    withTransaction: async (fn: any) => fn({ query }),
  } as unknown as Db;
  const old = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/oauth/token")
      return json({ access_token: "token", expires_in: 3600 });
    if (path.endsWith("/info"))
      return json({
        postings: [
          {
            ...savedPosting,
            status: "ON_WAY",
            status_changed_at: "2026-09-30T10:00:00Z",
          },
        ],
      });
    return json({ history: [] });
  }) as typeof fetch;
  try {
    const result = await syncOzonShipment({ db, config: c }, {
      posting_number: "P",
      external_order_number: "O",
      order_id: id,
    } as OzonShipment);
    assert.equal(result.status, "delivered");
    assert.equal(
      queries.some((s) => s.includes("enqueue_email")),
      false,
    );
  } finally {
    globalThis.fetch = old;
  }
});
test("Label/approve actions match Ozon state and require paid order for approval", () => {
  assert.ok(ozonActions("created", true).includes("approve"));
  assert.ok(!ozonActions("created", false).includes("approve"));
  assert.ok(!ozonActions("forming", true).includes("label"));
  assert.ok(ozonActions("ready_for_shipping", true).includes("label"));
  assert.deepEqual(ozonActions("delivered", true), ["sync"]);
});

test("New financial intent during a provider call is not consumed by an old worker", async () => {
  const f = fixture();
  const old = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (String(url).includes("/oauth/token"))
      return json({ access_token: "token", expires_in: 3600 });
    f.state.effect.payload = { reason: "newer_financial_transition" };
    return json({
      order_number: "OZON-1",
      postings: [{ request_id: 1, posting_number: "POSTING-1" }],
    });
  }) as typeof fetch;
  try {
    await processOzonEffects(f);
    assert.equal(f.state.effect.status, "pending");
    assert.deepEqual(f.state.effect.payload, {
      reason: "newer_financial_transition",
    });
  } finally {
    globalThis.fetch = old;
  }
});

 test("Partial refund during create preserves identity and requires review without full cancellation", async () => {
  const f = fixture();
  const old = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (String(url).includes("/oauth/token")) return json({ access_token: "token", expires_in: 3600 });
    f.state.order.status = "partially_refunded";
    return json({ order_number: "OZON-1", postings: [{ request_id: 1, posting_number: "POSTING-1" }] });
  }) as typeof fetch;
  try {
    await processOzonEffects(f);
    assert.equal(f.state.shipments.length, 1);
    assert.equal(f.state.stored.external_order_number, "OZON-1");
    assert.equal(f.state.enqueued.length, 0);
    assert.equal(f.state.effect.status, "needs_review");
  } finally { globalThis.fetch = old; }
});
