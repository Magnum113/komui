import assert from "node:assert/strict";
import test from "node:test";
import {
  CheckoutRepository,
  MARKETING_CONSENT_SOURCE,
  MARKETING_CONSENT_VERSION,
  marketingConsentEvidence,
  normalizePhone,
  orderNumber,
  type ProductRow,
  resolveCartOffer,
  validateClientIdentity,
  validatedCart,
} from "../src/checkout";
import type { Db } from "../src/db";
import { HttpError } from "../src/errors";

const PRODUCT_ID = "7c169f01-b459-4e25-b74f-a4909a1b4149";

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: PRODUCT_ID,
    name: "Худи GTA обычное без начёса",
    price_min: 3_900,
    is_active: true,
    sizes: ["S", "M"],
    offers: [
      {
        offer_id: "D018-HDY-EMB-BLK-REG-NF-S",
        sku: "sku-regular-s",
        size: "S",
        price: 3_700,
      },
    ],
    main_image_path: "/media/gta.webp",
    primary_image_url: null,
    product_type_slug: "hoodie",
    category_slug: "hoodies",
    source_payload: {},
    ...overrides,
  };
}

function expectHttpError(code: string) {
  return (error: unknown) =>
    error instanceof HttpError && error.statusCode === 409 && error.code === code;
}

test("marketing consent evidence records an explicit version and source", () => {
  const acceptedAt = "2026-08-31T18:30:00.000Z";

  assert.deepEqual(marketingConsentEvidence(true, acceptedAt), {
    at: acceptedAt,
    version: MARKETING_CONSENT_VERSION,
    source: MARKETING_CONSENT_SOURCE,
  });
  assert.deepEqual(marketingConsentEvidence(false, acceptedAt), {
    at: null,
    version: null,
    source: null,
  });
});

test("orderNumber uses compact numeric format", () => {
  assert.match(orderNumber(), /^KOM-\d{9}$/);
});

test("validatedCart accepts UUID product ids and safe quantities", () => {
  assert.deepEqual(
    validatedCart([
      {
        id: PRODUCT_ID,
        size: "m",
        qty: 2,
        offerId: "  D018-HDY-EMB-BLK-REG-NF-M  ",
      },
    ]),
    [
      {
        id: PRODUCT_ID,
        size: "M",
        qty: 2,
        offerId: "D018-HDY-EMB-BLK-REG-NF-M",
      },
    ],
  );
});

test("validatedCart keeps legacy items without offerId and rejects malformed offer IDs", () => {
  assert.deepEqual(validatedCart([{ id: PRODUCT_ID, size: "S", qty: 1 }]), [
    { id: PRODUCT_ID, size: "S", qty: 1 },
  ]);
  assert.throws(
    () => validatedCart([{ id: PRODUCT_ID, size: "S", qty: 1, offerId: " " }]),
  );
  assert.throws(() =>
    validatedCart([
      { id: PRODUCT_ID, size: "S", qty: 1, offerId: `offer-${"x".repeat(121)}` },
    ]),
  );
});

test("resolveCartOffer uses an exact selectable offer for the requested size", () => {
  const row = product({
    offers: [
      {
        offer_id: "D018-HDY-EMB-BLK-CRP-NF-S",
        sku: "sku-cropped-s",
        size: "S",
      },
      {
        offer_id: "D018-HDY-EMB-BLK-REG-NF-S",
        sku: "sku-regular-s",
        size: "S",
      },
      {
        offer_id: "D018-HDY-EMB-BLK-REG-NF-M",
        sku: "sku-regular-m",
        size: "M",
      },
    ],
  });

  assert.equal(
    resolveCartOffer(row, {
      size: "S",
      offerId: "D018-HDY-EMB-BLK-REG-NF-S",
    }).sku,
    "sku-regular-s",
  );
  assert.throws(
    () =>
      resolveCartOffer(row, {
        size: "M",
        offerId: "D018-HDY-EMB-BLK-REG-NF-S",
      }),
    expectHttpError("offer_unavailable"),
  );
});

