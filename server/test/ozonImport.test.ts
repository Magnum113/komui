import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOzonPreview,
  designKeyCandidatesFromOfferId,
  handleAdminCreateOzonStorefrontProduct,
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

test("designKeyCandidatesFromOfferId prefers an exact hoodie variant before the base card", () => {
  assert.deepEqual(
    designKeyCandidatesFromOfferId("D018-HDY-EMB-BLK-CRP-NF-V01-M"),
    [
      "var18|embroidery|hoodie|black|crp|nf",
      "var18|embroidery|hoodie|black",
    ],
  );
  assert.deepEqual(
    designKeyCandidatesFromOfferId("D008-HDY-EMB-WHT-REG-FLC-V01-S"),
    [
      "var8|embroidery|hoodie|white|reg|flc",
      "var8|embroidery|hoodie|white",
    ],
  );
  assert.deepEqual(
    designKeyCandidatesFromOfferId("D008-HDY-EMB-WHT-REG-NF-V01-S"),
    [
      "var8|embroidery|hoodie|white|reg|nf",
      "var8|embroidery|hoodie|white",
    ],
  );
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
});

test("buildOzonPreview maps a hoodie to its exact variant before the legacy base fallback", () => {
  const exactPreview = buildOzonPreview(
    [
      {
        offer_id: "D018-HDY-EMB-BLK-CRP-NF-M",
        sku: 1802,
        product_id: 18002,
        name: "Худи GTA укороченное без начёса M",
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var18|embroidery|hoodie|black",
        name: "Худи GTA",
        slug: "hudi-gta",
        ozon_product_ids: [],
        ozon_skus: [],
        ozon_offer_ids: [],
        offers: [],
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        design_key: "var18|embroidery|hoodie|black|crp|nf",
        variant_group_key: "var18|embroidery|hoodie|black",
        hoodie_fit_slug: "cropped",
        hoodie_fleece_slug: "no-fleece",
        name: "Худи GTA — укороченное, без начёса",
        slug: "hudi-gta-ukorochennoe-bez-nachesa",
        ozon_product_ids: [],
        ozon_skus: [],
        ozon_offer_ids: [],
        offers: [],
      },
    ],
    [],
  );

  assert.equal(
    exactPreview.items[0].targetProduct?.id,
    "22222222-2222-2222-2222-222222222222",
  );
  assert.equal(exactPreview.items[0].matchReason, "offer_id_design_key");

  const fallbackPreview = buildOzonPreview(
    [
      {
        offer_id: "D018-HDY-EMB-BLK-CRP-NF-M",
        sku: 1802,
        product_id: 18002,
        name: "Худи GTA укороченное без начёса M",
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var18|embroidery|hoodie|black",
        name: "Худи GTA",
        slug: "hudi-gta",
        ozon_product_ids: [],
        ozon_skus: [],
        ozon_offer_ids: [],
        offers: [],
      },
    ],
    [],
  );

  assert.equal(
    fallbackPreview.items[0].targetProduct?.id,
    "11111111-1111-1111-1111-111111111111",
  );
});

test("buildOzonPreview fails closed on duplicate active storefront offer mappings", () => {
  assert.throws(
    () =>
      buildOzonPreview(
        [],
        [
          {
            id: "11111111-1111-1111-1111-111111111111",
            design_key: "var18|embroidery|hoodie|black|reg|nf",
            name: "Худи GTA — обычное",
            slug: "hudi-gta-obychnoe",
            ozon_product_ids: [],
            ozon_skus: [],
            ozon_offer_ids: ["D018-HDY-EMB-BLK-REG-NF-S"],
            offers: [],
          },
          {
            id: "22222222-2222-2222-2222-222222222222",
            design_key: "var18|embroidery|hoodie|black|crp|nf",
            name: "Худи GTA — укороченное",
            slug: "hudi-gta-ukorochennoe",
            ozon_product_ids: [],
            ozon_skus: [],
            ozon_offer_ids: ["d18_hdy_emb_blk_reg_nf_s"],
            offers: [],
          },
        ],
        [],
      ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "ambiguous_storefront_mapping",
      );
      return true;
    },
  );
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
    { updatePrices: true, syncSizes: "off" },
  );

  assert.equal(preview.summary.matchedStorefront, 1);
  assert.equal(preview.summary.actionableServerPostgres, 0);
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

