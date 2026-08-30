import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  handleAdminGetOrder,
  handleAdminListOrders,
  toAdminOrderSummary,
} from "../src/adminOrders";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";

const orderId = "7c169f01-b459-4e25-b74f-a4909a1b4149";

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    order_number: "KOM-123456789",
    status: "paid",
    fulfillment_status: "new",
    fulfillment_note: null,
    customer_first_name: "Иван",
    customer_last_name: "Иванов",
    customer_phone: "+79995330015",
    marketing_consent: true,
    legal_accepted_at: "2026-06-30T09:00:00.000Z",
    delivery_provider: "cdek",
    delivery_point_code: "KOMUI-STAGE-PVZ",
    delivery_city: "Москва",
    delivery_address: "ул. Тестовая, 1",
    delivery_hours: "10:00-21:00",
    delivery_eta: "2-3 дня",
    delivery_amount: 35000,
    subtotal_amount: 290000,
    discount_amount: 0,
    total_amount: 325000,
    currency: "RUB",
    promo_code: null,
    source: "storefront",
    metadata: {},
    paid_at: "2026-06-30T09:05:00.000Z",
    shipped_at: null,
    delivered_at: null,
    created_at: "2026-06-30T09:00:00.000Z",
    updated_at: "2026-06-30T09:05:00.000Z",
    item_count: "2",
    line_count: "1",
    first_item_id: "42",
    first_product_id: "product-id",
    first_offer_id: "D2-TSH-EMB-WBEG-M",
    first_sku: "3606215601",
    first_product_name: "Футболка-варёнка Наруто Itachi",
    first_size: "M",
    first_quantity: "2",
    first_image_url: "/assets/product.jpg",
    latest_provider_status: "CONFIRMED",
    latest_payment_error_code: null,
    latest_payment_error_message: null,
    cdek_status: "created",
    cdek_uuid: "cdek-uuid",
    cdek_number: "10288069122",
    cdek_error_message: null,
    ...overrides,
  };
}

function testConfig(token: string) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    ADMIN_API_TOKEN: token,
    AUDIT_LOG_PATH: join(tmpdir(), `komui-admin-orders-${process.pid}.log`),
  });
}

test("toAdminOrderSummary keeps payment, fulfillment and CDEK statuses separate", () => {
  const summary = toAdminOrderSummary(orderRow());

  assert.equal(summary.orderNumber, "KOM-123456789");
  assert.equal(summary.paymentStatus, "paid");
  assert.equal(summary.fulfillmentStatus, "new");
  assert.equal(summary.latestPayment.providerStatus, "CONFIRMED");
  assert.equal(summary.cdek.status, "created");
  assert.equal(summary.cdek.number, "10288069122");
  assert.equal(summary.amounts.total, 325000);
  assert.deepEqual(summary.firstItem, {
    id: 42,
    productId: "product-id",
    offerId: "D2-TSH-EMB-WBEG-M",
    sku: "3606215601",
    productName: "Футболка-варёнка Наруто Itachi",
    name: "Футболка-варёнка Наруто Itachi",
    size: "M",
    quantity: 2,
    imageUrl: "/assets/product.jpg",
  });
});

test("admin list exposes and accepts payment_unknown as a payment filter", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("select count(*)")) return { rows: [{ total: "1" }] };
      return {
        rows: [
          orderRow({
            status: "payment_unknown",
            latest_provider_status: "INIT_UNKNOWN",
            paid_at: null,
          }),
        ],
      };
    },
  } as unknown as Db;

  const response = await handleAdminListOrders(
    { query: { paymentStatus: "payment_unknown" } } as never,
    {} as never,
    { db },
  );

  assert.equal(response.orders[0].paymentStatus, "payment_unknown");
  assert.equal(response.statuses.payment.includes("payment_unknown"), true);
  assert.equal(queries.every((query) => query.values[0] === "payment_unknown"), true);
  assert.equal(queries.some((query) => /o\.status = \$1/.test(query.sql)), true);
});

