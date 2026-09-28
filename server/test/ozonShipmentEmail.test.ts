import assert from "node:assert/strict";
import test from "node:test";
import { renderOzonShipmentEmail, enqueueOzonShippingEmail } from "../src/email/ozonShipment";
import type { PoolClient } from "pg";

const fixture = { customerFirstName: "<Иван>", orderNumber: "KOM-123", cdekNumber: "OZ-123", deliveryCity: "Москва", deliveryAddress: "<ПВЗ> на Тверской", deliveryHours: "10–21" };
for (const event of ["shipment_handed_over", "shipment_ready"] as const) {
  test(`Ozon ${event} keeps carrier, parcel and safe address in both email formats`, () => {
    const email = renderOzonShipmentEmail(fixture, event);
    for (const body of [email.html, email.text]) {
      assert.match(body, /Ozon/);
      assert.match(body, /OZ-123/);
      assert.doesNotMatch(body, /СДЭК|cdek\.ru/);
    }
    assert.match(email.html, /&lt;ПВЗ&gt;/);
    assert.doesNotMatch(email.html, /<ПВЗ>/);
  });
}
test("enqueue Ozon shipment email stores provider and uses durable event/parcel deduplication", async () => {
  let sql = ""; let values: unknown[] = [];
  await enqueueOzonShippingEmail({ query: async (query: string, params: unknown[]) => { sql = query; values = params; return { rows: [] }; } } as unknown as PoolClient, "order", "shipment_ready", "posting");
  assert.match(sql, /on conflict \(idempotency_key\) do nothing/);
  assert.match(sql, /o.delivery_provider='ozon'/);
  assert.match(sql, /'deliveryProvider','ozon'/);
  assert.deepEqual(values, ["order", "shipment_ready", "posting"]);
});
