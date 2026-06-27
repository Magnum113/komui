import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOzonPreview,
  designKeyCandidatesFromOfferId,
  normalizeOfferId,
  priceFromOzonItem,
  type OzonPriceItem,
} from "../src/ozonImport";

test("normalizeOfferId normalizes D and VAR prefixes", () => {
  assert.equal(
    normalizeOfferId(" D005_TSH_PRT_WHT_S "),
    "D5-TSH-PRT-WHT-S",
  );
  assert.equal(normalizeOfferId("var016-Print-GreyW-M"), "VAR16-PRINT-GREYW-M");
});

test("designKeyCandidatesFromOfferId maps structured Ozon offer ids", () => {
  assert.deepEqual(designKeyCandidatesFromOfferId("D005-TSH-PRT-WHT-S"), [
    "var5|print|tshirt|white",
  ]);
});

test("priceFromOzonItem prefers marketing seller price", () => {
  const item: OzonPriceItem = {
    price: {
      marketing_seller_price: "2990",
      price: "3990",
    },
  };
  assert.equal(priceFromOzonItem(item), 2990);
});

test("buildOzonPreview matches storefront by normalized offer id and skips unmapped", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-S",
        sku: 123,
        product_id: 456,
        name: "Matched",
        price: { marketing_seller_price: "2990" },
      },
      {
        offer_id: "D999-TSH-PRT-WHT-S",
        sku: 999,
        product_id: 888,
        name: "Unmatched",
        price: { price: "1990" },
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var5|print|tshirt|white",
        name: "Existing product",
        slug: "existing-product",
        price_min: 2500,
        price_max: 3000,
        ozon_product_ids: [],
        ozon_skus: [],
        ozon_offer_ids: [],
        offers: [],
      },
    ],
    [],
    { serverPostgres: true, supabase: true },
    { supabaseWriteEnabled: false },
  );

  assert.equal(preview.summary.totalOzonItems, 2);
  assert.equal(preview.summary.matchedStorefront, 1);
  assert.equal(preview.summary.unmatched, 1);
  assert.equal(preview.summary.actionableServerPostgres, 1);
  assert.equal(preview.summary.actionableSupabase, 0);
  assert.equal(preview.canImport, true);
  assert.equal(preview.items[0].targetProduct?.designKey, "var5|print|tshirt|white");
  assert.equal(preview.items[1].status, "unmatched");
  assert.equal(preview.warnings.some((item) => item.code === "supabase_write_disabled"), true);
});
