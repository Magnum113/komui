import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, publicConfig } from "../src/config";
import {
  OzonDeliveryClient,
  OzonApiError,
  ozonMoneyKopecks,
  buildOzonDimensions,
  quoteOzonDelivery,
  normalizeOzonPoint,
} from "../src/ozonDelivery";
import type { OrderItemInput } from "../src/checkout";
import { handleTbankCreatePayment } from "../src/stage5";
import type { Db } from "../src/db";
import type { FastifyRequest, FastifyReply } from "fastify";
const config = () =>
  loadConfig({
    DATABASE_URL: "postgresql://test:test@localhost/test",
    OZON_DELIVERY_CLIENT_ID: "id",
    OZON_DELIVERY_CLIENT_SECRET: "secret",
    OZON_DELIVERY_SHIPMENT_METHOD_ID: "1020005031453430",
    OZON_DELIVERY_ENABLED: "true",
    OZON_DELIVERY_WORKER_ENABLED: "true",
    TBANK_DEMO_TERMINAL_KEY: "demo",
    TBANK_DEMO_PASSWORD: "password",
  });
const item: OrderItemInput = {
  product_id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
  offer_id: "shirt-M",
  sku: null,
  product_name: "Футболка",
  size: "M",
  quantity: 1,
  unit_price_amount: 250000,
  line_total_amount: 250000,
  image_url: null,
  product_snapshot: {
    cdek_profile: "tshirt",
    cdek_package_profile: { length: 30, width: 23, height: 4, weight: 250 },
  },
};
const response = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const point = {
  delivery_point_id: 5627,
  name: "Ozon",
  is_active: true,
  type: "pvz",
  full_address: "Москва, улица Тестовая, 1",
  coordinates: { latitude: 55.7, longitude: 37.6 },
};
test("Ozon credentials/worker are disabled by default and absent from public config", () => {
  const defaults = loadConfig({
    DATABASE_URL: "postgresql://test:test@localhost/test",
  });
  assert.equal(defaults.OZON_DELIVERY_ENABLED, false);
  assert.equal(defaults.OZON_DELIVERY_WORKER_ENABLED, false);
  const text = JSON.stringify(publicConfig(config()));
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("CLIENT_ID"));
});
test("Ozon money converted exactly; invalid currency/negative/missing insurance rejected", () => {
  assert.equal(
    ozonMoneyKopecks({ amount: "1250.50", currency_code: "RUB" }),
    125050,
  );
  assert.equal(ozonMoneyKopecks({ amount: "0.01", currency_code: "RUB" }), 1);
  for (const amount of ["-1", "1e3", "1.001", "NaN"])
    assert.throws(() => ozonMoneyKopecks({ amount, currency_code: "RUB" }));
  assert.throws(() => ozonMoneyKopecks(undefined));
  assert.throws(() => ozonMoneyKopecks({ amount: "1", currency_code: "USD" }));
});
test("Ozon package dimensions use millimetres and include all items", () => {
  assert.deepEqual(buildOzonDimensions([{ ...item, quantity: 2 }]), {
    weight_g: 500,
    length_mm: 300,
    width_mm: 230,
    height_mm: 80,
  });
  assert.throws(() => buildOzonDimensions([{ ...item, product_snapshot: {} }]));
});
test("Ozon preserves POST body and idempotency through same-origin cookie redirect", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new OzonDeliveryClient(config(), (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).includes("/oauth/token"))
      return response({
        access_token: "token",
        expires_in: String(Math.floor(Date.now() / 1000) + 300),
      });
    if (requests.filter((r) => r.url.includes("api-delivery")).length === 1)
      return new Response(null, {
        status: 307,
        headers: {
          Location: "/v1/order/create?__rr=1",
          "Set-Cookie": "testcookie=abc; Secure; HttpOnly",
        },
      });
    return response({ order_number: "o" });
  }) as typeof fetch);
  await client.call(
    "/v1/order/create",
    { order_external_id: "KOM-1" },
    { idempotencyKey: "11111111-1111-4111-8111-111111111111" },
  );
  const api = requests.slice(1);
  assert.equal(api.length, 2);
  assert.equal(api[0].init.body, api[1].init.body);
  assert.equal(api[1].init.method, "POST");
  assert.equal(
    (api[1].init.headers as Record<string, string>).Cookie,
    "testcookie=abc",
  );
  assert.equal(
    (api[1].init.headers as Record<string, string>)["Idempotency-Key"],
    "11111111-1111-4111-8111-111111111111",
  );
});
test("Ozon never forwards secrets to cross-origin redirect", async () => {
  const urls: string[] = [];
  const client = new OzonDeliveryClient(config(), (async (url) => {
    urls.push(String(url));
    return new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example/collect" },
    });
  }) as typeof fetch);
  await assert.rejects(
    () => client.call("/v1/posting/info", {}),
    (e: unknown) =>
      e instanceof OzonApiError &&
      e.providerCode === "CrossOriginRedirectBlocked",
  );
  assert.equal(urls.length, 1);
});
test("Ozon refreshes expired bearer once and does not expose arbitrary error text", async () => {
  let tokens = 0,
    api = 0;
  const client = new OzonDeliveryClient(config(), (async (url) => {
    if (String(url).includes("/oauth/token"))
      return response({ access_token: `token${++tokens}`, expires_in: 3600 });
    if (++api === 1) return response({}, 401);
    return response(
      { error: { code: "NotEnoughBalance", message: "sensitive content" } },
      400,
    );
  }) as typeof fetch);
  await assert.rejects(
    () => client.call("/v1/posting/approve", {}),
    (e: unknown) =>
      e instanceof OzonApiError &&
      e.message === "Недостаточно средств на балансе доставки Ozon",
  );
  assert.equal(tokens, 2);
  assert.equal(api, 2);
});
function quoteFetch(
  calls: Array<{ path: string; body: any }>,
  canDeliver = true,
): typeof fetch {
  return (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === "/oauth/token")
      return response({ access_token: "token", expires_in: 3600 });
    if (path === "/v1/delivery/check-client")
      return response({ can_be_delivered: canDeliver });
    if (path === "/v1/delivery-point/info")
      return response({ delivery_points: [point] });
    if (path === "/v1/delivery-point/check-availability")
      return response({
        results: [
          {
            request_id: 1,
            delivery_point_id: 5627,
            cutoff_at: "2030-10-01T09:00:00Z",
          },
        ],
      });
    if (path === "/v1/order/checkout")
      return response({
        results: [
          {
            request_id: 1,
            posting: {
              estimated_delivery_cost: {
                amount: "200.50",
                currency_code: "RUB",
              },
              estimated_insurance_cost: {
                amount: "12.50",
                currency_code: "RUB",
              },
              estimated_delivery_days: 3,
              cutoff_at: "2030-10-01T09:00:00Z",
            },
          },
        ],
      });
    throw new Error(`Unexpected call ${path}`);
  }) as typeof fetch;
}
test("Quote checks recipient and availability and includes insurance, never creates shipment", async () => {
  const saved = globalThis.fetch;
  const calls: Array<{ path: string; body: any }> = [];
  globalThis.fetch = quoteFetch(calls);
  try {
    const quote = await quoteOzonDelivery(
      config(),
      [item],
      "5627",
      "+79990000000",
    );
    assert.equal(quote.amount, 21300);
    assert.equal(quote.insuranceCost, 1250);
    assert.equal(quote.posting.cutoff_at, "2030-10-01T09:00:00Z");
    assert.deepEqual(
      calls.find((c) => c.path.endsWith("check-availability"))?.body
        .delivery_point_ids,
      [5627],
    );
    assert.equal(
      calls.some((c) => c.path.endsWith("/create")),
      false,
    );
  } finally {
    globalThis.fetch = saved;
  }
});
test("Unregistered recipient stops before point and checkout calls", async () => {
  const saved = globalThis.fetch;
  const calls: Array<{ path: string; body: any }> = [];
  globalThis.fetch = quoteFetch(calls, false);
  try {
    await assert.rejects(
      () => quoteOzonDelivery(config(), [item], "5627", "+79990000000"),
      { code: "ozon_recipient_unavailable" },
    );
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/oauth/token", "/v1/delivery/check-client"],
    );
  } finally {
    globalThis.fetch = saved;
  }
});
test("Changed price rejects payment before database order/payment mutation", async () => {
  const saved = globalThis.fetch;
  const calls: Array<{ path: string; body: any }> = [];
  globalThis.fetch = quoteFetch(calls);
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("merch_storefront_products"))
        return {
          rows: [
            {
              id: item.product_id,
              name: "Футболка",
              price_min: 2500,
              is_active: true,
              sizes: ["M"],
              offers: [{ offer_id: "shirt-M", size: "M", price: 2500 }],
              product_type_slug: "tshirt",
            },
          ],
        };
      if (sql.includes("client_request_id")) return { rows: [] };
      throw new Error("Unexpected database mutation");
    },
  } as unknown as Db;
  const request = {
    method: "POST",
    body: {
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      accessToken: "a".repeat(40),
      customer: {
        firstName: "Иван",
        lastName: "Иванов",
        phone: "+79990000000",
        email: "test@example.com",
        legalConsent: true,
      },
      delivery: { provider: "ozon", code: "5627", expectedAmount: 100 },
      items: [{ id: item.product_id, offerId: "shirt-M", size: "M", qty: 1 }],
    },
  } as unknown as FastifyRequest;
  try {
    await assert.rejects(
      () =>
        handleTbankCreatePayment(request, {} as FastifyReply, {
          config: config(),
          db,
        }),
      { code: "delivery_quote_changed" },
    );
    assert.ok(queries.every((s) => !s.includes("insert into")));
    assert.equal(
      calls.some((c) => c.path === "/v2/Init"),
      false,
    );
  } finally {
    globalThis.fetch = saved;
  }
});
test("Ozon hours bounded for checkout contract", () => {
  assert.ok(
    normalizeOzonPoint({
      ...point,
      schedule: Array.from({ length: 10 }, () => ({
        date: "2030-10-01",
        periods: [{ from_local: "09:00:00", to_local: "20:00:00" }],
      })),
    }).hours.length <= 160,
  );
});

 test("Point hydration isolates removed points from a valid listed page", async () => {
  const { loadOzonPointDetails, OzonApiError } = await import("../src/ozonDelivery");
  const client = { call: async (_path: string, body: {delivery_point_ids: number[]}) => {
    if (body.delivery_point_ids.includes(2)) throw new OzonApiError(404, "HTTP_404", null);
    return { delivery_points: body.delivery_point_ids.map(delivery_point_id => ({delivery_point_id})) };
  }} as unknown as OzonDeliveryClient;
  const result = await loadOzonPointDetails(client, [1,2,3,4]);
  assert.deepEqual(result.points.map(p => p.delivery_point_id), [1,3,4]);
  assert.deepEqual(result.missingIds, [2]);
});
 test("Point hydration never treats outages or authorization errors as deleted points", async () => {
  const { loadOzonPointDetails, OzonApiError } = await import("../src/ozonDelivery");
  for (const status of [401,403,503]) {
    const client = { call: async () => { throw new OzonApiError(status, "Unavailable", null); }} as unknown as OzonDeliveryClient;
    await assert.rejects(loadOzonPointDetails(client, [1,2]), { providerStatus: status });
  }
  const incomplete = { call: async () => ({ delivery_points: [{delivery_point_id:1}] }) } as unknown as OzonDeliveryClient;
  await assert.rejects(loadOzonPointDetails(incomplete, [1,2]), { providerCode: "IncompletePointResponse" });
});
