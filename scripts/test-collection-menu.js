const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('const COLLECTION_LABELS=');
const end = html.indexOf('function setProducts(', start);
assert.ok(start >= 0 && end > start, 'Collection labels must be defined before setProducts');
const collectionLabel = vm.runInNewContext(`${html.slice(start, end)}; collectionLabel`);

const sandbox = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(root, 'data/storefront-products.js'), 'utf8'), sandbox);
const products = sandbox.window.KOMUI_PRODUCTS;
assert.ok(Array.isArray(products) && products.length, 'Storefront fallback must contain products');

const groups = new Map();
for (const product of products) {
  const label = collectionLabel(product.collection_name || product.title_name || product.design_name || 'KOMUI');
  assert.match(label, /^[А-ЯЁа-яё\s]+$/, `Collection name is not Russian: ${label}`);
  groups.set(label, (groups.get(label) || 0) + 1);
}
assert.equal(collectionLabel('Madara'), 'Мадара Учиха');
assert.equal(collectionLabel('Madara Uchiha'), 'Мадара Учиха');
assert.equal(groups.get('Мадара Учиха'), 3, 'All Madara products must appear in one collection');
assert.equal([...groups.values()].reduce((sum, count) => sum + count, 0), products.length);
console.log(`Collection menu checks passed: ${groups.size} Russian collections, ${products.length} products, 3 Madara products`);
