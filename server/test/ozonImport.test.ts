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

test("designKeyCandidatesFromOfferId includes known legacy storefront aliases", () => {
  assert.deepEqual(designKeyCandidatesFromOfferId("D2-TSH-EMB-WHT-L"), [
    "var2|embroidery|tshirt|white",
    "var13|embroidery|tshirt|white",
  ]);
  assert.deepEqual(designKeyCandidatesFromOfferId("D25-TSH-PRT-BLK-XXL"), [
    "var25|print|tshirt|black",
    "var5|print|tshirt|black",
  ]);
  assert.deepEqual(designKeyCandidatesFromOfferId("D7-TSH-PRT-WHT-M"), [
    "var7|print|tshirt|white",
    "var7|print|tshirt|other",
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
        primary_image: ["https://img.test/main.jpg"],
        images: ["https://img.test/extra.jpg"],
        media_loaded: true,
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
        primary_image_url: "https://img.test/main.jpg",
        main_image_path: "./assets/manual-main.jpg",
        image_urls: [
          "https://img.test/main.jpg",
          "https://img.test/extra.jpg",
        ],
        ozon_product_ids: [456],
        ozon_skus: [123],
        ozon_offer_ids: ["D005-TSH-PRT-WHT-S"],
        offers: [
          {
            offer_id: "D5-TSH-PRT-WHT-S",
            product_id: "456",
            sku: "123",
            name: "Matched",
            size: "S",
            price: "2990",
            old_price: 3990,
            min_price: 2490,
            visible: true,
            archived: false,
            primary_image: "https://img.test/main.jpg",
            images: [
              "https://img.test/main.jpg",
              "https://img.test/extra.jpg",
            ],
            last_ozon_sync_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
    [],
    { serverPostgres: true, supabase: true },
    { supabaseWriteEnabled: true },
    { updatePrices: true, syncSizes: "off" },
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
    { updatePrices: true, syncSizes: "off" },
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

test("buildOzonPreview with updatePrices=false keeps existing site prices", () => {
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
    { updatePrices: false },
  );

  assert.equal(preview.summary.actionableServerPostgres, 1);
  assert.equal(preview.summary.noop, 0);
  assert.equal(preview.items[0].status, "matched");
  assert.equal(preview.items[0].plannedActions[0]?.action, "update_storefront_offer");
  assert.equal(preview.items[0].price, 3190);
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.ozon_price"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.price"), false);
  assert.equal(preview.items[0].diff?.changedFields.includes("price_min"), false);
  assert.equal(preview.items[0].diff?.changedFields.includes("price_max"), false);
  assert.equal(
    preview.warnings.some((item) => item.code === "price_updates_disabled"),
    true,
  );
});

test("buildOzonPreview with updatePrices=false stores Ozon price separately for new offers", () => {
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
        price_min: 2500,
        price_max: 3000,
        ozon_product_ids: [],
        ozon_skus: [],
        ozon_offer_ids: [],
        offers: [],
      },
    ],
    [],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
    { updatePrices: false },
  );

  assert.equal(preview.summary.actionableServerPostgres, 1);
  assert.equal(preview.items[0].plannedActions[0]?.action, "create_storefront_offer");
  assert.equal(preview.items[0].price, 3190);
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.ozon_price"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.price"), false);
  assert.equal(preview.items[0].diff?.changedFields.includes("price_min"), false);
  assert.equal(preview.items[0].diff?.changedFields.includes("price_max"), false);
});

