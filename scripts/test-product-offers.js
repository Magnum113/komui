#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const offers = require('../assets/product-offers.js');

const base = {
  id: 'product-1',
  storefront_variant: { group_key: 'hoodie-gta', fit: 'cropped', warmth: 'no-fleece' },
  requires_offer_id_sizes: [],
  sizes: ['S', 'M', 'L'],
  offers: [
    { offer_id: 'GTA-CRP-NF-S', size: 'S', price: 4200, archived: false, visible: true },
    { offer_id: 'GTA-CRP-NF-M', size: 'M', price: 4200, archived: false, visible: null },
    { offer_id: 'GTA-CRP-NF-L', size: 'L', price: 4200, archived: true, visible: true },
    { offer_id: 'GTA-CRP-NF-XL', size: 'XL', price: 4200, archived: false, visible: false }
  ]
};

assert.equal(offers.selectable(base.offers[0]), true);
assert.equal(offers.selectable(base.offers[1]), true);
assert.equal(offers.selectable(base.offers[2]), false);
assert.equal(offers.selectable(base.offers[3]), false);

assert.deepEqual(
  offers.selectableOffers(base).map(offer => offer.offer_id),
  ['GTA-CRP-NF-S', 'GTA-CRP-NF-M']
);

assert.equal(offers.resolve(base, { offerId: 'GTA-CRP-NF-M', size: 'm' }).status, 'selected');
assert.equal(offers.resolve(base, { offerId: 'GTA-CRP-NF-M', size: 'S' }).status, 'unavailable');
assert.equal(offers.resolve(base, { offerId: 'GTA-CRP-NF-L', size: 'L' }).status, 'unavailable');
assert.equal(offers.resolve(base, { size: 'S' }).offerId, 'GTA-CRP-NF-S');
assert.equal(offers.resolve(base, {}).status, 'reselection_required');

const ambiguous = {
  ...base,
  requires_offer_id_sizes: [],
  offers: [
    { offer_id: 'GTA-CRP-NF-S', size: 'S' },
    { offer_id: 'GTA-REG-NF-S', size: 'S' }
  ]
};
assert.equal(offers.resolve(ambiguous, { size: 'S' }).status, 'ambiguous');

const explicitlyBlocked = { ...ambiguous, requires_offer_id_sizes: ['s'] };
assert.equal(offers.resolve(explicitlyBlocked, { size: 'S' }).status, 'reselection_required');

const oneButRequiresId = {
  ...base,
  requires_offer_id_sizes: ['M'],
  offers: [{ offer_id: 'GTA-CRP-NF-M', size: 'M' }]
};
assert.equal(offers.resolve(oneButRequiresId, { size: 'M' }).status, 'reselection_required');
assert.equal(
  offers.resolve(oneButRequiresId, { offer_id: 'GTA-CRP-NF-M', size: 'M' }).status,
  'selected'
);
const selectableMarkedOption = offers.sizeOptions(oneButRequiresId).find(option => option.size === 'M');
assert.equal(selectableMarkedOption.status, 'selected');
assert.equal(selectableMarkedOption.offerId, 'GTA-CRP-NF-M');

assert.deepEqual(offers.variantLabels(base), {
  groupKey: 'hoodie-gta',
  fit: 'Укороченная посадка',
  warmth: 'Без начёса'
});
assert.equal(
  offers.cartDescription(base, 'm'),
  'Укороченная посадка · Без начёса · Размер M'
);
assert.equal(offers.cartKey('product-1', 'GTA-CRP-NF-M'), 'product-1:GTA-CRP-NF-M');

const options = offers.sizeOptions(base);
assert.deepEqual(
  options.map(option => [option.size, option.status]),
  [['S', 'selected'], ['M', 'selected'], ['L', 'unavailable']]
);

const unorderedSizes = {
  sizes: ['XXL'],
  offers: [
    { offer_id: 'L', size: 'L' },
    { offer_id: 'S', size: 'S' },
    { offer_id: 'XL', size: 'XL' },
  ],
};
assert.deepEqual(offers.sizeOptions(unorderedSizes).map(option => option.size), ['S', 'L', 'XL', 'XXL']);

const missingOfferId = { sizes: ['S'], offers: [{ size: 'S' }] };
assert.equal(offers.resolve(missingOfferId, { size: 'S' }).status, 'reselection_required');
assert.equal(offers.sizeOptions(missingOfferId)[0].status, 'unavailable');

console.log('✓ product offer resolver tests passed');
