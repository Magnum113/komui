export const TSHIRT_FABRIC_FACTS = Object.freeze({
  composition: "100% хлопок",
  densityGsm: 240,
  densityLabel: "240 г/м²",
});

type ProductClassifier = {
  product_type_slug?: unknown;
  productTypeSlug?: unknown;
  category_slug?: unknown;
  categorySlug?: unknown;
};

function normalized(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function isTshirtProduct(product: ProductClassifier | null | undefined): boolean {
  if (!product || typeof product !== "object") return false;
  const productType = normalized(product.product_type_slug || product.productTypeSlug);
  if (productType) return productType === "tshirt";
  return normalized(product.category_slug || product.categorySlug) === "tshirts";
}

export function productFabricFactsFor(product: ProductClassifier | null | undefined) {
  return isTshirtProduct(product) ? TSHIRT_FABRIC_FACTS : null;
}

export function normalizeTshirtProductCopy(
  product: ProductClassifier | null | undefined,
  value: string | null | undefined,
): string | null | undefined {
  if (value == null) return value;
  const source = String(value);
  if (!source || !isTshirtProduct(product)) return source;

  return source
    .replace(
      /\b\d{1,3}\s*%\s*хлоп(?:ок|ка)(?:\s*(?:[,/+;]|и)\s*\d{1,3}\s*%\s*[\p{L}-]+){1,3}/giu,
      TSHIRT_FABRIC_FACTS.composition,
    )
    .replace(
      /хлоп(?:ок|ка)\s*\d{1,3}\s*%(?:\s*(?:[,/+;]|и)\s*[\p{L}-]+\s*\d{1,3}\s*%){1,3}/giu,
      TSHIRT_FABRIC_FACTS.composition,
    )
    .replace(
      /\b\d{2,3}\s*(?:г|гр|грамм(?:а|ов)?)\s*\/?\s*м(?:²|2)/giu,
      TSHIRT_FABRIC_FACTS.densityLabel,
    )
    .replace(
      /(плотност(?:ь|и|ью)?(?:\s+ткани)?\s*[:—-]?\s*)\d{2,3}(?=\s*(?:г|гр|грамм(?:а|ов)?))/giu,
      `$1${TSHIRT_FABRIC_FACTS.densityGsm}`,
    );
}