test("buildOzonPreview filters blocked Ozon warning image from storefront media", () => {
  const blockedWarningImage = "https://ir.ozone.ru/s3/multimedia-1-4/12069341824.jpg";
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D005-TSH-PRT-WHT-S",
        sku: 123,
        product_id: 456,
        name: "Matched",
        price: { marketing_seller_price: "2990" },
        primary_image: ["https://img.test/main.jpg"],
        images: [
          "https://img.test/main.jpg",
          "https://img.test/extra.jpg",
          blockedWarningImage,
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
        primary_image_url: "https://img.test/main.jpg",
        main_image_path: null,
        image_urls: [
          "https://img.test/main.jpg",
          "https://img.test/extra.jpg",
          blockedWarningImage,
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
            primary_image: "https://img.test/main.jpg",
            images: [
              "https://img.test/main.jpg",
              "https://img.test/extra.jpg",
              blockedWarningImage,
            ],
          },
        ],
      },
    ],
    [],
    { updatePrices: true, syncSizes: "off" },
  );

  assert.equal(preview.summary.actionableServerPostgres, 1);
  assert.equal(preview.items[0].plannedActions[0]?.action, "update_storefront_offer");
  assert.deepEqual(preview.items[0].media?.images, [
    "https://img.test/main.jpg",
    "https://img.test/extra.jpg",
  ]);
  assert.equal(preview.items[0].diff?.changedFields.includes("offers.images"), true);
  assert.equal(preview.items[0].diff?.changedFields.includes("image_urls"), true);
  assert.deepEqual(preview.items[0].mediaDiff?.offer.images.removed, [
    blockedWarningImage,
  ]);
  assert.deepEqual(preview.items[0].mediaDiff?.product.imageUrls.removed, [
    blockedWarningImage,
  ]);
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
    { updatePrices: false },
  );

  assert.equal(preview.items[0].diff?.changed, false);
  assert.equal(
    preview.items[0].diff?.changedFields.includes("size_chart_json"),
    false,
  );
  assert.equal(preview.summary.noop, 1);
});

test("buildOzonPreview skips storefront size chart when matched Ozon offers disagree", () => {
  const sizeChartA = {
    content: [{ table: { title: "Размеры A", body: [{ data: [["Размер"], "S"] }] } }],
  };
  const sizeChartB = {
    content: [{ table: { title: "Размеры B", body: [{ data: [["Размер"], "M"] }] } }],
  };

  const preview = buildOzonPreview(
    [
      {
        offer_id: "D008-HDY-EMB-WHT-REG-FLC-S",
        sku: 1001,
        product_id: 2001,
        name: "Худи Gravity",
        size_chart_json: sizeChartA,
      },
      {
        offer_id: "D008-HDY-EMB-WHT-REG-NF-M",
        sku: 1002,
        product_id: 2002,
        name: "Худи Gravity",
        size_chart_json: sizeChartB,
      },
    ],
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        design_key: "var8|embroidery|hoodie|white",
        name: "Худи Gravity",
        slug: "hudi-gravity-vyshivka-belaya",
        sizes: ["S", "M"],
        price_min: 3900,
        price_max: 3900,
        ozon_product_ids: [2001, 2002],
        ozon_skus: [1001, 1002],
        ozon_offer_ids: [
          "D008-HDY-EMB-WHT-REG-FLC-S",
          "D008-HDY-EMB-WHT-REG-NF-M",
        ],
        size_chart_json: null,
        offers: [
          {
            offer_id: "D008-HDY-EMB-WHT-REG-FLC-S",
            product_id: 2001,
            sku: 1001,
            name: "Худи Gravity",
            size: "S",
          },
          {
            offer_id: "D008-HDY-EMB-WHT-REG-NF-M",
            product_id: 2002,
            sku: 1002,
            name: "Худи Gravity",
            size: "M",
          },
        ],
      },
    ],
    [],
    { updatePrices: false },
  );

  assert.equal(preview.summary.actionableServerPostgres, 0);
  assert.equal(preview.summary.noop, 2);
  assert.equal(preview.canImport, false);
  assert.equal(
    preview.warnings.some((warning) => warning.code === "storefront_size_chart_conflict"),
    true,
  );
  for (const item of preview.items) {
    assert.equal(item.status, "noop");
    assert.equal(item.sizeChartJson, undefined);
    assert.equal(
      item.diff?.changedFields.includes("size_chart_json"),
      false,
    );
    assert.equal(item.warnings?.[0]?.code, "storefront_size_chart_conflict");
  }
});

