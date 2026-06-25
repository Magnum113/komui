#!/usr/bin/env node
/*
 * Static product page generator.
 * Reads data/storefront-products.js (window.KOMUI_PRODUCTS) and writes:
 *   - p/<slug>.html for every product
 *   - sitemap.xml at the repo root
 *   - robots.txt at the repo root (only if missing)
 *
 * Goal: give crawlers (Yandex, Google, GPTBot, PerplexityBot) real HTML
 * with names, descriptions, prices and JSON-LD Product schema, so the
 * catalog can be indexed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE_ORIGIN = 'https://komui.ru';
const STATIC_PAGES = [
  { url: '/', changefreq: 'weekly', priority: '1.0' },
  { url: '/delivery', changefreq: 'monthly', priority: '0.5' },
  { url: '/returns', changefreq: 'monthly', priority: '0.4' },
  { url: '/sizes', changefreq: 'monthly', priority: '0.5' },
  { url: '/care', changefreq: 'monthly', priority: '0.3' },
  { url: '/offer', changefreq: 'yearly', priority: '0.2' },
  { url: '/privacy', changefreq: 'yearly', priority: '0.2' },
  { url: '/seller', changefreq: 'yearly', priority: '0.2' },
];

function loadProducts() {
  const src = fs.readFileSync(path.join(ROOT, 'data/storefront-products.js'), 'utf8');
  const sandbox = { window: {} };
  // The data file does `window.KOMUI_PRODUCTS = [...]` plus a stats object.
  const fn = new Function('window', src);
  fn(sandbox.window);
  const products = sandbox.window.KOMUI_PRODUCTS || [];
  return products.filter(p => p && p.slug && Array.isArray(p.sizes) && p.sizes.length);
}

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function formatPriceRange(min, max) {
  const a = Math.round(Number(min));
  const b = Math.round(Number(max));
  if (!a) return '';
  if (!b || a === b) return `${a.toLocaleString('ru-RU')} ₽`;
  return `${a.toLocaleString('ru-RU')}–${b.toLocaleString('ru-RU')} ₽`;
}

function shortFrom(product) {
  const s = (product.short_description || product.description || '').trim();
  // Take first ~160 chars on a sentence-ish boundary for meta description.
  const clean = s.replace(/\s+/g, ' ').replace(/[🔹]/g, '').trim();
  if (clean.length <= 160) return clean;
  const cut = clean.slice(0, 157);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + '…';
}

function descriptionHtml(product) {
  const raw = (product.description || '').trim();
  if (!raw) return '';
  // Split into paragraphs by double newlines, then turn single newlines into <br>.
  const blocks = raw.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  return blocks
    .map(b => `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function productImages(product) {
  const list = (product.image_urls && product.image_urls.length ? product.image_urls : [product.primary_image_url])
    .filter(Boolean);
  // De-dupe while preserving order.
  return [...new Set(list)];
}

function buildJsonLd(product) {
  const images = productImages(product);
  const lowPrice = Number(product.price_min);
  const highPrice = Number(product.price_max);
  const offers = (product.offers || [])
    .filter(o => o && !o.archived)
    .map(o => ({
      '@type': 'Offer',
      sku: String(o.sku || o.offer_id || ''),
      name: o.name || product.name,
      price: Number(o.price || lowPrice),
      priceCurrency: product.currency || 'RUB',
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      url: `${SITE_ORIGIN}/p/${product.slug}`,
    }));
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: product.name,
    description: shortFrom(product),
    image: images,
    sku: product.slug,
    brand: { '@type': 'Brand', name: 'KOMUI' },
    category: product.category,
    color: product.color_name,
    material: '100% хлопок',
    url: `${SITE_ORIGIN}/p/${product.slug}`,
  };
  if (offers.length) {
    ld.offers = {
      '@type': 'AggregateOffer',
      priceCurrency: product.currency || 'RUB',
      lowPrice,
      highPrice: highPrice || lowPrice,
      offerCount: offers.length,
      offers,
    };
  } else if (lowPrice) {
    ld.offers = {
      '@type': 'Offer',
      priceCurrency: product.currency || 'RUB',
      price: lowPrice,
      availability: 'https://schema.org/InStock',
      url: `${SITE_ORIGIN}/p/${product.slug}`,
    };
  }
  return JSON.stringify(ld);
}

function buildBreadcrumbLd(product) {
  return JSON.stringify({
    '@context': 'https://schema.org/',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'KOMUI', item: SITE_ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: 'Каталог', item: SITE_ORIGIN + '/#catalog' },
      { '@type': 'ListItem', position: 3, name: product.category || 'Товары', item: SITE_ORIGIN + '/#catalog' },
      { '@type': 'ListItem', position: 4, name: product.name, item: `${SITE_ORIGIN}/p/${product.slug}` },
    ],
  });
}

function buildTitle(product) {
  // Keep under ~60 chars where possible. Brand suffix added.
  const base = product.name;
  const suffix = ' — KOMUI';
  if ((base + suffix).length <= 65) return base + suffix;
  return base;
}

function renderProductPage(product) {
  const images = productImages(product);
  const heroImage = images[0] || '';
  const galleryThumbs = images.slice(1, 8);
  const priceText = formatPriceRange(product.price_min, product.price_max);
  const oldPrice = Number(product.compare_at_price);
  const oldPriceHtml = oldPrice && oldPrice > Number(product.price_min)
    ? `<span class="p-price-old">${oldPrice.toLocaleString('ru-RU')} ₽</span>`
    : '';
  const title = buildTitle(product);
  const description = shortFrom(product);
  const canonical = `${SITE_ORIGIN}/p/${product.slug}`;
  const ogImage = heroImage || `${SITE_ORIGIN}/assets/og-image.png`;
  const sizeButtons = product.sizes
    .map((s, i) => `<button type="button" class="p-size${i === 0 ? ' is-active' : ''}" data-size="${escapeAttr(s)}">${escapeHtml(s)}</button>`)
    .join('');
  const galleryHtml = images.length
    ? `<div class="p-gallery">
        <div class="p-hero"><img id="pHero" src="${escapeAttr(heroImage)}" alt="${escapeAttr(product.name)}" loading="eager"></div>
        ${galleryThumbs.length ? `<div class="p-thumbs">${galleryThumbs.map(u => `<button type="button" class="p-thumb" data-src="${escapeAttr(u)}"><img src="${escapeAttr(u)}" alt="${escapeAttr(product.name)}" loading="lazy"></button>`).join('')}</div>` : ''}
       </div>`
    : '';
  const badgeSeen = new Set();
  const badgePool = [product.collection_name, product.anime_title, product.character_name]
    .filter(Boolean)
    .filter(v => { const k = v.toLowerCase(); if (badgeSeen.has(k)) return false; badgeSeen.add(k); return true; });
  const badgesHtml = badgePool.map(v => `<span>${escapeHtml(v)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttr(description)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:site_name" content="KOMUI" />
<meta property="og:type" content="product" />
<meta property="og:title" content="${escapeAttr(title)}" />
<meta property="og:description" content="${escapeAttr(description)}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:image" content="${escapeAttr(ogImage)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeAttr(title)}" />
<meta name="twitter:description" content="${escapeAttr(description)}" />
<meta name="twitter:image" content="${escapeAttr(ogImage)}" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://ir.ozone.ru">
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;700;900&family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/legal.css" />
<link rel="stylesheet" href="/assets/product.css" />
<script type="application/ld+json">${buildJsonLd(product)}</script>
<script type="application/ld+json">${buildBreadcrumbLd(product)}</script>
</head>
<body>
<header class="site-header">
  <div class="wrap nav">
    <a class="brand" href="/">KOMUI<span class="dot">.</span></a>
    <nav class="nav-links">
      <a href="/#catalog">Каталог</a>
      <a href="/delivery">Доставка</a>
      <a href="/returns">Возврат</a>
      <a href="/sizes">Размеры</a>
    </nav>
  </div>
</header>
<main>
  <section class="p-page">
    <div class="wrap">
      <nav class="crumb" aria-label="Хлебные крошки">
        <a href="/">KOMUI</a><span>/</span>
        <a href="/#catalog">Каталог</a><span>/</span>
        <span>${escapeHtml(product.category || 'Товары')}</span><span>/</span>
        <span>${escapeHtml(product.name)}</span>
      </nav>
      <div class="p-layout">
        ${galleryHtml}
        <div class="p-info">
          ${badgesHtml ? `<div class="p-badges">${badgesHtml}</div>` : ''}
          <h1>${escapeHtml(product.name)}</h1>
          ${product.short_description ? `<p class="p-lead">${escapeHtml(product.short_description)}</p>` : ''}
          <div class="p-price-row">
            <span class="p-price">${escapeHtml(priceText)}</span>
            ${oldPriceHtml}
          </div>
          <div class="p-meta">
            ${product.color_name ? `<div><span>Цвет</span><strong>${escapeHtml(product.color_name)}</strong></div>` : ''}
            ${product.decoration_type ? `<div><span>Оформление</span><strong>${escapeHtml(product.decoration_type)}</strong></div>` : ''}
            ${product.category ? `<div><span>Категория</span><strong>${escapeHtml(product.category)}</strong></div>` : ''}
            <div><span>Состав</span><strong>100% хлопок</strong></div>
          </div>
          <div class="p-sizes-wrap">
            <div class="p-label">Размер</div>
            <div class="p-sizes" id="pSizes">${sizeButtons}</div>
          </div>
          <div class="p-actions">
            <button type="button" class="p-cta" id="pAdd" data-id="${escapeAttr(product.id)}">Добавить в корзину</button>
            <a class="p-secondary" href="/#catalog">К другим товарам</a>
          </div>
          <div class="p-trust">
            <div>СДЭК по России</div>
            <div>Оплата онлайн</div>
            <div>Возврат в течение 7 дней</div>
          </div>
        </div>
      </div>
      ${product.description ? `<section class="p-desc"><h2>Описание</h2>${descriptionHtml(product)}</section>` : ''}
    </div>
  </section>
</main>
<footer><div class="wrap foot">
  <div><h5>KOMUI</h5><p>Аниме-мерч: футболки, худи и свитшоты с принтами и вышивкой.</p></div>
  <div><h5>Покупателю</h5><a href="/delivery">Доставка и оплата</a><a href="/returns">Возврат и обмен</a><a href="/sizes">Размерная сетка</a><a href="/care">Уход</a></div>
  <div><h5>Документы</h5><a href="/seller">Продавец</a><a href="/offer">Публичная оферта</a><a href="/privacy">Политика ПДн</a></div>
  <div><h5>Контакты</h5><a href="mailto:smmshit@ya.ru">smmshit@ya.ru</a><a href="/#catalog">Каталог</a></div>
</div></footer>
<script>
(function(){
  var CART_KEY = 'komui-cart-v1';
  var sizes = document.getElementById('pSizes');
  var add = document.getElementById('pAdd');
  if (sizes) {
    sizes.addEventListener('click', function(e){
      var btn = e.target.closest('.p-size');
      if (!btn) return;
      sizes.querySelectorAll('.p-size').forEach(function(b){ b.classList.remove('is-active'); });
      btn.classList.add('is-active');
    });
  }
  var hero = document.getElementById('pHero');
  var thumbs = document.querySelectorAll('.p-thumb');
  thumbs.forEach(function(t){
    t.addEventListener('click', function(){
      var src = t.getAttribute('data-src');
      if (src && hero) hero.src = src;
      thumbs.forEach(function(x){ x.classList.remove('is-active'); });
      t.classList.add('is-active');
    });
  });
  if (add) {
    add.addEventListener('click', function(){
      var id = add.getAttribute('data-id');
      var activeSize = sizes && sizes.querySelector('.p-size.is-active');
      var size = activeSize ? activeSize.getAttribute('data-size') : null;
      if (!id || !size) return;
      var cart = [];
      try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch(e){ cart = []; }
      var key = id + '-' + size;
      var existing = cart.find(function(c){ return c.key === key; });
      if (existing) existing.qty += 1;
      else cart.push({ key: key, id: id, size: size, qty: 1 });
      try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch(e){}
      add.textContent = 'Добавлено · перейти в корзину';
      add.classList.add('is-added');
      add.onclick = function(){ location.href = '/#cart'; };
    });
  }
})();
</script>
</body>
</html>
`;
}

function renderSitemap(products) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ...STATIC_PAGES.map(p => ({
      loc: SITE_ORIGIN + p.url,
      lastmod: today,
      changefreq: p.changefreq,
      priority: p.priority,
    })),
    ...products.map(p => ({
      loc: `${SITE_ORIGIN}/p/${p.slug}`,
      lastmod: today,
      changefreq: 'weekly',
      priority: '0.8',
    })),
  ];
  const body = urls
    .map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function renderRobots() {
  return `# https://komui.ru/robots.txt
User-agent: *
Allow: /
Disallow: /api/
Disallow: /checkout
Disallow: /payment-result
Disallow: /marketing-consent
Disallow: /personal-data-consent

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;
}

function main() {
  const products = loadProducts();
  if (!products.length) {
    console.error('No products found in data/storefront-products.js');
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'p');
  fs.mkdirSync(outDir, { recursive: true });

  // Wipe stale .html files in /p (slugs may have changed).
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith('.html')) fs.unlinkSync(path.join(outDir, file));
  }

  let written = 0;
  for (const product of products) {
    const html = renderProductPage(product);
    fs.writeFileSync(path.join(outDir, `${product.slug}.html`), html, 'utf8');
    written += 1;
  }

  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), renderSitemap(products), 'utf8');

  const robotsPath = path.join(ROOT, 'robots.txt');
  fs.writeFileSync(robotsPath, renderRobots(), 'utf8');

  console.log(`✓ Wrote ${written} product page(s) to /p`);
  console.log('✓ Wrote sitemap.xml');
  console.log('✓ Wrote robots.txt');
}

main();
