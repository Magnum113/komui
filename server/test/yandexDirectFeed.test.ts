import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app";
import {
  CatalogRepository,
  type YandexFeedProduct,
} from "../src/catalog";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import type { PublicMediaMetadata } from "../src/mediaManifest";
import {
  buildYandexDirectFeed,
  YandexDirectFeedError,
  YANDEX_FEED_CATEGORIES,
} from "../src/yandexDirectFeed";

const SITE_URL = "https://komui.ru";
const PRODUCT_ID = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const DEFAULT_PICTURE = "/media/products/aa/test-product/800.webp";

function product(
  overrides: Partial<YandexFeedProduct> = {},
): YandexFeedProduct {
  return {
    id: PRODUCT_ID,
    name: "Футболка KOMUI",
    slug: "futbolka-komui",
    category: "Футболки",
    category_slug: "tshirts",
    product_type: "Футболка",
    decoration_type: "DTF-печать",
    color_name: "Чёрный",
    title_name: "Naruto",
    title_slug: "naruto",
    collection_name: "Naruto",
    collection_slug: "naruto",
    design_name: "Akatsuki",
    sizes: ["S", "M", "XL"],
    price_min: 3_200,
    compare_at_price: 4_200,
    currency: "RUB",
    primary_image_url: DEFAULT_PICTURE,
    main_image_path: DEFAULT_PICTURE,
    image_urls: [DEFAULT_PICTURE],
    is_active: true,
    sort_order: 1,
    ...overrides,
  };
}

function metadataForFixture(url: string): PublicMediaMetadata | undefined {
  if (url.includes("ir.ozone.ru")) return undefined;
  if (url.includes("750x437")) {
    return { width: 750, height: 437, format: "webp", bytes: 50_000 };
  }
  if (url.includes("oversized")) {
    return {
      width: 1_200,
      height: 1_200,
      format: "webp",
      bytes: 10 * 1024 * 1024 + 1,
    };
  }
  if (url.endsWith(".svg")) {
    return { width: 800, height: 1_000, format: "svg", bytes: 50_000 };
  }
  if (url.endsWith(".webp")) {
    return { width: 800, height: 1_000, format: "webp", bytes: 100_000 };
  }
  return undefined;
}

function offerBodies(xml: string) {
  return [...xml.matchAll(/<offer\b[^>]*>([\s\S]*?)<\/offer>/g)].map(
    (match) => match[1] || "",
  );
}

function offerIds(xml: string) {
  return [...xml.matchAll(/<offer id="([^"]+)"[^>]*>/g)].map(
    (match) => match[1] || "",
  );
}

