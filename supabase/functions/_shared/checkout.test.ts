import {
  CheckoutCartError,
  type CheckoutProductRow,
  resolveCartItems,
  resolveCartOffer,
  validatedCart,
} from "./checkout.ts";

const PRODUCT_ID = "7c169f01-b459-4e25-b74f-a4909a1b4149";

function product(
  overrides: Partial<CheckoutProductRow> = {},
): CheckoutProductRow {
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
    source_payload: {},
    ...overrides,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    `${message}: ${actualJson} !== ${expectedJson}`,
  );
}

function assertCartError(
  callback: () => unknown,
  code: string,
  status = 409,
) {
  try {
    callback();
  } catch (error) {
    assert(error instanceof CheckoutCartError, "expected CheckoutCartError");
    assertEquals(error.code, code, "unexpected error code");
    assertEquals(error.status, status, "unexpected status");
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("validatedCart preserves legacy input and normalizes optional offerId", () => {
  assertEquals(
    validatedCart([{ id: PRODUCT_ID, size: "s", qty: 1 }]),
    [{ id: PRODUCT_ID, size: "S", qty: 1 }],
    "legacy cart",
  );
  assertEquals(
    validatedCart([{
      id: PRODUCT_ID,
      size: "m",
      qty: 2,
      offerId: "  D018-HDY-EMB-BLK-REG-NF-M  ",
    }]),
    [{
      id: PRODUCT_ID,
      size: "M",
      qty: 2,
      offerId: "D018-HDY-EMB-BLK-REG-NF-M",
    }],
    "offer cart",
  );
  assertCartError(
    () => validatedCart([{ id: PRODUCT_ID, size: "S", qty: 1, offerId: " " }]),
    "invalid_cart_item",
    400,
  );
});

Deno.test("explicit offerId selects the exact visible offer and never falls back", () => {
  const row = product({
    offers: [
      { offer_id: "cropped-s", sku: "cropped", size: "S" },
      { offer_id: "regular-s", sku: "regular", size: "S" },
      { offer_id: "regular-m", sku: "regular-m", size: "M" },
    ],
  });

  assertEquals(
    resolveCartOffer(row, { size: "S", offerId: "regular-s" }).sku,
    "regular",
    "exact offer",
  );
  assertCartError(
    () => resolveCartOffer(row, { size: "M", offerId: "regular-s" }),
    "offer_unavailable",
  );
  assertCartError(
    () => resolveCartOffer(row, { size: "S", offerId: "missing-s" }),
    "offer_unavailable",
  );
});

Deno.test("archived and hidden offers are not selectable", () => {
  const row = product({
    offers: [
      { offer_id: "archived-s", size: "S", archived: true },
      { offer_id: "hidden-s", size: "S", visible: false },
    ],
  });

  assertCartError(
    () => resolveCartOffer(row, { size: "S", offerId: "archived-s" }),
    "offer_unavailable",
  );
  assertCartError(
    () => resolveCartOffer(row, { size: "S" }),
    "offer_unavailable",
  );
});

Deno.test("legacy cart resolves one offer and fails closed on zero or many", () => {
  assertEquals(
    resolveCartOffer(product(), { size: "S" }).offer_id,
    "D018-HDY-EMB-BLK-REG-NF-S",
    "one offer",
  );
  assertCartError(
    () => resolveCartOffer(product({ offers: [] }), { size: "S" }),
    "offer_unavailable",
  );
  assertCartError(
    () =>
      resolveCartOffer(
        product({
          offers: [
            { offer_id: "cropped-s", size: "S" },
            { offer_id: "regular-s", size: "S" },
          ],
        }),
        { size: "S" },
      ),
    "ambiguous_offer",
  );
});

Deno.test("legacy ambiguity marker blocks missing offerId but permits exact selection", () => {
  const row = product({
    source_payload: { checkout: { legacy_ambiguous_sizes: ["s"] } },
  });

  assertCartError(
    () => resolveCartOffer(row, { size: "S" }),
    "ambiguous_offer",
  );
  assertEquals(
    resolveCartOffer(row, {
      size: "S",
      offerId: "D018-HDY-EMB-BLK-REG-NF-S",
    }).sku,
    "sku-regular-s",
    "explicit offer with marker",
  );
});

Deno.test("duplicate exact offer IDs fail closed", () => {
  const row = product({
    offers: [
      { offer_id: "duplicate-s", size: "S" },
      { offer_id: "duplicate-s", size: "S" },
    ],
  });

  assertCartError(
    () => resolveCartOffer(row, { size: "S", offerId: "duplicate-s" }),
    "ambiguous_offer",
  );
});

Deno.test("resolved cart carries exact offer and prefers offer price", () => {
  const [item] = resolveCartItems(
    [{
      id: PRODUCT_ID,
      size: "S",
      qty: 2,
      offerId: "D018-HDY-EMB-BLK-REG-NF-S",
    }],
    [product()],
  );

  assertEquals(item.offerId, "D018-HDY-EMB-BLK-REG-NF-S", "offer id");
  assertEquals(item.sku, "sku-regular-s", "sku");
  assertEquals(item.unitPriceAmount, 370_000, "offer price");
  assertEquals(item.lineTotalAmount, 740_000, "line total");

  const [fallback] = resolveCartItems(
    [{ id: PRODUCT_ID, size: "S", qty: 1 }],
    [product({
      offers: [{ offer_id: "regular-s", sku: "regular", size: "S" }],
    })],
  );
  assertEquals(fallback.unitPriceAmount, 390_000, "product price fallback");
});
