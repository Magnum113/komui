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
  assert.equal(preview.items[0].plannedActions[0]?.action, "create_storefront_offer");
  assert.equal(preview.items[1].status, "unmatched");
  assert.equal(preview.warnings.some((item) => item.code === "supabase_write_disabled"), true);
});

test("buildOzonPreview marks unchanged storefront offer as noop", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-S",
        sku: 123,
        product_id: 456,
        name: "Matched",
        price: {
          marketing_seller_price: "2990",
          old_price: "3990",
          min_price: "2490",
        },
        visible: true,
        archived: false,
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var5|print|tshirt|white",
        name: "Existing product",
        slug: "existing-product",
        price_min: "2990",
        price_max: "2990",
        ozon_product_ids: [456],
        ozon_skus: [123],
        ozon_offer_ids: ["D005-TSH-PRT-WHT-S"],
        offers: [
          {
            offer_id: "D5-TSH-PRT-WHT-S",
            product_id: "456",
            sku: "123",
            name: "Matched",
            price: "2990",
            old_price: 3990,
            min_price: 2490,
            visible: true,
            archived: false,
            last_ozon_sync_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
    [],
    { serverPostgres: true, supabase: true },
    { supabaseWriteEnabled: true },
  );

  assert.equal(preview.summary.matchedStorefront, 1);
  assert.equal(preview.summary.actionableServerPostgres, 0);
  assert.equal(preview.summary.actionableSupabase, 0);
  assert.equal(preview.summary.noop, 1);
  assert.equal(preview.canImport, false);
  assert.equal(preview.items[0].status, "noop");
  assert.equal(preview.items[0].plannedActions[0]?.action, "skip");
  assert.equal(preview.items[0].plannedActions[0]?.reason, "no_changes");
  assert.equal(preview.items[0].diff?.changed, false);
  assert.deepEqual(preview.items[0].diff?.changedFields, []);
});

test("buildOzonPreview reports changed storefront offer diff", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-S",
        sku: 123,
        product_id: 456,
        name: "Matched",
        price: { marketing_seller_price: "3190" },
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var5|print|tshirt|white",
        name: "Existing product",
        slug: "existing-product",
        price_min: 2990,
        price_max: 2990,
        ozon_product_ids: [456],
        ozon_skus: [123],
        ozon_offer_ids: ["D005-TSH-PRT-WHT-S"],
        offers: [
          {
            offer_id: "D005-TSH-PRT-WHT-S",
            product_id: 456,
            sku: 123,
            name: "Matched",
            price: 2990,
          },
        ],
      },
    ],
    [],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
  );

  assert.equal(preview.summary.actionableServerPostgres, 1);
  assert.equal(preview.summary.noop, 0);
  assert.equal(preview.items[0].status, "matched");
  assert.equal(preview.items[0].plannedActions[0]?.action, "update_storefront_offer");
  assert.equal(preview.items[0].diff?.operation, "update_storefront_offer");
  assert.equal(preview.items[0].diff?.changed, true);
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.price"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("price_min"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("price_max"), true);
});

test("buildOzonPreview marks unchanged merch product as noop", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "TSH-001",
        sku: 123,
        product_id: 456,
        name: "Matched merch",
        price: { marketing_seller_price: "2990" },
      },
    ],
    [],
    [
      {
        id: 1,
        sku: "TSH-001",
        legacy_skus: [],
        ozon_sku: 123,
        sale_price: "2990",
      },
    ],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
  );

  assert.equal(preview.summary.matchedMerchProducts, 1);
  assert.equal(preview.summary.actionableServerPostgres, 0);
  assert.equal(preview.summary.noop, 1);
  assert.equal(preview.items[0].status, "noop");
  assert.equal(preview.items[0].plannedActions[0]?.reason, "no_changes");
  assert.equal(preview.items[0].diff?.changed, false);
});
