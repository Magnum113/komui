import assert from "node:assert/strict";
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
    offers: [{ offer_id: "x", attributes: { weight: 250 }, price: 1 }],
    is_active: true,
    sort_order: 1,
    badges: [],
  });

  assert.equal(product.offers[0]?.offer_id, "x");
  assert.equal("attributes" in product.offers[0]!, false);
});

test("normalizeLimit clamps unsafe values", () => {
  assert.equal(normalizeLimit(undefined), 200);
  assert.equal(normalizeLimit("0"), 1);
  assert.equal(normalizeLimit("5000"), 200);
  assert.equal(normalizeLimit("10"), 10);
});