test("buildOzonPreview does not choose a size chart for new product group conflicts", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D021-TSH-PRT-WGRY-S",
        sku: 1001,
        product_id: 2001,
        name: "Вареная футболка S",
        size_chart_json: { table: { title: "A" } },
      },
      {
        offer_id: "D021-TSH-PRT-WGRY-M",
        sku: 1002,
        product_id: 2002,
        name: "Вареная футболка M",
        size_chart_json: { table: { title: "B" } },
      },
    ],
    [],
    [],
    { updatePrices: false },
  );

  assert.equal(preview.newProductGroups.length, 1);
  assert.equal(preview.newProductGroups[0].sizeChartJson, undefined);
  assert.equal(preview.newProductGroups[0].sizeChartConflict, true);
  assert.equal(
    preview.warnings.some((warning) => warning.code === "new_product_size_chart_conflict"),
    true,
  );
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

test("buildOzonPreview keeps unmatched hoodie fit and fleece variants in separate product groups", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D018-HDY-EMB-BLK-CRP-NF-V01-S",
        sku: 1801,
        product_id: 18001,
        name: "Худи GTA укороченное без начёса S",
      },
      {
        offer_id: "D018-HDY-EMB-BLK-CRP-NF-V01-M",
        sku: 1802,
        product_id: 18002,
        name: "Худи GTA укороченное без начёса M",
      },
      {
        offer_id: "D018-HDY-EMB-BLK-REG-NF-V02-S",
        sku: 1803,
        product_id: 18003,
        name: "Худи GTA обычное без начёса S",
      },
      {
        offer_id: "D008-HDY-EMB-WHT-REG-FLC-V01-S",
        sku: 801,
        product_id: 8001,
        name: "Худи Gravity с начёсом S",
      },
      {
        offer_id: "D008-HDY-EMB-WHT-REG-NF-V01-S",
        sku: 802,
        product_id: 8002,
        name: "Худи Gravity без начёса S",
      },
    ],
    [],
    [],
  );

  assert.equal(preview.summary.newProductGroups, 4);
  const groupsByDesignKey = new Map(
    preview.newProductGroups.map((group) => [group.designKey, group]),
  );
  const gtaCropped = groupsByDesignKey.get(
    "var18|embroidery|hoodie|black|crp|nf",
  );
  assert.ok(gtaCropped);
  assert.deepEqual(
    {
      variantGroupKey: gtaCropped.variantGroupKey,
      hoodieFitSlug: gtaCropped.hoodieFitSlug,
      hoodieFleeceSlug: gtaCropped.hoodieFleeceSlug,
      sizes: gtaCropped.sizes,
    },
    {
      variantGroupKey: "var18|embroidery|hoodie|black",
      hoodieFitSlug: "cropped",
      hoodieFleeceSlug: "no-fleece",
      sizes: ["S", "M"],
    },
  );
  assert.deepEqual(
    {
      variantGroupKey: groupsByDesignKey.get(
        "var18|embroidery|hoodie|black|reg|nf",
      )?.variantGroupKey,
      hoodieFitSlug: groupsByDesignKey.get(
        "var18|embroidery|hoodie|black|reg|nf",
      )?.hoodieFitSlug,
      hoodieFleeceSlug: groupsByDesignKey.get(
        "var18|embroidery|hoodie|black|reg|nf",
      )?.hoodieFleeceSlug,
    },
    {
      variantGroupKey: "var18|embroidery|hoodie|black",
      hoodieFitSlug: "regular",
      hoodieFleeceSlug: "no-fleece",
    },
  );
  assert.deepEqual(
    {
      variantGroupKey: groupsByDesignKey.get(
        "var8|embroidery|hoodie|white|reg|flc",
      )?.variantGroupKey,
      hoodieFitSlug: groupsByDesignKey.get(
        "var8|embroidery|hoodie|white|reg|flc",
      )?.hoodieFitSlug,
      hoodieFleeceSlug: groupsByDesignKey.get(
        "var8|embroidery|hoodie|white|reg|flc",
      )?.hoodieFleeceSlug,
    },
    {
      variantGroupKey: "var8|embroidery|hoodie|white",
      hoodieFitSlug: "regular",
      hoodieFleeceSlug: "fleece",
    },
  );
  assert.equal(
    groupsByDesignKey.get("var8|embroidery|hoodie|white|reg|nf")
      ?.hoodieFleeceSlug,
    "no-fleece",
  );
});

