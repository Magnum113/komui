import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProductMaps,
  parseSemicolonCsv,
  resolveProduct,
} from "../src/importOzonReviews";

test("parseSemicolonCsv handles BOM, semicolons, quotes and multiline text", () => {
  const csv = [
    "\uFEFFАртикул;SKU;Название товара;Номер заказа;Статус получения;Текст отзыва;Дата публикации;Статус отзыва;Оценка;Количество фото;Количество видео;Количество ответов на отзыв",
    'D1-S;123;Футболка;123-001;Получен;"Хорошая; футболка\nи \"\"яркая\"\"";2026-08-01T10:00:00Z;Просмотрен;5;1;0;0',
  ].join("\r\n");

  const rows = parseSemicolonCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Текст отзыва"], 'Хорошая; футболка\nи "яркая"');
  assert.equal(rows[0].SKU, "123");
});

test("resolveProduct maps by Ozon SKU or offer id", () => {
  const maps = buildProductMaps([
    {
      id: "product-a",
      slug: "product-a",
      is_active: true,
      ozon_skus: ["1001"],
      ozon_offer_ids: ["D1-S"],
      offers: [{ sku: 1002, offer_id: "D1-M" }],
    },
  ]);

  assert.deepEqual(resolveProduct("1001", "D1-S", maps), {
    productId: "product-a",
    status: "matched",
    note: null,
  });
  assert.deepEqual(resolveProduct("1002", "D1-M", maps), {
    productId: "product-a",
    status: "matched",
    note: null,
  });
  assert.equal(resolveProduct("9999", "UNKNOWN", maps).status, "unmapped");
});

test("resolveProduct refuses ambiguous mappings", () => {
  const maps = buildProductMaps([
    { id: "product-a", slug: "a", is_active: true, ozon_skus: ["1001"], ozon_offer_ids: [], offers: [] },
    { id: "product-b", slug: "b", is_active: true, ozon_skus: [], ozon_offer_ids: ["D1-S"], offers: [] },
  ]);

  const result = resolveProduct("1001", "D1-S", maps);
  assert.equal(result.status, "conflict");
  assert.equal(result.productId, null);
});

test("resolveProduct chooses the sole active card when old inactive duplicates keep Ozon ids", () => {
  const maps = buildProductMaps([
    {
      id: "active-product",
      slug: "active-product",
      is_active: true,
      ozon_skus: ["1001"],
      ozon_offer_ids: ["D1-S"],
      offers: [],
    },
    {
      id: "old-duplicate",
      slug: "old-duplicate",
      is_active: false,
      ozon_skus: ["1001"],
      ozon_offer_ids: ["D1-S"],
      offers: [],
    },
  ]);

  assert.deepEqual(resolveProduct("1001", "D1-S", maps), {
    productId: "active-product",
    status: "matched",
    note: "Resolved duplicate Ozon mapping to the only active storefront product",
  });
});