test("buildOzonPreview reports media diff without overwriting manual main image", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-S",
        sku: 123,
        product_id: 456,
        name: "Matched",
        price: { marketing_seller_price: "2990" },
        primary_image: ["https://img.test/new-main.jpg"],
        images: [
          "https://img.test/kept.jpg",
          "https://img.test/new-extra.jpg",
        ],
        media_loaded: true,
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
        primary_image_url: "https://img.test/old-main.jpg",
        main_image_path: "./assets/manual-main.jpg",
        image_urls: [
          "https://img.test/old-main.jpg",
          "https://img.test/kept.jpg",
        ],
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
            primary_image: "https://img.test/old-main.jpg",
            images: [
              "https://img.test/old-main.jpg",
              "https://img.test/kept.jpg",
            ],
          },
        ],
      },
    ],
    [],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
    { updatePrices: true, syncSizes: "off" },
  );

  assert.equal(preview.summary.actionableServerPostgres, 1);
  assert.equal(preview.items[0].plannedActions[0]?.action, "update_storefront_offer");
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.primary_image"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.images"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("primary_image_url"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("image_urls"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("main_image_path"), false);
  assert.deepEqual(preview.items[0].mediaDiff?.offer.images.added, [
    "https://img.test/new-main.jpg",
    "https://img.test/new-extra.jpg",
  ]);
  assert.deepEqual(preview.items[0].mediaDiff?.offer.images.removed, [
    "https://img.test/old-main.jpg",
  ]);
  assert.equal(preview.items[0].mediaDiff?.product.mainImagePath.preservedManualOverride, true);
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
    { updatePrices: true },
  );

  assert.equal(preview.summary.matchedMerchProducts, 1);
  assert.equal(preview.summary.actionableServerPostgres, 0);
  assert.equal(preview.summary.noop, 1);
  assert.equal(preview.items[0].status, "noop");
  assert.equal(preview.items[0].plannedActions[0]?.reason, "no_changes");
  assert.equal(preview.items[0].diff?.changed, false);
});

test("buildOzonPreview safely adds new storefront sizes without changing site prices by default", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-XXL",
        sku: 777,
        product_id: 888,
        name: "Футболка тестовая XXL",
        price: {
          marketing_seller_price: "6700",
          old_price: "9000",
          min_price: "5000",
        },
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var5|print|tshirt|white",
        name: "Existing product",
        slug: "existing-product",
        sizes: ["S", "M", "L", "XL"],
        price_min: 2900,
        price_max: 2900,
        primary_image_url: "https://img.test/main.jpg",
        main_image_path: null,
        image_urls: ["https://img.test/main.jpg"],
        ozon_product_ids: [],
        ozon_skus: [],
        ozon_offer_ids: [],
        offers: [],
      },
    ],
    [],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
  );

  const item = preview.items[0];
  assert.equal(item.size, "XXL");
  assert.equal(item.importOptions?.updatePrices, false);
  assert.equal(item.plannedActions[0]?.action, "create_storefront_offer");
  assert.equal(item.diff?.changedFields.includes("sizes"), true);
  assert.equal(item.diff?.changedFields.includes("offers.size"), true);
  assert.equal(item.diff?.changedFields.includes("offers.ozon_price"), true);
  assert.equal(item.diff?.changedFields.includes("offers.price"), false);
  assert.equal(item.diff?.changedFields.includes("price_min"), false);
  assert.equal(item.diff?.changedFields.includes("price_max"), false);
  assert.deepEqual(
    item.diff?.fields.find((field) => field.field === "sizes")?.next,
    ["S", "M", "L", "XL", "XXL"],
  );
  assert.equal(preview.warnings.some((warning) => warning.code === "price_updates_disabled"), true);
});

test("buildOzonPreview stores Ozon size chart JSON on matched storefront product", () => {
  const sizeChart = {
    table: {
      columns: ["Размер", "Длина"],
      rows: [["S", "73"]],
    },
  };
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-S",
        sku: 123,
        product_id: 456,
        name: "Matched",
        price: { marketing_seller_price: "3190" },
        size_chart_json: sizeChart,
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var5|print|tshirt|white",
        name: "Existing product",
        slug: "existing-product",
        sizes: ["S"],
        price_min: 2990,
        price_max: 2990,
        ozon_product_ids: [456],
        ozon_skus: [123],
        ozon_offer_ids: ["D005-TSH-PRT-WHT-S"],
        size_chart_json: null,
        offers: [
          {
            offer_id: "D005-TSH-PRT-WHT-S",
            product_id: 456,
            sku: 123,
            name: "Matched",
            size: "S",
            price: 2990,
          },
        ],
      },
    ],
    [],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
    { updatePrices: false },
  );

  const item = preview.items[0];
  assert.deepEqual(item.sizeChartJson, sizeChart);
  assert.equal(item.diff?.changedFields.includes("size_chart_json"), true);
  assert.deepEqual(
    item.diff?.fields.find((field) => field.field === "size_chart_json")?.next,
    sizeChart,
  );
});

