import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import {
  cdekStatusSyncConfigurationError,
  deliveryEmailEvent,
  normalizeCdekStatuses,
  processCdekStatusSync,
} from "../src/cdekStatusSync";

const orderId = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const cdekUuid = "2d982b9f-6cf5-44bc-b3ef-bf251de2ac86";

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "staging",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    CDEK_MOCK: "true",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_STATUS_SYNC_ENABLED: "true",
    CDEK_STATUS_SYNC_INTERVAL_MS: "600000",
    CDEK_STATUS_EMAILS_SINCE: "2026-09-07T12:00:00.000Z",
    EMAIL_ENABLED: "true",
    EMAIL_WORKER_ENABLED: "true",
    ...overrides,
  });
}

function fakeDb(options: {
  orderStatus?: string;
  fulfillmentStatus?: string;
  email?: string | null;
  enqueueInserted?: boolean;
  shipmentCreatedAt?: string;
} = {}) {
  const state = {
    calls: [] as Array<{ sql: string; values: unknown[] }>,
    storedEvents: [] as Array<Record<string, unknown>>,
    shipmentUpdate: null as unknown[] | null,
    fulfillment: null as string | null,
    emailEvent: null as string | null,
    emailPayload: null as Record<string, unknown> | null,
    failure: null as string | null,
  };
  const query = async (sql: string, values: unknown[] = []) => {
    state.calls.push({ sql, values });
    if (sql.includes("cdek_status_sync:due")) {
      return { rows: [{ id: 41, order_id: orderId, cdek_uuid: cdekUuid }] };
    }
    if (sql.includes("cdek_status_sync:lock")) {
      return {
        rows: [
          {
            shipment_id: 41,
            order_id: orderId,
            shipment_status: "created",
            cdek_uuid: cdekUuid,
            cdek_number: null,
            order_number: "KOM-123456789",
            order_status: options.orderStatus ?? "paid",
            fulfillment_status: options.fulfillmentStatus ?? "new",
            customer_first_name: "Иван",
            customer_email:
              options.email === undefined ? "ivan@example.com" : options.email,
            delivery_point_code: "MSK1234",
            delivery_city: "Москва",
            delivery_address: "ул. Тестовая, 1",
            delivery_hours: "10:00–21:00",
            delivery_eta: "2–4 дня",
            order_metadata: {
              cdek: {
                delivery_point_name: "СДЭК на Тверской",
                delivery_point_type: "PVZ",
                delivery_mode: 4,
              },
            },
            shipment_created_at:
              options.shipmentCreatedAt ?? "2026-09-07T12:05:00.000Z",
          },
        ],
      };
    }
    if (sql.includes("cdek_status_sync:store_events")) {
      state.storedEvents = JSON.parse(String(values[4]));
      return { rows: state.storedEvents.map((_, index) => ({ id: index + 1 })) };
    }
    if (sql.includes("cdek_status_sync:update_shipment")) {
      state.shipmentUpdate = values;
      return { rows: [] };
    }
    if (sql.includes("cdek_status_sync:fulfillment_shipped")) {
      state.fulfillment = "shipped";
      return { rows: [] };
    }
    if (sql.includes("cdek_status_sync:fulfillment_delivered")) {
      state.fulfillment = "delivered";
      return { rows: [] };
    }
    if (sql.includes("cdek_status_sync:enqueue_email")) {
      state.emailEvent = String(values[2]);
      state.emailPayload = JSON.parse(String(values[3]));
      return { rows: options.enqueueInserted === false ? [] : [{ id: "mail-1" }] };
    }
    if (sql.includes("cdek_status_sync:failure")) {
      state.failure = String(values[1]);
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

test("CDEK statuses are normalized, sorted and hashed without customer data", () => {
  const statuses = normalizeCdekStatuses(
    {
      entity: {
        statuses: [
          {
            code: "accepted_at_pick_up_point",
            name: "Принят на склад до востребования",
            date_time: "2026-09-08T13:00:00+03:00",
            city: "Москва",
          },
          {
            code: "received_at_shipment_warehouse",
            date_time: "2026-09-07T15:00:00+03:00",
          },
          { code: "broken-without-time" },
        ],
      },
    },
    cdekUuid,
  );

  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].code, "RECEIVED_AT_SHIPMENT_WAREHOUSE");
  assert.equal(statuses[1].code, "ACCEPTED_AT_PICK_UP_POINT");
  assert.match(statuses[0].eventHash, /^[0-9a-f]{64}$/);
  assert.equal(
    deliveryEmailEvent(statuses[0], new Date("2026-09-07T11:00:00Z")),
    "shipment_handed_over",
  );
  assert.equal(
    deliveryEmailEvent(statuses[1], new Date("2026-09-07T11:00:00Z")),
    "shipment_ready",
  );
});

test("latest ready status stores history and enqueues only the ready email", async () => {
  const { db, state } = fakeDb();
  const result = await processCdekStatusSync(
    { config: config(), db },
    {
      limit: 1,
      workerId: "status-worker",
      getOrder: async () => ({
        entity: {
          uuid: cdekUuid,
          cdek_number: "1598765432",
          planned_delivery_date: "2026-09-09",
          keep_free_until: "2026-09-15T23:59:59+03:00",
          delivery_mode: 4,
          statuses: [
            {
              code: "RECEIVED_AT_SHIPMENT_WAREHOUSE",
              name: "Принят на склад отправителя",
              date_time: "2026-09-07T15:10:00+03:00",
            },
            {
              code: "ACCEPTED_AT_PICK_UP_POINT",
              name: "Принят на склад до востребования",
              date_time: "2026-09-08T13:00:00+03:00",
              city: "Москва",
            },
          ],
        },
      }),
    },
  );

  assert.deepEqual(result, {
    claimed: 1,
    synced: 1,
    eventsStored: 2,
    emailsEnqueued: 1,
    skipped: 0,
    failed: 0,
  });
  assert.equal(state.emailEvent, "shipment_ready");
  assert.equal(state.emailPayload?.cdekNumber, "1598765432");
  assert.equal(state.emailPayload?.deliveryPointCode, "MSK1234");
  assert.match(String(state.emailPayload?.storageUntil), /15 сентября 2026/);
  assert.equal(state.fulfillment, "shipped");
  assert.equal(state.shipmentUpdate?.[2], "ACCEPTED_AT_PICK_UP_POINT");
  const dueCall = state.calls.find((call) =>
    call.sql.includes("cdek_status_sync:due"),
  );
  assert.match(dueCall?.sql ?? "", /created_at >= \$2::timestamptz/);
  assert.deepEqual(dueCall?.values, [1, "2026-09-07T12:00:00.000Z"]);
});

test("status before rollout cutoff is stored but never back-sent", async () => {
  const { db, state } = fakeDb();
  const result = await processCdekStatusSync(
    { config: config(), db },
    {
      limit: 1,
      getOrder: async () => ({
        entity: {
          uuid: cdekUuid,
          cdek_number: "1598765432",
          statuses: [
            {
              code: "RECEIVED_AT_SHIPMENT_WAREHOUSE",
              date_time: "2026-09-06T15:10:00+03:00",
            },
          ],
        },
      }),
    },
  );

  assert.equal(result.synced, 1);
  assert.equal(result.eventsStored, 1);
  assert.equal(result.emailsEnqueued, 0);
  assert.equal(state.emailEvent, null);
});

test("shipment created before rollout never enters the new email chain", async () => {
  const { db, state } = fakeDb({
    shipmentCreatedAt: "2026-09-07T11:59:59.000Z",
  });

  const result = await processCdekStatusSync(
    { config: config(), db },
    {
      getOrder: async () => ({
        entity: {
          uuid: cdekUuid,
          cdek_number: "1598765432",
          statuses: [
            {
              code: "RECEIVED_AT_SHIPMENT_WAREHOUSE",
              date_time: "2026-09-07T15:10:00+03:00",
            },
          ],
        },
      }),
    },
  );

  assert.equal(result.synced, 1);
  assert.equal(result.eventsStored, 1);
  assert.equal(result.emailsEnqueued, 0);
  assert.equal(state.emailEvent, null);
});

test("terminal delivery updates fulfillment and suppresses stale status mail", async () => {
  const { db, state } = fakeDb({ fulfillmentStatus: "shipped" });
  const result = await processCdekStatusSync(
    { config: config(), db },
    {
      getOrder: async () => ({
        entity: {
          uuid: cdekUuid,
          cdek_number: "1598765432",
          statuses: [
            {
              code: "DELIVERED",
              date_time: "2026-09-08T16:00:00+03:00",
            },
          ],
        },
      }),
    },
  );

  assert.equal(result.emailsEnqueued, 0);
  assert.equal(state.fulfillment, "delivered");
  assert.equal(state.shipmentUpdate?.[6], true);
});

test("provider failures are persisted for retry and monitoring", async () => {
  const { db, state } = fakeDb();
  const result = await processCdekStatusSync(
    { config: config(), db },
    {
      getOrder: async () => {
        throw new Error("provider temporarily unavailable");
      },
    },
  );

  assert.equal(result.failed, 1);
  assert.equal(result.synced, 0);
  assert.equal(state.failure, "provider temporarily unavailable");
});

test("status sync refuses activation without a rollout cutoff", () => {
  assert.equal(
    cdekStatusSyncConfigurationError(
      config({ CDEK_STATUS_EMAILS_SINCE: undefined }),
    ),
    "CDEK status sync requires CDEK_STATUS_EMAILS_SINCE",
  );
});

test("status emails require the transactional email worker", () => {
  assert.equal(
    cdekStatusSyncConfigurationError(
      config({ EMAIL_ENABLED: "false", EMAIL_WORKER_ENABLED: "false" }),
    ),
    "CDEK status emails require EMAIL_ENABLED=true and EMAIL_WORKER_ENABLED=true",
  );
});

test("disabled status sync is a safe no-op", async () => {
  const { db } = fakeDb();
  const result = await processCdekStatusSync({
    config: config({ CDEK_STATUS_SYNC_ENABLED: "false" }),
    db,
  });
  assert.deepEqual(result, {
    claimed: 0,
    synced: 0,
    eventsStored: 0,
    emailsEnqueued: 0,
    skipped: 0,
    failed: 0,
  });
});