test("resolveCartOffer excludes archived and hidden offers", () => {
  const row = product({
    offers: [
      { offer_id: "archived-s", size: "S", archived: true },
      { offer_id: "hidden-s", size: "S", visible: false },
    ],
  });

  assert.throws(
    () => resolveCartOffer(row, { size: "S", offerId: "archived-s" }),
    expectHttpError("offer_unavailable"),
  );
  assert.throws(
    () => resolveCartOffer(row, { size: "S" }),
    expectHttpError("offer_unavailable"),
  );
});

test("resolveCartOffer accepts only an unambiguous legacy size", () => {
  assert.equal(resolveCartOffer(product(), { size: "S" }).sku, "sku-regular-s");

  assert.throws(
    () => resolveCartOffer(product({ offers: [] }), { size: "S" }),
    expectHttpError("offer_unavailable"),
  );
  assert.throws(
    () =>
      resolveCartOffer(
        product({
          offers: [
            { offer_id: "regular-s", size: "S" },
            { offer_id: "cropped-s", size: "S" },
          ],
        }),
        { size: "S" },
      ),
    expectHttpError("ambiguous_offer"),
  );
});

test("legacy ambiguity marker requires reselection but explicit offerId remains valid", () => {
  const row = product({
    source_payload: {
      checkout: { legacy_ambiguous_sizes: ["s"] },
    },
  });

  assert.throws(
    () => resolveCartOffer(row, { size: "S" }),
    expectHttpError("ambiguous_offer"),
  );
  assert.equal(
    resolveCartOffer(row, {
      size: "S",
      offerId: "D018-HDY-EMB-BLK-REG-NF-S",
    }).sku,
    "sku-regular-s",
  );
});

test("duplicate exact offer IDs fail closed", () => {
  const row = product({
    offers: [
      { offer_id: "duplicate-s", size: "S" },
      { offer_id: "duplicate-s", size: "S" },
    ],
  });

  assert.throws(
    () => resolveCartOffer(row, { size: "S", offerId: "duplicate-s" }),
    expectHttpError("ambiguous_offer"),
  );
});

test("orderItemsFromCart persists the selected offer and prefers its price", async () => {
  let queryText = "";
  const db = {
    query: async (sql: string) => {
      queryText = sql;
      return { rows: [product()] };
    },
  } as unknown as Db;

  const items = await new CheckoutRepository(db).orderItemsFromCart([
    {
      id: PRODUCT_ID,
      size: "S",
      qty: 2,
      offerId: "D018-HDY-EMB-BLK-REG-NF-S",
    },
  ]);

  assert.match(queryText, /source_payload/);
  assert.equal(items[0]?.offer_id, "D018-HDY-EMB-BLK-REG-NF-S");
  assert.equal(items[0]?.sku, "sku-regular-s");
  assert.equal(items[0]?.unit_price_amount, 370_000);
  assert.equal(items[0]?.line_total_amount, 740_000);
  assert.equal(
    items[0]?.product_snapshot.offer_id,
    "D018-HDY-EMB-BLK-REG-NF-S",
  );
});

test("orderItemsFromCart falls back to the product price when offer price is absent", async () => {
  const db = {
    query: async () => ({
      rows: [
        product({
          offers: [
            {
              offer_id: "D018-HDY-EMB-BLK-REG-NF-S",
              sku: "sku-regular-s",
              size: "S",
            },
          ],
        }),
      ],
    }),
  } as unknown as Db;

  const [item] = await new CheckoutRepository(db).orderItemsFromCart([
    { id: PRODUCT_ID, size: "S", qty: 1 },
  ]);

  assert.equal(item?.unit_price_amount, 390_000);
});

test("checkout identity and phone validation reject unsafe input", () => {
  assert.equal(normalizePhone("8 (999) 533-00-15"), "+79995330015");
  assert.throws(() => normalizePhone("+1 555 0100"));
  assert.throws(() => validatedCart([{ id: "not-a-uuid", size: "M", qty: 1 }]));
  assert.throws(() =>
    validateClientIdentity(
      "7c169f01-b459-4e25-b74f-a4909a1b4149",
      "short-token",
    ),
  );
});