test("buildOzonPreview ignores size chart JSON object key order", () => {
  const currentSizeChart = {
    content: [
      {
        table: {
          title: "Размеры",
          body: [
            { data: [["INT", "Международный размер"], "S", "M"] },
            { data: [["Длина, см", ""], "70", "72"] },
          ],
        },
        widgetName: "tcTable",
      },
    ],
    version: 0.1,
  };
  const ozonSizeChart = {
    content: [
      {
        widgetName: "tcTable",
        table: {
          body: [
            { data: [["INT", "Международный размер"], "S", "M"] },
            { data: [["Длина, см", ""], "70", "72"] },
          ],
          title: "Размеры",
        },
      },
    ],
    version: 0.1,
  };

  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-S",
        sku: 123,
        product_id: 456,
        name: "Matched",
        size_chart_json: ozonSizeChart,
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var5|print|tshirt|white",
        name: "Existing product",
        slug: "existing-product",
        sizes: ["S"],
        ozon_product_ids: [456],
        ozon_skus: [123],
        ozon_offer_ids: ["D005-TSH-PRT-WHT-S"],
        size_chart_json: currentSizeChart,
        offers: [
          {
            offer_id: "D005-TSH-PRT-WHT-S",
            product_id: 456,
            sku: 123,
            name: "Matched",
            size: "S",
          },
        ],
      },
    ],
    [],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
    { updatePrices: false },
  );

  assert.equal(preview.items[0].diff?.changed, false);
  assert.equal(
    preview.items[0].diff?.changedFields.includes("size_chart_json"),
    false,
  );
  assert.equal(preview.summary.noop, 1);
});

test("buildOzonPreview groups unmatched structured Ozon offers as new product candidates", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D021-TSH-PRT-WGRY-S",
        sku: 1001,
        product_id: 2001,
        name: "Вареная футболка с принтом Язык Сукуны S",
        price: { marketing_seller_price: "6700" },
        primary_image: ["https://img.test/sukuna-main.jpg"],
        images: ["https://img.test/sukuna-extra.jpg"],
        media_loaded: true,
      },
      {
        offer_id: "D21-TSH-PRT-WGRY-2XL",
        sku: 1002,
        product_id: 2002,
        name: "Вареная футболка с принтом Язык Сукуны XXL",
        price: { marketing_seller_price: "5896" },
        primary_image: ["https://img.test/sukuna-main.jpg"],
        media_loaded: true,
      },
    ],
    [],
    [],
    { serverPostgres: true, supabase: false },
    { supabaseWriteEnabled: false },
  );

  assert.equal(preview.summary.unmatched, 2);
  assert.equal(preview.summary.newProductGroups, 1);
  assert.equal(preview.items[0].inferredProduct?.designKey, "var21|print|tshirt|washed-grey");
  assert.equal(preview.items[1].size, "XXL");
  assert.deepEqual(preview.newProductGroups[0]?.sizes, ["S", "XXL"]);
  assert.equal(
    preview.newProductGroups[0]?.slug,
    "varenaya-futbolka-s-printom-yazyk-sukuny-seraya",
  );
  assert.equal(preview.newProductGroups[0]?.suggestedName, "Вареная футболка с принтом Язык Сукуны");
  assert.equal(
    preview.warnings.some((warning) => warning.code === "new_products_require_creation"),
    true,
  );
});
