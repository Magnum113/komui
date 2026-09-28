const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'checkout.html'), 'utf8');
const validateSource = html.slice(html.indexOf('function validate(){'), html.indexOf('async function quotePendingPoint'));

function validate({ fields = {}, point = null, consent = false, invalidOffer = false } = {}) {
  const actions = [];
  const errors = {};
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: fields[selector.slice(1)] || '', checked: consent,
      focus: () => actions.push('focus:' + selector),
      setAttribute() {},
      scrollIntoView: () => actions.push('scroll:' + selector),
      classList: { remove() {}, toggle: (_, value) => { errors[selector] = value; } },
    });
    return nodes.get(selector);
  };
  const context = {
    $, selectedPoint: point, invalidOfferSelection: () => invalidOffer,
    document: { querySelector: () => null },
    setFieldError: (id, invalid) => { errors[id] = invalid; },
    setTimeout: fn => fn(), openPickup: () => actions.push('pickup'),
    showToast: text => actions.push('toast:' + text),
    deliveryName: () => 'СДЭК',
  };
  vm.createContext(context);
  vm.runInContext(validateSource + '\nresult=validate();', context);
  return { valid: context.result, actions, errors };
}

const filled = { lastName: 'Тестов', firstName: 'Тест', phone: '+7 (000) 000-00-00', email: 'test@example.invalid' };
let result = validate();
assert.equal(result.valid, false);
assert.equal(result.actions[0], 'focus:#lastName');
assert(!result.actions.includes('pickup'), 'Empty contacts must not open delivery');
assert.equal(result.errors['#consents'], undefined, 'Consent must not be flagged before contacts');
result = validate({ fields: { ...filled, email: 'invalid' } });
assert.equal(result.actions[0], 'focus:#email');
assert(!result.actions.includes('pickup'));
result = validate({ fields: filled });
assert.equal(result.valid, false);
assert(result.actions.includes('pickup'), 'Valid contacts without a point must open delivery');
assert.equal(result.errors['#consents'], undefined);
result = validate({ fields: filled, point: { code: 'TEST' } });
assert.equal(result.valid, false);
assert.equal(result.actions[0], 'focus:#legalConsent');
assert.equal(result.errors['#consents'], true);
assert.equal(validate({ fields: filled, point: { code: 'TEST' }, consent: true }).valid, true);
assert.equal(validate({ fields: filled, point: { code: 'TEST' }, consent: true, invalidOffer: true }).valid, false);

assert.match(html, /class="summary-card collapsed"/);
assert.match(html, /class="summary-edit" href="\/#cart"/);
assert.match(html, /aria-controls="summaryContent"/);
assert.match(html, /id="summaryBrief"/);
assert.match(html, /\['lastName','firstName','phone','email'\]\.forEach/);

const viewSource = html.slice(html.indexOf('function setPickupView(view){'), html.indexOf('function initMap(){'));
const attrs = {};
const dialog = { dataset: {} };
let inits = 0, fits = 0, renders = 0;
const viewContext = {
  document: { querySelector: () => dialog },
  $: selector => ({ setAttribute: (key, value) => { attrs[selector + ':' + key] = value; } }),
  matchMedia: () => ({ matches: true }),
  initMap: () => { inits++; }, map: { container: { fitToViewport: () => { fits++; } } },
  renderMarkers: () => { renders++; }, requestAnimationFrame: fn => fn(),
};
vm.createContext(viewContext);
vm.runInContext(viewSource + '\nsetPickupView("list");', viewContext);
assert.equal(inits, 0, 'Mobile list must not require Maps to load');
assert.equal(attrs['#pickupListView:aria-pressed'], 'true');
vm.runInContext('setPickupView("map");', viewContext);
assert.equal(dialog.dataset.view, 'map');
assert.equal(attrs['#pickupMapView:aria-pressed'], 'true');
assert.equal(attrs['#pickupListView:aria-pressed'], 'false');
assert.equal(fits, 1);
assert.equal(renders, 1);
viewContext.matchMedia = () => ({ matches: false });
vm.runInContext('setPickupView("list");', viewContext);
assert.equal(inits, 2, 'Desktop keeps the side-by-side map');
console.log('✓ checkout: staged validation, collapsed summary, cart return and responsive pickup views');

// Promo stays outside the disclosure; the same controller serves both viewports.
assert(html.indexOf('id="promo"') < html.indexOf('id="summaryContent"'));
assert.match(html, /aria-controls="promoForm"/);
const promoNodes = new Map();
const promoContext = {
  $: selector => {
    if (!promoNodes.has(selector)) promoNodes.set(selector, {
      classList: { toggle: (key, value) => { promoNodes.get(selector)[key] = value; } },
      setAttribute: (key, value) => { promoNodes.get(selector)[key] = value; },
    });
    return promoNodes.get(selector);
  },
  appliedPromo: null, totalPromoDiscount: () => 290, money: value => value + ' ₽',
};
vm.createContext(promoContext);
vm.runInContext(html.slice(html.indexOf('function setPromoOpen('), html.indexOf('function promoPayload(')), promoContext);
vm.runInContext('renderPromoSummary();setPromoOpen(true);', promoContext);
assert.equal(promoNodes.get('#promoSummary').textContent, 'Добавить промокод');
assert.equal(promoNodes.get('#promoEdit').hidden, true);
assert.equal(promoNodes.get('#promoToggle')['aria-expanded'], 'true');
promoContext.appliedPromo = { code: 'KOMUI10', discountAmount: 290 };
vm.runInContext('renderPromoSummary();setPromoOpen(false);', promoContext);
assert.equal(promoNodes.get('#promoSummary').textContent, 'KOMUI10 · −290 ₽');
assert.equal(promoNodes.get('#promoEdit').textContent, 'Изменить');
assert.equal(promoNodes.get('#promoEdit').hidden, false);
assert.equal(promoNodes.get('#promoToggle')['aria-expanded'], 'false');
promoContext.appliedPromo = { code: 'UNVERIFIED' };
vm.runInContext('renderPromoSummary();', promoContext);
assert.equal(promoNodes.get('#promoSummary').textContent, 'Добавить промокод');
console.log('✓ checkout promo: independent disclosure, verified discount summary and edit state');
