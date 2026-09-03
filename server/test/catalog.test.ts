import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeLimit, sanitizeOffer, sanitizeProduct } from "../src/catalog";

test("sanitizeOffer keeps only public offer fields", () => {
  const offer = sanitizeOffer({
    sku: 123,
    offer_id: "offer-1",
    name: "Product offer",
    size: "XL",
    price: 4200,
    images: ["https://example.test/a.jpg", 123],
    primary_image: "https://example.test/main.jpg",
    attributes: { barcode: "secret-ish" },
    raw_name: "raw marketplace name",
    product_id: 999,
  });

  assert.deepEqual(offer, {
    sku: 123,
    offer_id: "offer-1",
    name: "Product offer",
    size: "XL",
    price: 4200,
    images: ["https://example.test/a.jpg"],
    primary_image: "https://example.test/main.jpg",
  });
});

test("sanitizeProduct does not leak raw offer fields", () => {
  const product = sanitizeProduct({
    id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    design_key: "design",
    name: "Product",
    slug: "product",
    description: "Плотность ткани 230 г/м², состав 92% хлопок, 8% эластан.",
    ozon_description: "Хлопок 85%, полиэстер 10%, эластан 5%; плотность 90 гр/м2.",
    category: "Футболки",
    category_slug: "tshirts",
    product_type: "Футболка",
    product_type_slug: "tshirt",
    decoration_type: "Принт",
    decoration_slug: "print",
    franchise_type: "anime",
    tags: [],
    sizes: ["M"],
    currency: "RUB",
    image_urls: [],
    size_chart_json: { rows: [["M", "75"]] },
    offers: [{ offer_id: "x", attributes: { weight: 250 }, price: 1 }],
    is_active: true,
    sort_order: 1,
    badges: [],
    storefront_variant: {
      group_key: "var18|embroidery|hoodie|black",
      fit: "cropped",
      warmth: "no-fleece",
    },
    requires_offer_id_sizes: ["m", " M ", "XXL", 123],
    review_summary: {
      count: 3,
      averageRating: 4.67,
      withMedia: 1,
      ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 },
    },
  });

  assert.equal(product.offers[0]?.offer_id, "x");
  assert.equal("attributes" in product.offers[0]!, false);
  assert.deepEqual(product.size_chart_json, { rows: [["M", "75"]] });
  assert.deepEqual(product.review_summary, {
    count: 3,
    averageRating: 4.67,
    withMedia: 1,
    ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 },
  });
  assert.equal(product.fabric_composition, "100% хлопок");
  assert.equal(product.fabric_density_gsm, 240);
  assert.deepEqual(product.storefront_variant, {
    group_key: "var18|embroidery|hoodie|black",
    fit: "cropped",
    warmth: "no-fleece",
  });
  assert.deepEqual(product.requires_offer_id_sizes, ["M"]);
  assert.equal(
    product.description,
    "Плотность ткани 240 г/м², состав 100% хлопок.",
  );
  assert.equal(
    product.ozon_description,
    "100% хлопок; плотность 240 г/м².",
  );
});

test("sanitizeProduct rejects malformed variant metadata and never leaks source payload", () => {
  const product = sanitizeProduct({
    id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    design_key: "design",
    name: "Hoodie",
    slug: "hoodie",
    category: "Худи",
    category_slug: "hoodies",
    product_type: "Худи",
    product_type_slug: "hoodie",
    decoration_type: "Вышивка",
    decoration_slug: "embroidery",
    franchise_type: "anime",
    tags: [],
    sizes: ["S", "M"],
    currency: "RUB",
    image_urls: [],
    offers: [],
    is_active: true,
    sort_order: 1,
    badges: [],
    storefront_variant: {
      group_key: "var18|embroidery|hoodie|black",
      fit: "unknown",
      warmth: "no-fleece",
      private_note: "must-not-leak",
    },
    requires_offer_id_sizes: ["XL", null, { size: "S" }],
    source_payload: {
      checkout: { legacy_ambiguous_sizes: ["S"] },
      raw: "must-not-leak",
    },
    variant_group_key: "must-not-leak",
    hoodie_fit_slug: "must-not-leak",
    hoodie_fleece_slug: "must-not-leak",
  } as never);

  assert.equal(product.storefront_variant, undefined);
  assert.deepEqual(product.requires_offer_id_sizes, []);
  assert.equal("source_payload" in product, false);
  assert.equal("variant_group_key" in product, false);
  assert.equal("hoodie_fit_slug" in product, false);
  assert.equal("hoodie_fleece_slug" in product, false);
});

