(function exposeProductFabricFacts(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KomuiProductFabricFacts = api;
})(typeof window !== 'undefined' ? window : globalThis, function createProductFabricFacts() {
  'use strict';

  const TSHIRT_FACTS = Object.freeze({
    composition: '100% хлопок',
    densityGsm: 240,
    densityLabel: '240 г/м²',
  });

  function normalized(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isTshirt(product) {
    if (!product || typeof product !== 'object') return false;
    const productType = normalized(product.product_type_slug || product.productTypeSlug);
    if (productType) return productType === 'tshirt';
    return normalized(product.category_slug || product.categorySlug) === 'tshirts';
  }

  function factsFor(product) {
    return isTshirt(product) ? TSHIRT_FACTS : null;
  }

  function normalizeTshirtCopy(product, value) {
    if (value == null) return value;
    const source = String(value);
    if (!source || !isTshirt(product)) return source;

    return source
      .replace(
        /\b\d{1,3}\s*%\s*хлоп(?:ок|ка)(?:\s*(?:[,/+;]|и)\s*\d{1,3}\s*%\s*[\p{L}-]+){1,3}/giu,
        TSHIRT_FACTS.composition,
      )
      .replace(
        /хлоп(?:ок|ка)\s*\d{1,3}\s*%(?:\s*(?:[,/+;]|и)\s*[\p{L}-]+\s*\d{1,3}\s*%){1,3}/giu,
        TSHIRT_FACTS.composition,
      )
      .replace(
        /\b\d{2,3}\s*(?:г|гр|грамм(?:а|ов)?)\s*\/?\s*м(?:²|2)/giu,
        TSHIRT_FACTS.densityLabel,
      )
      .replace(
        /(плотност(?:ь|и|ью)?(?:\s+ткани)?\s*[:—-]?\s*)\d{2,3}(?=\s*(?:г|гр|грамм(?:а|ов)?))/giu,
        `$1${TSHIRT_FACTS.densityGsm}`,
      );
  }

  return Object.freeze({
    TSHIRT_FACTS,
    isTshirt,
    factsFor,
    normalizeTshirtCopy,
  });
});
