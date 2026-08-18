#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const COUNTER_ID = '110916310';
const ROOT_PAGES = [
  '404.html', 'care.html', 'checkout.html', 'delivery.html', 'index.html',
  'marketing-consent.html', 'offer.html', 'payment-result.html',
  'personal-data-consent.html', 'privacy.html', 'returns.html', 'seller.html', 'sizes.html',
];
const GOALS = [
  'order_paid', 'begin_checkout', 'add_to_cart', 'product_view', 'checkout_submit',
  'payment_redirect', 'cdek_point_selected', 'promo_applied', 'catalog_view', 'cart_open',
  'remove_from_cart', 'cdek_picker_open', 'promo_copied', 'payment_create_failed',
  'payment_failed', 'payment_review',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function htmlFiles(relativeDir) {
  return fs.readdirSync(path.join(ROOT, relativeDir))
    .filter(file => file.endsWith('.html'))
    .map(file => path.join(relativeDir, file));
}

function assertTrackedPage(relativePath) {
  const html = read(relativePath);
  assert(html.includes(`metrika/tag.js?id=${COUNTER_ID}`), `${relativePath}: counter is missing`);
  assert(html.includes('/assets/metrika.js'), `${relativePath}: analytics module is missing`);
  assert(html.includes(`mc.yandex.ru/watch/${COUNTER_ID}`), `${relativePath}: noscript counter is missing`);
  assert.strictEqual((html.match(/komui:metrika:start/g) || []).length, 1, `${relativePath}: duplicate counter`);
}

ROOT_PAGES.forEach(assertTrackedPage);
htmlFiles('collections').forEach(assertTrackedPage);
htmlFiles('p')
  .filter(file => !read(file).includes('http-equiv="refresh"'))
  .forEach(assertTrackedPage);

const combinedSources = [
  read('assets/metrika.js'),
  read('index.html'),
  read('checkout.html'),
  read('payment-result.html'),
  read('scripts/build-products.js'),
].join('\n');
GOALS.forEach(goal => assert(combinedSources.includes(`'${goal}'`), `Goal ${goal} is not implemented`));

const checkoutHtml = read('checkout.html');
['lastName', 'firstName', 'phone', 'email', 'citySearch', 'pointSearch'].forEach(id => {
  assert(new RegExp(`<input[^>]*class="[^"]*ym-disable-keys[^"]*"[^>]*id="${id}"`).test(checkoutHtml), `${id}: Webvisor masking is missing`);
});
assert(read('index.html').includes('class="ym-disable-keys" type="email"'), 'Newsletter email: Webvisor masking is missing');
assert(read('payment-result.html').includes('class="ym-hide-content" id="orderNumber"'), 'Order number: Webvisor masking is missing');
assert(read('privacy.html').includes('Яндекс Метрика и Вебвизор'), 'Privacy policy does not disclose Yandex Metrika');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

const ymCalls = [];
const documentStub = {
  readyState: 'loading',
  addEventListener() {},
  dispatchEvent() {},
  getElementById() { return null; },
};
const windowStub = {
  location: { search: '', pathname: '/', hostname: 'komui.ru' },
  dataLayer: [],
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  console,
  setTimeout,
  clearTimeout,
  ym() {
    const args = Array.from(arguments);
    ymCalls.push(args);
    const callback = args[4];
    if (typeof callback === 'function') callback();
  },
  KOMUI_PRODUCTS: [],
};
windowStub.window = windowStub;
vm.runInNewContext(read('assets/metrika.js'), {
  window: windowStub,
  document: documentStub,
  CustomEvent: function CustomEvent(name) { this.type = name; },
  console,
});

const analytics = windowStub.KomuiAnalytics;
assert(analytics, 'KomuiAnalytics API is not exposed');
analytics.ecommerce.add({ id: 'p1', name: 'Товар', price: 2900, category: 'Футболки' }, { size: 'M', quantity: 1 });
assert.strictEqual(windowStub.dataLayer.at(-1).ecommerce.add.products[0].variant, 'M');

const purchase = {
  products: [{ id: 'p1', name: 'Товар', price: 2900, size: 'M', quantity: 1 }],
  revenue: 2900,
};
assert.strictEqual(analytics.ecommerce.purchaseOnce('KOM-TEST', purchase), true);
assert.strictEqual(analytics.ecommerce.purchaseOnce('KOM-TEST', purchase), false);
assert.strictEqual(windowStub.dataLayer.filter(item => item.ecommerce && item.ecommerce.purchase).length, 1);
const paidGoal = ymCalls.find(call => call[2] === 'order_paid');
assert(paidGoal, 'order_paid goal was not sent');
assert.strictEqual(paidGoal[3].order_price, 2900, 'order_paid must use the Yandex revenue parameter order_price');

analytics.goal('privacy_test', { email: 'hidden@example.com', phone: '+70000000000', product_id: 'p1' });
const privacyGoal = ymCalls.find(call => call[2] === 'privacy_test');
assert(privacyGoal, 'Test goal was not sent');
assert.strictEqual(privacyGoal[3].email, undefined);
assert.strictEqual(privacyGoal[3].phone, undefined);
assert.strictEqual(privacyGoal[3].product_id, 'p1');

assert(checkoutHtml.includes("await goalBeforeNavigation('payment_redirect'"), 'payment_redirect is not awaited before navigation');
assert(read('docs/YANDEX_METRIKA_ANALYTICS.md').includes('_ym_debug=2'), 'Official Yandex debug mode is not documented');

analytics.goalAndWait('navigation_test', { order_id: 'KOM-TEST' }, 250)
  .then(sent => {
    assert.strictEqual(sent, true, 'goalAndWait did not receive the Yandex callback');
    const navigationGoal = ymCalls.find(call => call[2] === 'navigation_test');
    assert(navigationGoal, 'goalAndWait did not send the goal');
    assert.strictEqual(typeof navigationGoal[4], 'function', 'goalAndWait must pass a callback to Yandex');
    console.log(`✓ Yandex Metrika: ${ROOT_PAGES.length} root pages, canonical product pages and collection pages verified`);
    console.log(`✓ ${GOALS.length} JavaScript goals, reliable redirect tracking and ecommerce purchase deduplication verified`);
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
