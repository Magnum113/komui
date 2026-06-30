import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  planStorefrontProductUpdate,
  toAdminStorefrontProduct,
  type AdminStorefrontProductRow,
} from "../src/adminStorefront";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import { HttpError } from "../src/errors";

const productId = "7c169f01-b459-4e25-b74f-a4909a1b4149";

function productRow(): AdminStorefrontProductRow {
  return {
    id: productId,
    design_key: "var16|print|tshirt|washed-grey",
    ozon_variant: "var16",
    name: "Old product",
    slug: "old-product",
    description: "Old description",
    ozon_description: "Ozon description",
    category: "Футболки",
    category_slug: "tshirts",
    product_type: "Футболка",
    product_type_slug: "tshirt",
    decoration_type: "Принт",
    decoration_slug: "print",
    color_name: "Серый",
    color_slug: "grey",
    color_hex: "#888888",
    franchise_type: "anime",
    title_name: "Jujutsu Kaisen",
    title_slug: "jujutsu-kaisen",
    anime_title: "Jujutsu Kaisen",
    anime_slug: "jujutsu-kaisen",
    character_name: "Satoru Gojo",
    character_slug: "satoru-gojo",
    collection_name: "Satoru Gojo",
    collection_slug: "satoru-gojo",
    design_name: "Satoru Gojo",
    design_slug: "satoru-gojo",
    tags: ["hit"],
    sizes: ["M", "XL"],
    price_min: "5000",
    price_max: "5000",
    currency: "RUB",
    primary_image_url: "https://img.test/old-main.jpg",
    main_image_path: "./assets/manual-main.jpg",
    image_urls: [
      "https://img.test/old-main.jpg",
      "https://img.test/old-extra.jpg",
    ],
    offers: [
      {
        offer_id: "offer-m",
        sku: 111,
        name: "Offer M",
        size: "M",
        price: 5000,
        visible: true,
        primary_image: "https://img.test/old-main.jpg",
        images: ["https://img.test/old-main.jpg"],
      },
      {
        offer_id: "offer-l",
        sku: 222,
        name: "Offer L",
        size: "L",
        price: 5000,
        visible: false,
      },
      {
        offer_id: "offer-xl",
        sku: 333,
        name: "Offer XL",
        size: "XL",
        price: 5000,
        visible: true,
      },
    ],
    is_active: true,
    sort_order: 10,
    short_description: "Old short",
    badges: ["hit"],
    compare_at_price: "7000",
    updated_at: "2026-06-01T10:00:00.000Z",
  };
}

function updateByField(plan: ReturnType<typeof planStorefrontProductUpdate>) {
  return new Map(plan.updates.map((update) => [update.field, update]));
}

test("planStorefrontProductUpdate maps editable admin fields to storefront columns", () => {
  const plan = planStorefrontProductUpdate(productRow(), {
    name: "  New product  ",
    description: "  New description  ",
    shortDescription: "   ",
    salePrice: "2900",
    regularPrice: "4500",
    sizes: ["m", "L", "m"],
    imageUrls: [
      "https://img.test/new-main.jpg",
      "https://img.test/new-extra.jpg",
      "https://img.test/new-main.jpg",
    ],
  });

  const updates = updateByField(plan);
  assert.equal(updates.get("name")?.column, "name");
  assert.equal(updates.get("name")?.value, "New product");
  assert.equal(updates.get("description")?.value, "New description");
  assert.equal(updates.get("shortDescription")?.value, null);
  assert.equal(updates.get("salePrice")?.value, 2900);
  assert.equal(updates.get("priceMax")?.value, 2900);
  assert.equal(updates.get("regularPrice")?.value, 4500);
  assert.deepEqual(updates.get("sizes")?.value, ["M", "L"]);
  assert.deepEqual(updates.get("imageUrls")?.value, [
    "https://img.test/new-main.jpg",
    "https://img.test/new-extra.jpg",
  ]);
  assert.equal(
    updates.get("primaryImageUrl")?.value,
    "https://img.test/new-main.jpg",
  );
  assert.equal(
    updates.get("mainImagePath")?.value,
    "https://img.test/new-main.jpg",
  );

  const offers = updates.get("offers")?.value as Array<Record<string, unknown>>;
  assert.equal(offers[0]?.price, 2900);
  assert.equal(offers[1]?.visible, true);
  assert.equal(offers[2]?.visible, false);
});

test("planStorefrontProductUpdate rejects old price lower than current sale price", () => {
  assert.throws(
    () =>
      planStorefrontProductUpdate(productRow(), {
        salePrice: 3000,
        regularPrice: 2500,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "invalid_regular_price",
  );
});

test("toAdminStorefrontProduct returns camelCase product editor shape", () => {
  const product = toAdminStorefrontProduct(productRow());

  assert.equal(product.id, productId);
  assert.equal(product.designKey, "var16|print|tshirt|washed-grey");
  assert.equal(product.salePrice, 5000);
  assert.equal(product.regularPrice, 7000);
  assert.deepEqual(product.imageUrls, [
    "https://img.test/old-main.jpg",
    "https://img.test/old-extra.jpg",
  ]);
  assert.equal(product.offers[0]?.offerId, "offer-m");
  assert.equal(product.offers[0]?.primaryImage, "https://img.test/old-main.jpg");
});

test("admin storefront routes require admin token", async () => {
  const app = buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      ADMIN_API_TOKEN: "x".repeat(24),
      AUDIT_LOG_PATH: join(tmpdir(), `komui-admin-denied-${process.pid}.log`),
    }),
    db: {
      query: async () => ({ rows: [] }),
      withTransaction: async () => ({ rows: [] }),
      ping: async () => ({ ok: 1, database_name: "komui_test" }),
      close: async () => undefined,
    } as unknown as Db,
  });

  const response = await app.inject({
    method: "GET",
    url: "/admin/storefront/products",
  });

  assert.equal(response.statusCode, 401);
  await app.close();
});

test("PATCH /admin/storefront/products/:id updates product in one transaction", async () => {
  const token = "t".repeat(24);
  const updatedRow = {
    ...productRow(),
    name: "New product",
    price_min: "2900",
    price_max: "2900",
    compare_at_price: "4500",
    updated_at: "2026-06-30T10:00:00.000Z",
  };
  let updateSql = "";
  let updateValues: unknown[] = [];

  const db = {
    query: async () => ({ rows: [] }),
    withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("for update")) {
            return { rows: [productRow()] };
          }
          if (sql.includes("update public.merch_storefront_products")) {
            updateSql = sql;
            updateValues = values;
            return { rows: [updatedRow] };
          }
          return { rows: [] };
        },
      }),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;

  const app = buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      ADMIN_API_TOKEN: token,
      AUDIT_LOG_PATH: join(tmpdir(), `komui-admin-allowed-${process.pid}.log`),
    }),
    db,
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/admin/storefront/products/${productId}`,
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      name: "New product",
      salePrice: 2900,
      regularPrice: 4500,
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.product.name, "New product");
  assert.equal(body.product.salePrice, 2900);
  assert.deepEqual(body.changedFields.slice(0, 3), [
    "name",
    "salePrice",
    "priceMax",
  ]);
  assert.match(updateSql, /updated_at = now\(\)/);
  assert.equal(updateValues[0], productId);
  assert.equal(updateValues.includes(2900), true);
  assert.equal(updateValues.includes(4500), true);

  await app.close();
});