test("Ozon storefront creation persists inferred hoodie variant columns", async () => {
  const previewId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D018-HDY-EMB-BLK-CRP-NF-V01-S",
        sku: 1801,
        product_id: 18001,
        name: "Худи GTA укороченное без начёса S",
      },
    ],
    [],
    [],
  );
  let insertSql = "";
  let insertValues: unknown[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("from public.merch_admin_import_previews")) {
        return {
          rows: [
            {
              id: previewId,
              import_type: "ozon_products",
              request_payload: {},
              summary: preview.summary,
              items: preview.items,
              can_import: preview.canImport,
              warnings: preview.warnings,
              created_at: "2026-09-03T00:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("insert into public.merch_storefront_products")) {
        insertSql = sql;
        insertValues = values;
        return {
          rows: [
            {
              id: "33744741-8c0f-5b69-a7cb-766c16b88e0f",
              design_key: values[0],
              variant_group_key: values[1],
              hoodie_fit_slug: values[2],
              hoodie_fleece_slug: values[3],
              slug: values[6],
              name: values[5],
              sizes: values[30],
              price_min: values[31],
              price_max: values[32],
              primary_image_url: values[33],
              image_urls: values[35],
              size_chart_json: null,
              offers: JSON.parse(String(values[40])),
              is_active: values[42],
              sort_order: values[43],
              updated_at: values[47],
            },
          ],
        };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    },
  };

  const result = await handleAdminCreateOzonStorefrontProduct(
    {
      id: "request-1",
      ip: "127.0.0.1",
      method: "POST",
      url: "/admin/import/ozon/products",
      body: {
        previewId,
        product: {
          name: "Худи GTA — укороченное, без начёса",
          salePrice: 4200,
          imageUrls: ["https://img.test/gta-cropped.jpg"],
        },
      },
    } as never,
    {} as never,
    {
      config: { AUDIT_LOG_PATH: "/dev/null" } as never,
      db: db as never,
    },
  );

  assert.match(insertSql, /variant_group_key/);
  assert.match(insertSql, /hoodie_fit_slug/);
  assert.match(insertSql, /hoodie_fleece_slug/);
  assert.deepEqual(insertValues.slice(0, 4), [
    "var18|embroidery|hoodie|black|crp|nf",
    "var18|embroidery|hoodie|black",
    "cropped",
    "no-fleece",
  ]);
  assert.deepEqual(
    {
      designKey: result.product.designKey,
      variantGroupKey: result.product.variantGroupKey,
      hoodieFitSlug: result.product.hoodieFitSlug,
      hoodieFleeceSlug: result.product.hoodieFleeceSlug,
    },
    {
      designKey: "var18|embroidery|hoodie|black|crp|nf",
      variantGroupKey: "var18|embroidery|hoodie|black",
      hoodieFitSlug: "cropped",
      hoodieFleeceSlug: "no-fleece",
    },
  );
});

test("buildOzonPreview removes a SKU size before a trailing colour from suggested names", () => {
  const preview = buildOzonPreview(
    [
      {
        offer_id: "D2-TSH-EMB-WGRY-L",
        sku: 1001,
        product_id: 2001,
        name: "Вареная футболка Наруто с вышивкой Itachi L Серая",
        price: { marketing_seller_price: "8000" },
        primary_image: ["https://img.test/itachi-main.jpg"],
        media_loaded: true,
      },
      {
        offer_id: "D2-TSH-EMB-WGRY-XL",
        sku: 1002,
        product_id: 2002,
        name: "Вареная футболка Наруто с вышивкой Itachi XL Серая",
        price: { marketing_seller_price: "8000" },
        primary_image: ["https://img.test/itachi-main.jpg"],
        media_loaded: true,
      },
    ],
    [],
    [],
    { updatePrices: false },
  );

  assert.equal(preview.newProductGroups.length, 1);
  assert.equal(
    preview.newProductGroups[0]?.suggestedName,
    "Вареная футболка Наруто с вышивкой Itachi Серая",
  );
});