test("admin order detail exposes safe order effect status without payload", async () => {
  const db = {
    query: async (sql: string) => {
      if (sql.includes("from public.merch_customer_orders o")) {
        return { rows: [orderRow()] };
      }
      if (sql.includes("from public.merch_order_effects")) {
        return {
          rows: [
            {
              id: 91,
              effect_type: "cdek_cancel",
              status: "needs_review",
              attempts: 12,
              last_error: "CDEK rejected the cancellation request",
              available_at: "2026-08-30T12:00:00.000Z",
              updated_at: "2026-08-30T12:05:00.000Z",
              completed_at: "2026-08-30T12:05:00.000Z",
              payload: { should_not_leak: true },
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as Db;

  const response = await handleAdminGetOrder(
    { params: { orderId } } as never,
    {} as never,
    { config: testConfig("e".repeat(24)), db },
  );

  assert.deepEqual(response.orderEffects, [
    {
      id: 91,
      type: "cdek_cancel",
      status: "needs_review",
      attempts: 12,
      lastError: "CDEK rejected the cancellation request",
      availableAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:05:00.000Z",
      completedAt: "2026-08-30T12:05:00.000Z",
    },
  ]);
  assert.equal("payload" in response.orderEffects[0], false);
});

test("POST /admin/storefront/orders/:id/mark-shipped marks paid order as shipped", async () => {
  const token = "o".repeat(24);
  let updateSql = "";
  let updateValues: unknown[] = [];

  const db = {
    query: async () => ({ rows: [] }),
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("for update of o")) {
            return { rows: [orderRow()] };
          }
          if (sql.includes("update public.merch_customer_orders")) {
            updateSql = sql;
            updateValues = values;
            return {
              rows: [
                orderRow({
                  fulfillment_status: "shipped",
                  fulfillment_note: "Передано в СДЭК",
                  shipped_at: "2026-06-30T10:00:00.000Z",
                }),
              ],
            };
          }
          if (sql.includes("from public.merch_customer_orders o")) {
            return {
              rows: [
                orderRow({
                  fulfillment_status: "shipped",
                  fulfillment_note: "Передано в СДЭК",
                  shipped_at: "2026-06-30T10:00:00.000Z",
                }),
              ],
            };
          }
          return { rows: [] };
        },
      }),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;

  const app = buildApp({
    config: testConfig(token),
    db,
  });

  const response = await app.inject({
    method: "POST",
    url: `/admin/storefront/orders/${orderId}/mark-shipped`,
    headers: { authorization: `Bearer ${token}` },
    payload: { note: "Передано в СДЭК" },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.order.paymentStatus, "paid");
  assert.equal(body.order.fulfillmentStatus, "shipped");
  assert.equal(body.order.shippedAt, "2026-06-30T10:00:00.000Z");
  assert.match(updateSql, /fulfillment_status = \$2/);
  assert.equal(updateValues[0], orderId);
  assert.equal(updateValues[1], "shipped");
  assert.equal(updateValues[3], "Передано в СДЭК");

  await app.close();
});

test("POST /admin/storefront/orders/:id/mark-shipped rejects unpaid order", async () => {
  const token = "p".repeat(24);
  const db = {
    query: async () => ({ rows: [] }),
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string) => {
          if (sql.includes("for update of o")) {
            return {
              rows: [
                orderRow({
                  status: "pending_payment",
                  latest_provider_status: "NEW",
                  paid_at: null,
                }),
              ],
            };
          }
          throw new Error("update should not run for unpaid orders");
        },
      }),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;

  const app = buildApp({
    config: testConfig(token),
    db,
  });

  const response = await app.inject({
    method: "POST",
    url: `/admin/storefront/orders/${orderId}/mark-shipped`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "order_not_ready_to_ship");

  await app.close();
});
