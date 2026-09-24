const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const landingPaths = [
  '/catalog/anime-futbolki',
  '/catalog/anime-hudi',
  '/catalog/odezhda-s-vyshivkoy',
  '/catalog/odezhda-s-printom',
  '/catalog/futbolki-varenka',
  '/collections/satoru-gojo',
  '/collections/itachi-uchiha',
  '/collections/akatsuki',
];
const sitemap = read('sitemap.xml');
const home = read('index.html');

for (const urlPath of landingPaths) {
  const html = read(`${urlPath.slice(1)}.html`);
  assert.match(html, new RegExp(`<link rel="canonical" href="https://komui\\.ru${urlPath}"`));
  assert.match(html, /<h1>[^<]+<\/h1>/);
  assert.match(html, /<div class="c-grid"><article/);
  assert.ok(sitemap.includes(`<loc>https://komui.ru${urlPath}</loc>`), `${urlPath} missing in sitemap`);
  assert.ok(home.includes(`href="${urlPath}"`), `${urlPath} missing from home links`);
}

const productDir = path.join(root, 'p');
const titles = new Map();
let productCount = 0;
for (const filename of fs.readdirSync(productDir).filter(name => name.endsWith('.html'))) {
  const html = read(`p/${filename}`);
  if (!html.includes('<meta property="og:type" content="product"')) continue;
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  assert.ok(title, `missing title in ${filename}`);
  assert.ok(!titles.has(title), `duplicate product title: ${title} (${titles.get(title)}, ${filename})`);
  titles.set(title, filename);
  productCount++;
}
assert.ok(productCount > 0, 'expected generated product pages');

const hashiramaPath = 'p/futbolka-varenka-naruto-hashirama-senju-chb-print-seraya.html';
if (fs.existsSync(path.join(root, hashiramaPath))) {
  const hashirama = read(hashiramaPath);
  assert.match(hashirama, /srcset="[^"]+480\.webp 480w[^\"]+800\.webp 800w[^\"]+1200\.webp/);
  assert.ok(sitemap.includes('/p/futbolka-varenka-naruto-hashirama-senju-chb-print-seraya'));
}
console.log(`SEO landing checks passed: ${landingPaths.length} landings, ${productCount} unique product titles`);