test("sanitizeProduct does not attach T-shirt facts when explicit type is hoodie", () => {
  const description = "Плотность ткани 370 г/м², состав 80% хлопок, 20% полиэстер.";
  const product = sanitizeProduct({
    id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
    design_key: "design",
    name: "Hoodie",
    slug: "hoodie",
    description,
    category: "Футболки",
    category_slug: "tshirts",
    product_type: "Худи",
    product_type_slug: "hoodie",
    decoration_type: "Вышивка",
    decoration_slug: "embroidery",
    franchise_type: "anime",
    tags: [],
    sizes: ["M"],
    currency: "RUB",
    image_urls: [],
    offers: [],
    is_active: true,
    sort_order: 1,
    badges: [],
    review_summary: {
      count: 0,
      averageRating: null,
      withMedia: 0,
      ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    },
  });

  assert.equal(product.description, description);
  assert.equal(product.fabric_composition, undefined);
  assert.equal(product.fabric_density_gsm, undefined);
});

test("normalizeLimit clamps unsafe values", () => {
  assert.equal(normalizeLimit(undefined), 200);
  assert.equal(normalizeLimit("0"), 1);
  assert.equal(normalizeLimit("5000"), 200);
  assert.equal(normalizeLimit("10"), 10);
});

test("sanitizeProduct maps Ozon image URLs through media manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "komui-media-manifest-"));
  const manifestPath = path.join(dir, "manifest.json");
  const sourceUrl = "https://ir.ozone.ru/s3/multimedia-1-a/example.jpg";
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      images: {
        [sourceUrl]: {
          sourceUrl,
          fallback: "/media/products/ab/abcdef123456/800.webp",
          thumb: "/media/products/ab/abcdef123456/thumb.webp",
          variants: [
            {
              width: 800,
              height: 1067,
              format: "webp",
              url: "/media/products/ab/abcdef123456/800.webp",
            },
          ],
        },
      },
    }),
  );

  const previousManifest = process.env.KOMUI_MEDIA_MANIFEST_PATH;
  const previousStrict = process.env.KOMUI_MEDIA_STRICT;
  process.env.KOMUI_MEDIA_MANIFEST_PATH = manifestPath;
  process.env.KOMUI_MEDIA_STRICT = "1";

  try {
    const product = sanitizeProduct({
      id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
      design_key: "design",
      name: "Product",
      slug: "product",
      category: "Футболки",
      category_slug: "tshirts",
      product_type: "Футболка",
      product_type_slug: "tshirt",
      decoration_type: "Принт",
      decoration_slug: "print",
      franchise_type: "anime",
      tags: [],
      sizes: ["M"],
      currency: "RUB",
      primary_image_url: sourceUrl,
      main_image_path: sourceUrl,
      image_urls: [sourceUrl],
      size_chart_json: null,
      offers: [{ offer_id: "x", images: [sourceUrl], primary_image: sourceUrl }],
      is_active: true,
      sort_order: 1,
      badges: [],
      review_summary: {
        count: 0,
        averageRating: null,
        withMedia: 0,
        ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      },
    });

    assert.equal(
      product.primary_image_url,
      "/media/products/ab/abcdef123456/800.webp",
    );
    assert.deepEqual(product.image_urls, [
      "/media/products/ab/abcdef123456/800.webp",
    ]);
    assert.equal(
      product.offers[0]?.primary_image,
      "/media/products/ab/abcdef123456/800.webp",
    );
    assert.deepEqual(product.offers[0]?.images, [
      "/media/products/ab/abcdef123456/800.webp",
    ]);
  } finally {
    if (previousManifest === undefined) {
      delete process.env.KOMUI_MEDIA_MANIFEST_PATH;
    } else {
      process.env.KOMUI_MEDIA_MANIFEST_PATH = previousManifest;
    }
    if (previousStrict === undefined) {
      delete process.env.KOMUI_MEDIA_STRICT;
    } else {
      process.env.KOMUI_MEDIA_STRICT = previousStrict;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
