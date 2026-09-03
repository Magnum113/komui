#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const facts = require('../assets/product-fabric-facts.js');

const ROOT = path.resolve(__dirname, '..');
const fallbackSource = fs.readFileSync(path.join(ROOT, 'data', 'storefront-products.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(fallbackSource, sandbox);
const products = sandbox.window.KOMUI_PRODUCTS || [];

const tshirts = products.filter(product => facts.isTshirt(product));
const otherProducts = products.filter(product => !facts.isTshirt(product));

assert.ok(tshirts.length > 0, 'fixture must contain T-shirts');
assert.ok(otherProducts.length > 0, 'fixture must contain non-T-shirts');
assert.equal(
  facts.normalizeTshirtCopy(
    { product_type_slug: 'tshirt' },
    'Плотность ткани 230 г/м², состав 92% хлопок, 8% эластан.',
  ),
  'Плотность ткани 240 г/м², состав 100% хлопок.',
);
assert.equal(
  facts.normalizeTshirtCopy(
    { product_type_slug: 'tshirt' },
    'Плотность: 200 грамм. 85% хлопок / 10% полиэстер / 5% эластан.',
  ),
  'Плотность: 240 грамм. 100% хлопок.',
);
assert.equal(
  facts.normalizeTshirtCopy(
    { product_type_slug: 'tshirt' },
    'Состав: 75% хлопок / 25% полиэстер.',
  ),
  'Состав: 100% хлопок.',
);
assert.equal(
  facts.normalizeTshirtCopy(
    { product_type_slug: 'tshirt' },
    'Хлопок 85%, полиэстер 10%, эластан 5%; плотность 90 гр/м2.',
  ),
  '100% хлопок; плотность 240 г/м².',
);
assert.equal(
  facts.normalizeTshirtCopy(
    { product_type_slug: 'tshirt' },
    '95% хлопка и 3% полиэстера + 2% эластана; плотность 210 г/м2.',
  ),
  '100% хлопок; плотность 240 г/м².',
);
assert.equal(facts.normalizeTshirtCopy({ product_type_slug: 'tshirt' }, null), null);
assert.equal(facts.normalizeTshirtCopy({ product_type_slug: 'tshirt' }, undefined), undefined);
assert.equal(
  facts.isTshirt({ product_type_slug: 'hoodie', category_slug: 'tshirts' }),
  false,
  'explicit product type must take precedence over a stale category slug',
);
assert.equal(
  facts.isTshirt({ category_slug: 'tshirts' }),
  true,
  'category slug remains a fallback when product type is absent',
);

for (const product of tshirts) {
  assert.deepEqual(facts.factsFor(product), facts.TSHIRT_FACTS);
  assert.equal(product.fabric_composition, facts.TSHIRT_FACTS.composition);
  assert.equal(product.fabric_density_gsm, facts.TSHIRT_FACTS.densityGsm);
  for (const field of ['description', 'ozon_description', 'short_description']) {
    const sourceCopy = String(product[field] || '');
    const sourceDensities = [...sourceCopy.matchAll(/\b(\d{2,3})\s*(?:г|гр|грамм(?:а|ов)?)\s*\/?\s*м(?:²|2)/giu)]
      .map(match => Number(match[1]));
    assert.ok(
      sourceDensities.every(value => value === 240),
      `${product.slug}: fallback ${field} contains a density other than 240 g/m²`,
    );
    assert.doesNotMatch(
      sourceCopy,
      /(?:\b\d{1,3}\s*%\s*хлоп(?:ок|ка)[^.!?]{0,80}\b\d{1,3}\s*%|хлоп(?:ок|ка)\s*\d{1,3}\s*%[^.!?]{0,80}\b\d{1,3}\s*%)/iu,
      `${product.slug}: fallback ${field} contains a blended composition`,
    );
  }
  const normalizedDescription = facts.normalizeTshirtCopy(product, product.description);
  const densities = [...normalizedDescription.matchAll(/\b(\d{2,3})\s*(?:г|гр|грамм(?:а|ов)?)\s*\/?\s*м(?:²|2)/giu)]
    .map(match => Number(match[1]));
  assert.ok(
    densities.every(value => value === 240),
    `${product.slug}: public description contains a density other than 240 g/m²`,
  );
  assert.doesNotMatch(
    normalizedDescription,
    /\b\d{1,3}\s*%\s*хлоп(?:ок|ка)(?:\s*[,/]\s*\d{1,3}\s*%)/iu,
    `${product.slug}: public description contains a blended composition`,
  );
}

for (const product of otherProducts) {
  assert.equal(facts.factsFor(product), null);
  assert.equal(product.fabric_composition, undefined);
  assert.equal(product.fabric_density_gsm, undefined);
  assert.equal(
    facts.normalizeTshirtCopy(product, product.description),
    String(product.description || ''),
    `${product.slug}: non-T-shirt copy must remain unchanged`,
  );
}

for (const product of products) {
  const pagePath = path.join(ROOT, 'p', `${product.slug}.html`);
  assert.ok(fs.existsSync(pagePath), `${product.slug}: generated product page is missing`);
  const html = fs.readFileSync(pagePath, 'utf8');
  const productLdMatch = html.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org\/"[\s\S]*?\})<\/script>/);
  assert.ok(productLdMatch, `${product.slug}: Product JSON-LD is missing`);
  const productLd = JSON.parse(productLdMatch[1]);
  const metaMatch = html.match(/<div class="p-meta">([\s\S]*?)<\/div>\s*<div class="p-sizes-wrap">/);
  assert.ok(metaMatch, `${product.slug}: product facts block is missing`);

  if (facts.isTshirt(product)) {
    assert.equal(productLd.material, facts.TSHIRT_FACTS.composition);
    assert.match(metaMatch[1], /<span>Плотность<\/span><strong>240 г\/м²<\/strong>/);
    assert.match(metaMatch[1], /<span>Состав<\/span><strong>100% хлопок<\/strong>/);
    const pageDensities = [...html.matchAll(/\b(\d{2,3})\s*(?:г|гр|грамм(?:а|ов)?)\s*\/?\s*м(?:²|2)/giu)]
      .map(match => Number(match[1]));
    assert.ok(
      pageDensities.every(value => value === 240),
      `${product.slug}: generated T-shirt page contains a conflicting density`,
    );
  } else {
    assert.equal('material' in productLd, false, `${product.slug}: non-T-shirt JSON-LD must not invent material`);
    assert.doesNotMatch(metaMatch[1], /<span>(?:Плотность|Состав)<\/span>/);
  }
}

const storefrontHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const factsAssetIndex = storefrontHtml.indexOf('<script src="./assets/product-fabric-facts.js"></script>');
const appScriptIndex = storefrontHtml.indexOf('<script id="app">');
assert.ok(factsAssetIndex >= 0, 'storefront must load the product fabric facts asset');
assert.ok(appScriptIndex > factsAssetIndex, 'fabric facts asset must load before the storefront app');

const llmsSummary = fs.readFileSync(path.join(ROOT, 'llms.txt'), 'utf8');
assert.match(
  llmsSummary,
  /все футболки — 100% хлопок плотностью 240 г\/м²/,
  'llms.txt must scope the universal fabric facts to T-shirts',
);
assert.doesNotMatch(
  llmsSummary,
  /машинная вышивка; 100% хлопок/,
  'llms.txt must not claim that every product is 100% cotton',
);

console.log(`✓ Product fabric facts: ${tshirts.length} T-shirts normalized; ${otherProducts.length} other products untouched; ${products.length} generated pages verified`);