test("YML feed renders deterministic valid structure and product fields", () => {
  const narrowPicture = "/media/products/aa/test-product/750x437.webp";
  const pictures = Array.from(
    { length: 6 },
    (_, index) => `/media/products/aa/test-product/${index + 1}.webp`,
  );
  const xml = buildYandexDirectFeed(
    [
      product({
        name: `A&B <C> "D" 'E'\u0001`,
        slug: "item with space",
        sizes: ["S", "M", "M"],
        primary_image_url: narrowPicture,
        main_image_path: pictures[0],
        image_urls: [
          pictures[0],
          "https://ir.ozone.ru/s3/legacy.webp",
          "/media/products/aa/test-product/oversized.webp",
          "/media/products/aa/test-product/vector.svg",
          ...pictures.slice(1),
        ],
      }),
    ],
    {
      siteUrl: SITE_URL,
      generatedAt: new Date("2026-08-20T09:05:00.000Z"),
      timeZone: "Europe/Moscow",
      mediaMetadata: metadataForFixture,
    },
  );

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.equal((xml.match(/<yml_catalog\b/g) || []).length, 1);
  assert.equal((xml.match(/<\/yml_catalog>/g) || []).length, 1);
  assert.match(xml, /<yml_catalog date="2026-08-20 12:05">/);
  assert.ok(xml.indexOf("<currencies>") < xml.indexOf("<categories>"));
  assert.ok(xml.indexOf("<categories>") < xml.indexOf("<offers>"));
  assert.match(xml, /A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;/);
  assert.doesNotMatch(xml, /\u0001/);

  const ids = offerIds(xml);
  assert.deepEqual(ids, [PRODUCT_ID]);
  assert.match(
    xml,
    new RegExp(`<offer id="${PRODUCT_ID}" type="vendor.model" available="true">`),
  );
  assert.match(xml, /<url>https:\/\/komui\.ru\/p\/item%20with%20space<\/url>/);
  assert.match(xml, /<price>3200<\/price>/);
  assert.match(xml, /<oldprice>4200<\/oldprice>/);
  assert.match(xml, /<currencyId>RUB<\/currencyId>/);
  assert.match(xml, /<categoryId>101<\/categoryId>/);
  assert.match(xml, /<param name="Размер" unit="INT">S<\/param>/);
  assert.match(xml, /<param name="Размер" unit="INT">M<\/param>/);

  const body = offerBodies(xml)[0] || "";
  const feedPictures = [...body.matchAll(/<picture>([^<]+)<\/picture>/g)].map(
    (match) => match[1] || "",
  );
  assert.equal(feedPictures.length, 5);
  assert.equal(feedPictures.some((url) => url.includes("750x437")), false);
  assert.equal(feedPictures.some((url) => url.includes("ir.ozone.ru")), false);
  assert.equal(feedPictures.some((url) => url.includes("oversized")), false);
  assert.equal(feedPictures.some((url) => url.endsWith(".svg")), false);
  for (const url of feedPictures) {
    assert.match(url, /^https:\/\//);
    assert.equal(url.includes(" "), false);
  }

  const knownCategoryIds = new Set(YANDEX_FEED_CATEGORIES.map(({ id }) => id));
  const categoryId = body.match(/<categoryId>([^<]+)<\/categoryId>/)?.[1] || "";
  assert.match(categoryId, /^\d+$/);
  assert.equal(knownCategoryIds.has(categoryId), true);
});

test("all active products stay available regardless of legacy SKU flags", () => {
  const products = [
    {
      ...product({ id: "00000000-0000-4000-8000-000000000001" }),
      offers: [{ archived: true, visible: false }],
    },
    {
      ...product({ id: "00000000-0000-4000-8000-000000000002" }),
      offers: [{ archived: false, visible: null }],
    },
    {
      ...product({
        id: "00000000-0000-4000-8000-000000000003",
        is_active: false,
      }),
      offers: [{ archived: false, visible: true }],
    },
  ] as Array<YandexFeedProduct & { offers: unknown[] }>;

  const xml = buildYandexDirectFeed(products, {
    siteUrl: SITE_URL,
    mediaMetadata: metadataForFixture,
  });
  const tags = [...xml.matchAll(/<offer\b[^>]*>/g)].map((match) => match[0]);

  assert.equal(tags.length, 2);
  assert.equal(tags.every((tag) => tag.includes('available="true"')), true);
  assert.doesNotMatch(xml, /00000000-0000-4000-8000-000000000003/);
});

test("feed validation rejects duplicate IDs and incomplete active products", () => {
  const products = [
    product({ id: "00000000-0000-4000-8000-000000000001" }),
    product({ id: "00000000-0000-4000-8000-000000000001" }),
    product({
      id: "00000000-0000-4000-8000-000000000002",
      price_min: 0,
    }),
    product({
      id: "00000000-0000-4000-8000-000000000003",
      category: "Неизвестно",
      category_slug: "unknown",
    }),
    product({
      id: "00000000-0000-4000-8000-000000000004",
      primary_image_url: "/missing.jpg",
      main_image_path: "/missing.jpg",
      image_urls: [],
    }),
  ];

  assert.throws(
    () =>
      buildYandexDirectFeed(products, {
        siteUrl: SITE_URL,
        mediaMetadata: metadataForFixture,
      }),
    (error: unknown) => {
      assert.ok(error instanceof YandexDirectFeedError);
      const codes = new Set(error.issues.map(({ code }) => code));
      assert.equal(codes.has("duplicate_offer_id"), true);
      assert.equal(codes.has("invalid_price"), true);
      assert.equal(codes.has("unknown_category"), true);
      assert.equal(codes.has("missing_picture"), true);
      return true;
    },
  );
});

test("feed query and generator do not truncate catalogs larger than 200 products", async () => {
  const products = Array.from({ length: 205 }, (_, index) =>
    product({
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      slug: `product-${index}`,
      sort_order: index,
    }),
  );
  let queryText = "";
  const db = {
    query: async (sql: string) => {
      queryText = sql;
      return { rows: products };
    },
  } as unknown as Db;

  const repository = new CatalogRepository(db);
  const queriedProducts = await repository.listActiveProductsForYandexFeed();
  const xml = buildYandexDirectFeed(queriedProducts, {
    siteUrl: SITE_URL,
    mediaMetadata: metadataForFixture,
  });
  const ids = offerIds(xml);

  assert.equal(queriedProducts.length, 205);
  assert.doesNotMatch(queryText, /\blimit\b/i);
  assert.match(queryText, /where p\.is_active is true/i);
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
});

test("feed endpoint returns XML headers and reports invalid source data as 503", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "komui-yandex-feed-"));
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      images: {
        "https://source.test/product.webp": {
          sourceUrl: "https://source.test/product.webp",
          fallback: DEFAULT_PICTURE,
          width: 800,
          height: 1_000,
          mime: "image/webp",
          variants: [
            {
              width: 800,
              height: 1_000,
              format: "webp",
              url: DEFAULT_PICTURE,
            },
          ],
        },
      },
    }),
  );

  const previousManifest = process.env.KOMUI_MEDIA_MANIFEST_PATH;
  process.env.KOMUI_MEDIA_MANIFEST_PATH = manifestPath;

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    SITE_URL,
  });
  const dbWithProducts = (rows: YandexFeedProduct[]) =>
    ({
      query: async () => ({ rows }),
      withTransaction: async () => {
        throw new Error("withTransaction should not be called");
      },
      ping: async () => ({ ok: 1, database_name: "komui_test" }),
      close: async () => undefined,
    }) as unknown as Db;

  try {
    const validApp = buildApp({ config, db: dbWithProducts([product()]) });
    const validResponse = await validApp.inject({
      method: "GET",
      url: "/v1/feeds/yandex-direct.yml",
    });

    assert.equal(validResponse.statusCode, 200);
    assert.match(
      validResponse.headers["content-type"]?.toString() || "",
      /^application\/xml; charset=utf-8/,
    );
    assert.equal(
      validResponse.headers["content-disposition"],
      'inline; filename="yandex-direct.yml"',
    );
    assert.equal(validResponse.headers["cache-control"], "no-cache");
    assert.ok(validResponse.body.startsWith("<?xml"));
    assert.deepEqual(offerIds(validResponse.body), [PRODUCT_ID]);
    await validApp.close();

    const invalidApp = buildApp({
      config,
      db: dbWithProducts([product({ price_min: 0 })]),
    });
    const invalidResponse = await invalidApp.inject({
      method: "GET",
      url: "/v1/feeds/yandex-direct.yml",
    });

    assert.equal(invalidResponse.statusCode, 503);
    const errorBody = invalidResponse.json();
    assert.equal(errorBody.error.code, "yandex_feed_invalid");
    assert.equal(errorBody.error.details.issues[0].code, "invalid_price");
    await invalidApp.close();
  } finally {
    if (previousManifest === undefined) {
      delete process.env.KOMUI_MEDIA_MANIFEST_PATH;
    } else {
      process.env.KOMUI_MEDIA_MANIFEST_PATH = previousManifest;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
