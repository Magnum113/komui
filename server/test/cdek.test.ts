import assert from "node:assert/strict";
import test from "node:test";
import { buildCdekPackages, quoteCdekDelivery } from "../src/cdek";
import { loadConfig } from "../src/config";

test("buildCdekPackages uses hoodie profile and preserves non-payment items", () => {
  const packages = buildCdekPackages("KOM-TEST", [
    {
      productId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
      productName: "Худи KOMUI",
      size: "L",
      quantity: 2,
      unitPriceAmount: 4_900_00,
      productTypeSlug: "hoodie",
    },
  ]);

  assert.equal(packages.length, 1);
  assert.equal(packages[0].number, "KOM-TEST");
  assert.equal(packages[0].weight, 700);
  assert.equal(packages[0].items?.[0]?.payment.value, 0);
  assert.equal(packages[0].items?.[0]?.cost, 4900);
});

test("quoteCdekDelivery returns deterministic staging quote in mock mode", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
    CDEK_MOCK: "true",
  });

  const quote = await quoteCdekDelivery(config, {
    deliveryCityCode: 44,
    tariffCode: 136,
    packages: buildCdekPackages("KOM-TEST", [
      {
        productName: "Футболка",
        quantity: 1,
        unitPriceAmount: 2_500_00,
        productTypeSlug: "tshirt",
      },
    ]),
  });

  assert.equal(quote.amountKopecks, 39_000);
  assert.equal(quote.tariffCode, 136);
  assert.equal(quote.deliveryMode, 4);
});
