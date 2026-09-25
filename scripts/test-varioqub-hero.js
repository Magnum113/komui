#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/experiments/home-hero-2026-09-25/hero.css'), 'utf8');
const start = html.indexOf('<!-- Varioqub: homepage hero experiment');
const scriptMatch = html.slice(start).match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
assert(start !== -1 && scriptMatch, 'Varioqub bootstrap is missing');
assert(html.indexOf('<!-- komui:metrika:end -->') < start, 'Bootstrap must survive Metrika regeneration');
assert(html.includes('id="home"'), 'Original homepage anchor must remain');
assert(html.includes('class="hero-experiment"'), 'Alternate hero markup is missing');
assert(html.includes('/assets/experiments/home-hero-2026-09-25/hero.css'), 'Alternate hero CSS is missing');
assert(css.includes('#home .hero-experiment{display:none}'), 'Alternate hero must be hidden by default');

function execute(hostname, answer, { pathname = '/', search = '' } = {}) {
  const calls = [];
  const attrs = new Map();
  const firstScript = { parentNode: { insertBefore(node) { calls.push(['insert', node.src]); } } };
  const document = {
    documentElement: { setAttribute(key, value) { attrs.set(key, value); } },
    createElement() { return { addEventListener() {} }; },
    getElementsByTagName() { return [firstScript]; },
  };
  const window = { document, location: { hostname, pathname, search }, Array, URLSearchParams };
  window.window = window;
  vm.runInNewContext(scriptMatch[1], window);
  if (typeof window.ymab === 'function') {
    const call = window.ymab.a && window.ymab.a.find(args => args[1] === 'init');
    assert(call, 'Varioqub init must be called');
    assert.strictEqual(call[0], 'metrika.110916310');
    assert.strictEqual(typeof call[2], 'function');
    call[2](answer);
  }
  return { calls, attrs };
}

assert.strictEqual(execute('localhost', { flags: { komui_home_hero: ['B'] } }).calls.length, 0);
assert.strictEqual(execute('stage.komui.ru', { flags: { komui_home_hero: ['B'] } }).calls.length, 0);
for (const variant of ['B', 'C', 'D']) {
  const stage = execute('stage.komui.ru', { flags: {} }, { search: `?komui_home_hero=${variant}` });
  assert.strictEqual(stage.attrs.get('data-komui-hero-variant'), variant);
  assert.strictEqual(stage.calls.length, 0, 'Staging must not call Varioqub');
}
assert.strictEqual(execute('stage.komui.ru', { flags: {} }, { search: '?komui_home_hero=A' }).attrs.size, 0);
assert.strictEqual(execute('stage.komui.ru', { flags: {} }, { search: '?komui_home_hero=invalid' }).attrs.size, 0);
assert.strictEqual(execute('stage.komui.ru', { flags: {} }, { pathname: '/checkout', search: '?komui_home_hero=B' }).attrs.size, 0);
assert.strictEqual(execute('komui.ru', { flags: {} }, { search: '?komui_home_hero=B' }).attrs.size, 0, 'Production query must not force a variant');
assert.strictEqual(execute('komui.ru', { flags: {} }).attrs.size, 0);
assert.strictEqual(execute('komui.ru', { flags: { komui_home_hero: ['unknown'] } }).attrs.size, 0);
assert.strictEqual(execute('komui.ru', { flags: { komui_home_hero: ['A', 'B'] } }).attrs.get('data-komui-hero-variant'), 'B');
assert.strictEqual(execute('www.komui.ru', { flags: { komui_home_hero: ['C'] } }).attrs.get('data-komui-hero-variant'), 'C');
assert.strictEqual(execute('komui.ru', { flags: { komui_home_hero: ['D'] } }).attrs.get('data-komui-hero-variant'), 'D');

async function checkAssets() {
  const expected = [
    ['b-desktop-2k', 2752, 1536],
    ['b-mobile-2k', 1536, 2752],
    ['c-desktop', 1672, 941],
    ['c-mobile', 941, 1672],
    ['d-desktop', 1672, 941],
    ['d-mobile', 941, 1672],
  ];
  for (const [name, width, height] of expected) {
    const file = path.join(root, 'assets/experiments/home-hero-2026-09-25', `${name}.webp`);
    const { width: actualWidth, height: actualHeight, format } = await sharp(file).metadata();
    assert.deepStrictEqual([actualWidth, actualHeight, format], [width, height, 'webp']);
    assert(css.includes(`${name}.webp`), `${name} is not referenced by the responsive hero CSS`);
  }
  console.log('✓ Varioqub: production-only init, stage-only preview URLs, A fallback, B/C/D flags and six hero images verified');
}

checkAssets().catch(error => { console.error(error); process.exitCode = 1; });
