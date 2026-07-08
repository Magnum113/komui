import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { sha256Hex } from "../src/crypto";
import type { Db } from "../src/db";

function mockDb(): Db {
  return {
    query: async () => ({ rows: [] }),
    withTransaction: async (callback) =>
      callback({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      } as never),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;
}

test("delivery config exposes configured Yandex Maps browser key", async () => {
  const app = buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      YANDEX_MAPS_API_KEY: "public-map-key",
    }),
    db: mockDb(),
  });

  const response = await app.inject({
    method: "GET",
    url: "/delivery-config",
  });

  assert.equal(response.statusCode, 200);
  assert.match(
    response.headers["content-type"]?.toString() || "",
    /application\/javascript/,
  );
  assert.equal(response.headers["cache-control"], "public, max-age=300, s-maxage=300");
  assert.match(response.body, /window\.KOMUI_DELIVERY/);
  assert.match(response.body, /public-map-key/);

  await app.close();
});

test("payment creation does not reuse failed payment URL", async () => {
  const accessToken = "A".repeat(40);
  const queryLog: string[] = [];
  const db = {
    query: async (sql: string) => {
      queryLog.push(sql);
      if (sql.includes("from public.merch_customer_orders")) {
        return {
          rows: [
            {
              id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
              order_number: "KOM-135878882",
              access_token_hash: sha256Hex(accessToken),
              total_amount: 300_000,
              status: "payment_failed",
            },
          ],
        };
      }
      return { rows: [] };
    },
    withTransaction: async () => {
      throw new Error("withTransaction should not be called");
    },
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;
  const app = buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      TBANK_DEMO_TERMINAL_KEY: "demo-terminal",
      TBANK_DEMO_PASSWORD: "demo-password",
      CDEK_MOCK: "true",
    }),
    db,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/payments",
    payload: {
      clientRequestId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
      accessToken,
      customer: {
        firstName: "Иван",
        lastName: "Иванов",
        phone: "+7 999 533-00-15",
        email: "ivan@example.com",
        legalConsent: true,
      },
      delivery: {
        code: "KOMUI-STAGE-PVZ",
        cityCode: 44,
      },
      items: [
        {
          id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
          size: "M",
          qty: 1,
        },
      ],
    },
  });

  assert.equal(response.statusCode, 409);
  const body = response.json();
  assert.equal(body.error.code, "payment_retry_required");
  assert.equal(body.error.details.retryAllowed, true);
  assert.equal(
    queryLog.some((sql) => sql.includes("from public.merch_payment_attempts")),
    false,
  );

  await app.close();
});
