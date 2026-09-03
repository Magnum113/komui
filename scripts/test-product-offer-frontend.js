#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  renderProductVariantSelector,
  renderProductVariantFacts,
  renderProductSizeOptions,
} = require('./build-products.js');

const root = path.resolve(__dirname, '..');
const cropped = {
  id: 'cropped',
  name: 'Худи GTA — укороченное, без начёса',
  slug: 'hudi-gta-cropped',
  sizes: ['S', 'M'],
  storefront_variant: { group_key: 'gta-hoodie', fit: 'cropped', warmth: 'no-fleece' },
  requires_offer_id_sizes: [],
  offers: [
    { offer_id: 'GTA-CRP-NF-S', size: 'S', price: 4200, archived: false, visible: true },
    { offer_id: 'GTA-CRP-NF-M', size: 'M', price: 4200, archived: false, visible: null },
  ],
};
const regular = {
  ...cropped,
  id: 'regular',
  name: 'Худи GTA — обычное, без начёса',
  slug: 'hudi-gta-regular',
  storefront_variant: { group_key: 'gta-hoodie', fit: 'regular', warmth: 'no-fleece' },
  offers: [{ offer_id: 'GTA-REG-NF-S', size: 'S', price: 4300 }],
};

const selector = renderProductVariantSelector(cropped, [regular, cropped]);
assert.match(selector, /aria-label="Посадка"/);
assert.match(selector, /href="\/p\/hudi-gta-cropped" aria-current="page"/);
assert.match(selector, />Укороченная<\/a>/);
assert.match(selector, /href="\/p\/hudi-gta-regular"/);
assert.match(selector, />Обычная<\/a>/);

const facts = renderProductVariantFacts(cropped, [cropped, regular]);
assert.match(facts, />Посадка<\/span><strong>Укороченная<\/strong>/);
assert.match(facts, />Утепление<\/span><strong>Без начёса<\/strong>/);
assert.equal(renderProductVariantFacts(cropped, [cropped]), '');

const sizes = renderProductSizeOptions(cropped);
assert.match(sizes, /type="radio"/);
assert.match(sizes, /data-offer-id="GTA-CRP-NF-S"/);
assert.doesNotMatch(sizes, /checked/);

const ambiguousSizes = renderProductSizeOptions({
  ...cropped,
  requires_offer_id_sizes: ['S'],
  offers: [
    { offer_id: 'GTA-CRP-NF-S', size: 'S' },
    { offer_id: 'GTA-REG-NF-S', size: 'S' },
  ],
});
assert.match(ambiguousSizes, /value="S"[^>]* disabled/);

const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const checkoutHtml = fs.readFileSync(path.join(root, 'checkout.html'), 'utf8');
const buildSource = fs.readFileSync(path.join(root, 'scripts', 'build-products.js'), 'utf8');
const generatedProductFiles = fs.readdirSync(path.join(root, 'p'))
  .filter(file => file.endsWith('.html'));
const productPagesWithTrailingWhitespace = generatedProductFiles.filter(file => {
  const source = fs.readFileSync(path.join(root, 'p', file), 'utf8');
  return /[\t ]+$/m.test(source);
});
const linkedVariantPages = [
  'hudi-grand-theft-auto-gta-bez-nachesa-vyshivka-chernaya.html',
  'ukorochennoe-hudi-grand-theft-auto-gta-bez-nachesa-vyshivka-chernaya.html',
  'hudi-gravity-vyshivka-belaya.html',
  'hudi-gravity-s-nachesom-vyshivka-belaya.html',
];
const singletonVariantPages = [
  'hudi-gravity-vyshivka-chernaya.html',
  'hudi-naruto-itachi-uchiha-vyshivka-chernaya.html',
  'hudi-naruto-itachi-uchiha-vyshivka-sinyaya.html',
];

const indexScriptStart = indexHtml.indexOf('<script id="app">') + '<script id="app">'.length;
const indexScriptEnd = indexHtml.indexOf('</script>', indexScriptStart);
assert.ok(indexScriptStart > 0 && indexScriptEnd > indexScriptStart);
assert.doesNotThrow(() => new Function(indexHtml.slice(indexScriptStart, indexScriptEnd)));

const checkoutMarker = "<script>\n(function(){\n'use strict';\nconst CART_KEY=";
const checkoutScriptStart = checkoutHtml.indexOf(checkoutMarker) + '<script>\n'.length;
const checkoutScriptEnd = checkoutHtml.indexOf('</script>', checkoutScriptStart);
assert.ok(checkoutScriptStart > 0 && checkoutScriptEnd > checkoutScriptStart);
assert.doesNotThrow(() => new Function(checkoutHtml.slice(checkoutScriptStart, checkoutScriptEnd)));

assert.match(indexHtml, /assets\/product-offers\.js/);
assert.doesNotMatch(indexHtml, /p\.sizes\.includes\('M'\)\?'M':p\.sizes\[0\]/);
assert.match(indexHtml, /PRODUCT_OFFERS\.cartKey\(id,resolved\.offerId\)/);
assert.match(indexHtml, /displayVariantLabels\(product,P\)/);
assert.match(checkoutHtml, /slug:p\.slug\|\|''/);
assert.match(checkoutHtml, /displayVariantLabels\(product,localProducts\)/);
assert.equal((checkoutHtml.match(/items:apiItems\(\)/g)||[]).length,3);
assert.match(checkoutHtml, /String\(item\.offerId\|\|''\),String\(item\.size\)/);
assert.match(buildSource, /<script src="\/assets\/product-offers\.js"><\/script>/);
assert.match(buildSource, /input\[type="radio"\]:checked/);
assert.deepEqual(productPagesWithTrailingWhitespace, []);
linkedVariantPages.forEach(file => {
  const source = fs.readFileSync(path.join(root, 'p', file), 'utf8');
  assert.match(source, /class="p-variants"/);
  assert.match(source, /<span>Посадка<\/span>/);
  assert.match(source, /<span>Утепление<\/span>/);
});
singletonVariantPages.forEach(file => {
  const source = fs.readFileSync(path.join(root, 'p', file), 'utf8');
  assert.doesNotMatch(source, /class="p-variants"/);
  assert.doesNotMatch(source, /<span>Посадка<\/span>/);
  assert.doesNotMatch(source, /<span>Утепление<\/span>/);
});

console.log('✓ product offer frontend/build tests passed');
