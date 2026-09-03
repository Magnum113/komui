import assert from "node:assert/strict";
import test from "node:test";
import {
  isTshirtProduct,
  normalizeTshirtProductCopy,
  productFabricFactsFor,
  TSHIRT_FABRIC_FACTS,
} from "../src/productFabricFacts";

const browserFacts = require("../../assets/product-fabric-facts.js") as {
  isTshirt(product: Record<string, unknown>): boolean;
  normalizeTshirtCopy(
    product: Record<string, unknown>,
    value: string | null | undefined,
  ): string | null | undefined;
};

test("T-shirt fabric facts use explicit product type before category fallback", () => {
  assert.equal(isTshirtProduct({ product_type_slug: "tshirt", category_slug: "hoodies" }), true);
  assert.equal(isTshirtProduct({ product_type_slug: "hoodie", category_slug: "tshirts" }), false);
  assert.equal(isTshirtProduct({ category_slug: "tshirts" }), true);
  assert.equal(productFabricFactsFor({ product_type_slug: "tshirt" }), TSHIRT_FABRIC_FACTS);
  assert.equal(productFabricFactsFor({ product_type_slug: "hoodie" }), null);
});

test("T-shirt copy exposes the approved composition and density formats", () => {
  assert.equal(
    normalizeTshirtProductCopy(
      { product_type_slug: "tshirt" },
      "95% хлопка, 5% эластана; плотность 90 г/м².",
    ),
    "100% хлопок; плотность 240 г/м².",
  );
  assert.equal(
    normalizeTshirtProductCopy(
      { product_type_slug: "tshirt" },
      "Хлопок 85%, полиэстер 10%, эластан 5%; плотность 230 гр/м2.",
    ),
    "100% хлопок; плотность 240 г/м².",
  );
  assert.equal(
    normalizeTshirtProductCopy(
      { product_type_slug: "tshirt" },
      "95% хлопка и 3% полиэстера + 2% эластана; плотность 210 г/м2.",
    ),
    "100% хлопок; плотность 240 г/м².",
  );
  assert.equal(normalizeTshirtProductCopy({ product_type_slug: "tshirt" }, null), null);
  assert.equal(normalizeTshirtProductCopy({ product_type_slug: "tshirt" }, undefined), undefined);
});

test("non-T-shirt copy remains byte-for-byte unchanged", () => {
  const source = "Плотность 370 г/м²; 80% хлопок, 20% полиэстер.";
  assert.equal(
    normalizeTshirtProductCopy({ product_type_slug: "hoodie" }, source),
    source,
  );
});

test("browser and API fabric normalizers stay in parity", () => {
  const cases: Array<{
    product: Record<string, unknown>;
    value: string | null | undefined;
  }> = [
    {
      product: { product_type_slug: "tshirt", category_slug: "tshirts" },
      value: "92% хлопок, 8% эластан; плотность 230 г/м².",
    },
    {
      product: { product_type_slug: "tshirt" },
      value: "Хлопок 85%; полиэстер 10%; эластан 5%; плотность 90 гр/м2.",
    },
    {
      product: { product_type_slug: "hoodie", category_slug: "tshirts" },
      value: "80% хлопок + 20% полиэстер; плотность 370 г/м².",
    },
    { product: { category_slug: "tshirts" }, value: null },
    { product: { category_slug: "tshirts" }, value: undefined },
  ];

  for (const item of cases) {
    assert.equal(
      browserFacts.isTshirt(item.product),
      isTshirtProduct(item.product),
    );
    assert.equal(
      browserFacts.normalizeTshirtCopy(item.product, item.value),
      normalizeTshirtProductCopy(item.product, item.value),
    );
  }
});
