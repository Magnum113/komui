#!/usr/bin/env node
/*
 * Static product page generator.
 * Reads data/storefront-products.js (window.KOMUI_PRODUCTS) and writes:
 *   - p/<slug>.html for every product
 *   - collections/<slug>.html for high-intent collection landing pages
 *   - sitemap.xml at the repo root
 *   - robots.txt at the repo root (only if missing)
 *
 * Goal: give crawlers (Yandex, Google, GPTBot, PerplexityBot) real HTML
 * with names, descriptions, prices and JSON-LD Product schema, so the
 * catalog can be indexed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SITE_ORIGIN = 'https://komui.ru';
const API_BASE_URL = String(process.env.KOMUI_API_BASE_URL || '').replace(/\/$/, '');
const API_PRODUCTS_PATH = process.env.KOMUI_API_PRODUCTS_PATH || '/v1/products?limit=200';
const API_TIMEOUT_MS = 10_000;
const PAGE_LASTMOD_REGISTRY_PATH = process.env.KOMUI_PAGE_LASTMOD_REGISTRY_PATH
  || path.join(ROOT, '.komui', 'page-lastmod.json');
const TODAY = new Date().toISOString().slice(0, 10);
const DATE_PUBLISHED_PLACEHOLDER = '__KOMUI_DATE_PUBLISHED__';
const DATE_MODIFIED_PLACEHOLDER = '__KOMUI_DATE_MODIFIED__';
const DATE_MODIFIED_RU_PLACEHOLDER = '__KOMUI_DATE_MODIFIED_RU__';
const LOCAL_MEDIA_MANIFEST_PATH = path.join(ROOT, '.komui', 'media-cache', 'manifest.json');
const DEFAULT_MEDIA_MANIFEST_PATH = fs.existsSync(LOCAL_MEDIA_MANIFEST_PATH)
  ? LOCAL_MEDIA_MANIFEST_PATH
  : '/var/lib/komui/media-cache/manifest.json';
const MEDIA_MANIFEST_PATH = process.env.KOMUI_MEDIA_MANIFEST_PATH || DEFAULT_MEDIA_MANIFEST_PATH;
const MEDIA_STRICT = process.env.KOMUI_MEDIA_STRICT === '1';
const MEDIA_PUBLIC_PREFIX = '/media/products/';
const INDEXNOW_ENABLED = process.env.KOMUI_INDEXNOW_PING === '1';
const INDEXNOW_ENDPOINT = process.env.KOMUI_INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow';
const INDEXNOW_KEY_FILE = process.env.KOMUI_INDEXNOW_KEY_FILE || '';
const STATIC_PAGES = [
  { url: '/', file: 'index.html', changefreq: 'weekly', priority: '1.0' },
  { url: '/delivery', file: 'delivery.html', changefreq: 'monthly', priority: '0.5' },
  { url: '/returns', file: 'returns.html', changefreq: 'monthly', priority: '0.4' },
  { url: '/sizes', file: 'sizes.html', changefreq: 'monthly', priority: '0.5' },
  { url: '/care', file: 'care.html', changefreq: 'monthly', priority: '0.3' },
  { url: '/offer', file: 'offer.html', changefreq: 'yearly', priority: '0.2' },
  { url: '/privacy', file: 'privacy.html', changefreq: 'yearly', priority: '0.2' },
  { url: '/seller', file: 'seller.html', changefreq: 'yearly', priority: '0.2' },
];

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function dateOnly(value) {
  if (!value) return TODAY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return TODAY;
  return date.toISOString().slice(0, 10);
}

function maxDate(...dates) {
  return dates.map(dateOnly).sort().at(-1) || TODAY;
}

function gitDateForPath(relativePath) {
  try {
    const output = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', relativePath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (output) return dateOnly(output);
  } catch {
    // Fall through to filesystem mtime.
  }

  try {
    return dateOnly(fs.statSync(path.join(ROOT, relativePath)).mtime);
  } catch {
    return TODAY;
  }
}

function readPageLastmodRegistry() {
  const registry = readJsonIfExists(PAGE_LASTMOD_REGISTRY_PATH);
  return registry && typeof registry === 'object' ? registry : {};
}

function writePageLastmodRegistry(registry) {
  ensureDirForFile(PAGE_LASTMOD_REGISTRY_PATH);
  fs.writeFileSync(PAGE_LASTMOD_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function createPageMetaTracker() {
  const registry = readPageLastmodRegistry();
  const nextRegistry = {};
  const pages = new Map();

  return {
    track(urlPath, contentForHash, fallbackDate) {
      const key = urlPath || '/';
      const hash = sha256(contentForHash);
      const previous = registry[key] && typeof registry[key] === 'object' ? registry[key] : null;
      const published = previous?.datePublished || dateOnly(fallbackDate);
      const modified = previous?.hash === hash
        ? previous.dateModified || published
        : previous
          ? TODAY
          : published;
      const meta = {
        hash,
        datePublished: published,
        dateModified: modified,
      };
      nextRegistry[key] = meta;
      pages.set(key, meta);
      return meta;
    },
    page(urlPath) {
      return pages.get(urlPath || '/');
    },
    sitemapDate(urlPath) {
      return pages.get(urlPath || '/')?.dateModified || TODAY;
    },
    save() {
      writePageLastmodRegistry(nextRegistry);
    },
  };
}

function formatDateRu(date) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}

function replaceDatePlaceholders(html, meta) {
  return String(html)
    .replaceAll(DATE_PUBLISHED_PLACEHOLDER, meta.datePublished)
    .replaceAll(DATE_MODIFIED_PLACEHOLDER, meta.dateModified)
    .replaceAll(DATE_MODIFIED_RU_PLACEHOLDER, formatDateRu(meta.dateModified));
}

function renderUpdatedBadge(meta, className = '') {
  const classes = ['page-updated', className].filter(Boolean).join(' ');
  return `<div class="${classes}">Обновлено: <time datetime="${escapeAttr(meta.dateModified)}">${escapeHtml(formatDateRu(meta.dateModified))}</time></div>`;
}

function renderUpdatedPlaceholder(className = '') {
  const classes = ['page-updated', className].filter(Boolean).join(' ');
  return `<div class="${classes}">Обновлено: <time datetime="${DATE_MODIFIED_PLACEHOLDER}">${DATE_MODIFIED_RU_PLACEHOLDER}</time></div>`;
}

function renderUpdatedFooterPlaceholder() {
  return renderUpdatedPlaceholder('footer-updated');
}

function loadMediaManifest() {
  const manifest = readJsonIfExists(MEDIA_MANIFEST_PATH);
  const images = manifest && manifest.images && typeof manifest.images === 'object'
    ? manifest.images
    : {};
  const bySource = new Map();
  const byPublicUrl = new Map();

  for (const [sourceUrl, entry] of Object.entries(images)) {
    if (!entry || typeof entry !== 'object') continue;
    bySource.set(sourceUrl, entry);
    for (const url of [
      entry.original,
      entry.fallback,
      entry.thumb,
      ...(Array.isArray(entry.variants) ? entry.variants.map(variant => variant && variant.url) : []),
    ]) {
      if (typeof url === 'string' && url) byPublicUrl.set(url, entry);
    }
  }

  return {
    path: MEDIA_MANIFEST_PATH,
    loaded: Boolean(manifest),
    bySource,
    byPublicUrl,
  };
}

const MEDIA_MANIFEST = loadMediaManifest();

function isOzonImageUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname === 'ir.ozone.ru';
  } catch {
    return false;
  }
}

function isPublicMediaUrl(value) {
  return typeof value === 'string' && value.startsWith(MEDIA_PUBLIC_PREFIX);
}

function absolutizeUrl(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (String(value).startsWith('/')) return `${SITE_ORIGIN}${value}`;
  return value;
}

function mediaEntryFor(value) {
  if (!value || typeof value !== 'string') return null;
  if (MEDIA_MANIFEST.bySource.has(value)) return MEDIA_MANIFEST.bySource.get(value);
  if (MEDIA_MANIFEST.byPublicUrl.has(value)) return MEDIA_MANIFEST.byPublicUrl.get(value);
  return null;
}

function resolvePublicImage(value, options = {}) {
  if (!value) return '';
  const absolute = Boolean(options.absolute);
  const entry = mediaEntryFor(value);
  const resolved = entry && options.variant === 'thumb' && entry.thumb
    ? entry.thumb
    : entry && entry.fallback
      ? entry.fallback
      : value;

  if (isOzonImageUrl(value) && !entry && MEDIA_STRICT) {
    throw new Error(`Media manifest does not contain Ozon image URL: ${value}`);
  }

  return absolute ? absolutizeUrl(resolved) : resolved;
}

function resolvePublicImages(values, options = {}) {
  return (values || [])
    .map(value => resolvePublicImage(value, options))
    .filter(Boolean);
}

function imageSrcSet(value, options = {}) {
  const absolute = Boolean(options.absolute);
  if (options.variant === 'thumb') return '';
  const entry = mediaEntryFor(value);
  if (!entry || !Array.isArray(entry.variants)) return '';
  return entry.variants
    .filter(variant => variant && variant.url && variant.width)
    .map(variant => `${absolute ? absolutizeUrl(variant.url) : variant.url} ${variant.width}w`)
    .join(', ');
}

function imageDimensions(value) {
  const entry = mediaEntryFor(value);
  if (!entry) return {};
  const fallback = Array.isArray(entry.variants)
    ? entry.variants.find(variant => variant && variant.url === entry.fallback) || entry.variants[0]
    : null;
  return {
    width: Number((fallback && fallback.width) || entry.width) || undefined,
    height: Number((fallback && fallback.height) || entry.height) || undefined,
  };
}

function imageThumbDimensions(value) {
  const entry = mediaEntryFor(value);
  if (!entry || !entry.thumb || !entry.width || !entry.height) return {};
  const ratio = Number(entry.height) / Number(entry.width);
  if (!Number.isFinite(ratio) || ratio <= 0) return {};
  return {
    width: 320,
    height: Math.round(320 * ratio),
  };
}

function renderResponsiveImage(value, options = {}) {
  if (!value) return '';
  const src = resolvePublicImage(value, options);
  const srcset = imageSrcSet(value, options);
  const dimensions = options.variant === 'thumb' ? imageThumbDimensions(value) : imageDimensions(value);
  const attrs = [
    options.className ? `class="${escapeAttr(options.className)}"` : '',
    `src="${escapeAttr(src)}"`,
    srcset ? `srcset="${escapeAttr(srcset)}"` : '',
    options.sizes ? `sizes="${escapeAttr(options.sizes)}"` : '',
    `alt="${escapeAttr(options.alt || '')}"`,
    dimensions.width ? `width="${escapeAttr(dimensions.width)}"` : '',
    dimensions.height ? `height="${escapeAttr(dimensions.height)}"` : '',
    `loading="${escapeAttr(options.loading || 'lazy')}"`,
    options.fetchpriority ? `fetchpriority="${escapeAttr(options.fetchpriority)}"` : '',
    `decoding="${escapeAttr(options.decoding || 'async')}"`,
    options.draggable === false ? 'draggable="false"' : '',
  ].filter(Boolean);
  return `<img ${attrs.join(' ')}>`;
}

function mapProductMedia(product) {
  const mapped = {
    ...product,
    primary_image_url: resolvePublicImage(product.primary_image_url),
    main_image_path: resolvePublicImage(product.main_image_path),
    image_urls: resolvePublicImages(product.image_urls || []),
    offers: Array.isArray(product.offers)
      ? product.offers.map(offer => ({
          ...offer,
          primary_image: resolvePublicImage(offer && offer.primary_image),
          images: resolvePublicImages((offer && offer.images) || []),
        }))
      : [],
  };
  return mapped;
}
const COLLECTION_LANDINGS = [
  {
    slug: 'naruto',
    name: 'Naruto',
    title: 'Аниме-мерч Naruto',
    h1: 'Аниме-мерч Naruto: футболки, худи и свитшоты',
    metaDescription: 'Футболки, худи и свитшоты KOMUI по Naruto: Akatsuki, Itachi, Madara и Naruto Uzumaki. Принты и вышивка, доставка СДЭК по России.',
    aliases: ['naruto', 'наруто', 'akatsuki', 'акацуки', 'itachi', 'итачи', 'madara', 'мадара', 'uchiha', 'учиха'],
    lead: 'Подборка вещей KOMUI по Naruto: узнаваемые символы Akatsuki, образы Itachi, Madara и Naruto Uzumaki в формате футболок, худи и свитшотов.',
    copy: [
      'Если нужен аниме-мерч Naruto без долгого поиска по всему каталогу, эта страница собирает модели KOMUI по одной теме. Здесь есть футболки Naruto с принтом, вещи с аккуратной вышивкой Akatsuki, худи и свитшоты с акцентом на Itachi Uchiha, а также модели для тех, кто предпочитает более спокойный streetwear. Такой лендинг удобен, когда запрос уже конкретный: футболка Наруто, худи Итачи, футболка Akatsuki или подарок фанату Naruto.',
      'Главная разница между моделями — техника нанесения и посадка. Принт лучше подходит, если хочется заметный визуальный акцент и яркий образ для фото. Вышивка выглядит тише, дольше остается нейтральной в повседневной носке и проще сочетается с базовыми джинсами, карго, куртками и кроссовками. Футболки легче носить круглый год, худи и свитшоты лучше работают как самостоятельный слой в прохладный сезон.',
      'Перед заказом проверьте карточку товара: цвет, доступные размеры, тип нанесения и актуальную цену. Если сомневаетесь между размерами, ориентируйтесь на желаемую посадку: для свободного силуэта обычно выбирают размер больше, для более спокойной посадки — привычный размер. Доставка оформляется СДЭК по России, а рекомендации по стирке помогут сохранить принт или вышивку: вещь лучше стирать наизнанку при температуре до 30 градусов и не гладить нанесение напрямую.'
    ],
  },
  {
    slug: 'jujutsu-kaisen',
    name: 'Jujutsu Kaisen',
    title: 'Аниме-мерч Jujutsu Kaisen',
    h1: 'Аниме-мерч Jujutsu Kaisen: футболки Сатору Годжо',
    metaDescription: 'Футболки KOMUI по Jujutsu Kaisen и Сатору Годжо: белые, черные и вареные модели с принтом. Доставка СДЭК по России.',
    aliases: ['jujutsu kaisen', 'магическая битва', 'satoru', 'gojo', 'годжо', 'сатору'],
    lead: 'Страница для тех, кто ищет футболку Jujutsu Kaisen или мерч с Сатору Годжо: собрали принты KOMUI в разных цветах и посадках.',
    copy: [
      'Jujutsu Kaisen часто ищут не как абстрактный аниме-мерч, а как конкретную вещь: футболка Сатору Годжо, Gojo Satoru shirt, футболка Магическая битва или оверсайз-футболка с принтом. Поэтому на этой странице собрана отфильтрованная подборка KOMUI по Jujutsu Kaisen, чтобы сразу видеть модели с нужной темой, не смешивая их с Naruto, Gravity или другими коллекциями.',
      'В ассортименте есть базовые белые и черные футболки, а также вареные модели с эффектом acid wash. Вареная ткань выглядит менее ровной и более streetwear, поэтому каждая вещь визуально чуть отличается. Если нужен спокойный повседневный вариант, проще начать с белой или черной футболки. Если хочется более заметный образ, смотрите вареные цвета и крупный DTF-принт.',
      'При выборе обращайте внимание на плотность, цвет, размерную сетку и тип посадки. Для свободного силуэта лучше сравнить замеры с любимой футболкой, а не выбирать только по букве размера. DTF-принт рассчитан на регулярную носку, но требует нормального ухода: стирка наизнанку до 30 градусов, без отбеливателя, без машинной сушки и без прямого утюга по рисунку. Заказы можно оформить онлайн с доставкой СДЭК по России до удобного пункта выдачи.'
    ],
  },
  {
    slug: 'gravity',
    name: 'Gravity',
    title: 'Мерч Gravity',
    h1: 'Мерч Gravity: футболки и худи в стиле ностальгичного streetwear',
    metaDescription: 'Футболки и худи KOMUI по Gravity: принты и вышивка, базовые цвета, оверсайз-посадка и доставка СДЭК по России.',
    aliases: ['gravity', 'гравити', 'gravity defied'],
    lead: 'Подборка вещей Gravity для тех, кто любит ностальгичные игровые отсылки и хочет носить их в более спокойном streetwear-формате.',
    copy: [
      'Коллекция Gravity в KOMUI — это мерч для тех, кому важна не только узнаваемая отсылка, но и повседневная носибельность. Здесь собраны футболки и худи с принтом или вышивкой: от базовых белых и черных моделей до вареных футболок с более выраженным streetwear-настроением. Такой формат хорошо подходит тем, кто ищет футболку Gravity, худи Gravity или подарок человеку, который ценит старые мобильные игры и лаконичные фанатские детали.',
      'Если хочется более заметный вариант, выбирайте принт: он сильнее работает как центральный элемент образа. Если нужна вещь спокойнее, лучше смотреть вышивку — она выглядит аккуратнее, не спорит с верхней одеждой и проще вписывается в ежедневный гардероб. Худи удобно носить как теплый слой, футболка подойдет для круглогодичной базы под рубашку, куртку или самостоятельный летний образ.',
      'На странице показан только отфильтрованный ассортимент по теме Gravity, поэтому проще сравнить цвета, цены и доступные размеры. Перед покупкой проверьте карточку конкретной модели: там указаны фотографии, тип нанесения и размерный ряд. Для ухода используйте деликатную стирку до 30 градусов и сушку вдали от прямого тепла. Оформление заказа проходит онлайн, доставка доступна СДЭК по России до выбранного пункта выдачи.'
    ],
  },
  {
    slug: 'grand-theft-auto',
    name: 'GTA',
    title: 'Мерч GTA',
    h1: 'Мерч GTA: футболки и худи с вышивкой',
    metaDescription: 'Футболки и худи KOMUI по GTA и Grand Theft Auto: лаконичная вышивка, streetwear-посадка и доставка СДЭК по России.',
    aliases: ['grand theft auto', 'gta', 'гта'],
    lead: 'Подборка KOMUI по GTA для тех, кто хочет не кричащий игровой мерч, а вещь с лаконичной вышивкой и повседневной посадкой.',
    copy: [
      'Мерч GTA часто хочется носить не как сувенир, а как нормальную streetwear-вещь: футболку под джинсы, худи под куртку или спокойный верх с узнаваемой, но не слишком громкой деталью. Поэтому в KOMUI подборка GTA строится вокруг лаконичной вышивки и базовых цветов. Такой подход подходит тем, кто ищет футболку GTA, худи Grand Theft Auto или подарок фанату игры, но не хочет огромный принт на всю грудь.',
      'Вышивка визуально тише, чем крупный DTF-принт. Она хорошо смотрится на черной базе, не перегружает образ и остается уместной в повседневной носке. Худи лучше подойдет для прохладного сезона и многослойных образов, футболка — универсальная база на каждый день. Если выбираете между ними, отталкивайтесь от сценария: футболку проще носить круглый год, худи заметнее по силуэту и теплее.',
      'На этой странице товары отфильтрованы по теме GTA, чтобы не смешивать их с аниме-коллекциями. В карточках можно посмотреть цену, фото, доступные размеры и тип нанесения. Для правильного выбора размера сравните замеры с вещью, которая уже хорошо сидит. Заказ оформляется онлайн, доставку можно выбрать через СДЭК по России. При уходе не используйте агрессивный отбеливатель и гладьте вышивку аккуратно с изнаночной стороны.'
    ],
  },
  {
    slug: 'star-wars',
    name: 'Star Wars',
    title: 'Мерч Star Wars',
    h1: 'Мерч Star Wars: футболки с Дартом Вейдером',
    metaDescription: 'Футболки KOMUI по Star Wars и Darth Vader: вышивка, базовые цвета, фанатский streetwear и доставка СДЭК по России.',
    aliases: ['star wars', 'darth', 'vader', 'дарт', 'вейдер'],
    lead: 'Фанатская подборка KOMUI по Star Wars и Darth Vader: акцентная футболка с вышивкой для повседневного образа.',
    copy: [
      'Страница Star Wars в KOMUI создана для точечных запросов вроде футболка Дарт Вейдер, мерч Star Wars или Darth Vader футболка. Вместо перегруженного сувенирного вида здесь акцент сделан на носимую вещь: базовая футболка, узнаваемая вышивка и спокойная посадка, которую можно сочетать с джинсами, карго, худи или курткой. Такой формат подходит и для фанатов саги, и для тех, кто любит поп-культурные детали без лишней яркости.',
      'Вышивка выглядит аккуратнее крупного принта и лучше переносит повседневные сочетания. Она не требует сложной стилизации: достаточно базового низа и нейтральной обуви. Если выбираете подарок, такой вариант обычно безопаснее, чем вещь с огромной иллюстрацией: отсылка считывается, но не превращает весь образ в костюм. Перед покупкой проверьте размер, цвет и фото в карточке товара.',
      'Лендинг показывает только товары, связанные со Star Wars и Darth Vader, поэтому можно быстро перейти к нужной карточке и оформить заказ. Доставка доступна СДЭК по России, пункт выдачи выбирается на этапе оформления. Чтобы вещь дольше сохраняла форму, стирайте ее наизнанку при температуре до 30 градусов, не используйте отбеливатель и не прижимайте утюг напрямую к вышивке.'
    ],
  },
];

function loadFromLocalFile() {
  const src = fs.readFileSync(path.join(ROOT, 'data/storefront-products.js'), 'utf8');
  const sandbox = { window: {} };
  const fn = new Function('window', src);
  fn(sandbox.window);
  return sandbox.window.KOMUI_PRODUCTS || [];
}

function writeStorefrontProductsFallback(products) {
  const fallbackPath = path.join(ROOT, 'data/storefront-products.js');
  const payload = [
    '/* Auto-generated storefront product fallback. */',
    '/* Используется как fallback, если KOMUI API временно недоступен. */',
    `window.KOMUI_PRODUCTS = ${JSON.stringify(products, null, 2)};`,
    '',
  ].join('\n');
  fs.writeFileSync(fallbackPath, payload, 'utf8');
}

function apiBasicAuthHeader() {
  if (process.env.KOMUI_API_BASIC_AUTH) return process.env.KOMUI_API_BASIC_AUTH;
  if (!process.env.KOMUI_API_BASIC_USER || !process.env.KOMUI_API_BASIC_PASSWORD) return '';
  return `Basic ${Buffer.from(`${process.env.KOMUI_API_BASIC_USER}:${process.env.KOMUI_API_BASIC_PASSWORD}`).toString('base64')}`;
}

async function loadFromApi() {
  if (!API_BASE_URL) throw new Error('KOMUI_API_BASE_URL is not set');
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable (need Node >= 18)');
  const url = `${API_BASE_URL}${API_PRODUCTS_PATH.startsWith('/') ? API_PRODUCTS_PATH : `/${API_PRODUCTS_PATH}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const authorization = apiBasicAuthHeader();
    const res = await fetch(url, {
      headers: authorization ? { Authorization: authorization } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('unexpected response shape');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadProducts() {
  let products;
  try {
    products = await loadFromApi();
    console.log(`✓ Loaded ${products.length} product(s) from KOMUI API`);
  } catch (err) {
    console.warn(`! KOMUI API fetch failed (${err.message}); falling back to data/storefront-products.js`);
    products = loadFromLocalFile();
    console.log(`✓ Loaded ${products.length} product(s) from local file`);
  }
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

function productRedirectSlugs(product) {
  if (!Array.isArray(product.slug_redirects)) return [];
  return [...new Set(product.slug_redirects)]
    .map(slug => String(slug || '').trim())
    .filter(slug => slug && slug !== product.slug && /^[a-z0-9][a-z0-9-]*$/i.test(slug));
}

function buildProductRedirects(products) {
  const canonicalSlugs = new Set(products.map(product => product.slug));
  const seen = new Set();
  const redirects = [];

  for (const product of products) {
    for (const oldSlug of productRedirectSlugs(product)) {
      if (canonicalSlugs.has(oldSlug) || seen.has(oldSlug)) continue;
      seen.add(oldSlug);
      redirects.push({ oldSlug, product });
    }
  }

  return redirects;
}

function renderProductRedirectPage(oldSlug, product) {
  const target = `/p/${product.slug}`;
  const canonical = `${SITE_ORIGIN}${target}`;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, follow" />
<meta http-equiv="refresh" content="0; url=${escapeAttr(target)}" />
<link rel="canonical" href="${escapeAttr(canonical)}" />
<title>${escapeHtml(product.name)} — KOMUI</title>
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
<p>Страница товара переехала: <a href="${escapeAttr(target)}">${escapeHtml(product.name)}</a>.</p>
</body>
</html>
`;
}

function renderNginxProductRedirects(redirects) {
  const lines = [
    '# Auto-generated by scripts/build-products.js.',
    '# Redirect old product slugs to canonical SEO URLs.',
  ];

  for (const { oldSlug, product } of redirects) {
    const from = `/p/${oldSlug}`;
    const to = `/p/${product.slug}`;
    lines.push(`location = ${from} { return 301 ${to}; }`);
    lines.push(`location = ${from}/ { return 301 ${to}; }`);
    lines.push(`location = ${from}.html { return 301 ${to}; }`);
  }

  lines.push('');
  return lines.join('\n');
}

function formatPriceRange(min, max) {
  const a = Math.round(Number(min));
  const b = Math.round(Number(max));
  if (!a) return '';
  if (!b || a === b) return `${a.toLocaleString('ru-RU')} ₽`;
  return `${a.toLocaleString('ru-RU')}–${b.toLocaleString('ru-RU')} ₽`;
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

function sizeIndex(size) {
  const index = SIZE_ORDER.indexOf(String(size || '').toUpperCase());
  return index === -1 ? 999 : index;
}

function sortDisplaySizes(sizes) {
  return [...new Set(sizes || [])]
    .sort((a, b) => sizeIndex(a) - sizeIndex(b) || String(a).localeCompare(String(b), 'ru'));
}

function sizeSummary(sizes) {
  const list = sortDisplaySizes(sizes);
  if (!list.length) return null;
  const known = list.map(sizeIndex);
  const contiguous = known.every(index => index !== 999) &&
    known.every((value, index) => !index || value === known[index - 1] + 1);
  const label = contiguous && list.length > 1 ? `${list[0]}-${list[list.length - 1]}` : list.join('/');
  const full = list.join(', ');
  return {
    label,
    aria: `Размеры в наличии: ${full}`,
  };
}

function catalogSizesHtml(sizes) {
  const summary = sizeSummary(sizes);
  if (!summary) return '';
  return `<span class="sizes" aria-label="${escapeAttr(summary.aria)}" title="${escapeAttr(summary.aria)}"><span class="sizes-value">${escapeHtml(summary.label)}</span></span>`;
}

function normalizeSearch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function productSearchText(product) {
  return normalizeSearch([
    product.name,
    product.title_name,
    product.anime_title,
    product.collection_name,
    product.character_name,
    product.design_name,
    product.category,
    product.product_type,
    Array.isArray(product.tags) ? product.tags.join(' ') : '',
  ].filter(Boolean).join(' '));
}

function productMatchesLanding(product, landing) {
  const text = productSearchText(product);
  return landing.aliases.some(alias => text.includes(normalizeSearch(alias)));
}

function buildCollectionLandings(products) {
  return COLLECTION_LANDINGS
    .map(landing => ({
      ...landing,
      products: products.filter(product => productMatchesLanding(product, landing)),
    }))
    .filter(landing => landing.products.length);
}

function renderCollectionFooterLinks() {
  return COLLECTION_LANDINGS
    .map(landing => `<a href="/collections/${escapeAttr(landing.slug)}">${escapeHtml(landing.name)}</a>`)
    .join('');
}

function renderHeaderActions() {
  return `<div class="shop-header-actions" aria-label="Быстрые действия">
      <button class="shop-header-icon shop-search-toggle" type="button" aria-label="Поиск" aria-expanded="false" aria-controls="shopSearchPanel">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
      <a class="shop-header-icon" href="/#cart" aria-label="Корзина">
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
        <span class="shop-cart-count" aria-label="Корзина пуста">0</span>
      </a>
      <button class="shop-header-icon shop-menu-toggle" type="button" aria-label="Меню" aria-expanded="false" aria-controls="shopMenuPanel">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
    </div>`;
}

function renderPromoBar() {
  return `<div class="announce">
  <div class="announce-track">
    <div class="announce-inner">
      <div class="announce-offer"><b>−10% на первый заказ</b></div>
      <div class="announce-code" id="promoCode">KOMUI10</div>
      <div class="announce-timer">сгорит через <span id="promoTimer">--:--:--</span></div>
      <button class="announce-copy" id="promoCopy" type="button">Скопировать</button>
    </div>
    <div class="announce-inner announce-inner-copy" aria-hidden="true">
      <div class="announce-offer"><b>−10% на первый заказ</b></div>
      <div class="announce-code">KOMUI10</div>
      <div class="announce-timer">сгорит через <span data-promo-timer-clone>--:--:--</span></div>
      <span class="announce-copy">Скопировать</span>
    </div>
  </div>
</div>`;
}

function renderHeaderPanels() {
  return `<div class="shop-layer" id="shopLayer" hidden></div>
<aside class="shop-menu-panel" id="shopMenuPanel" hidden aria-label="Меню">
  <div class="shop-panel-head">
    <div><span>Меню</span><strong>KOMUI</strong></div>
    <button type="button" class="shop-panel-close" data-shop-close aria-label="Закрыть">×</button>
  </div>
  <nav class="shop-menu-list">
    <a href="/#catalog">Каталог</a>
    <a href="/#catalog" data-shop-cat="Футболки">Футболки</a>
    <a href="/#catalog" data-shop-cat="Худи">Худи</a>
    <a href="/collections/naruto">Naruto</a>
    <a href="/collections/jujutsu-kaisen">Jujutsu Kaisen</a>
    <a href="/delivery">Доставка и оплата</a>
    <a href="/returns">Возврат и обмен</a>
    <a href="/sizes">Размерная сетка</a>
    <a href="/care">Уход за вещами</a>
  </nav>
</aside>
<section class="shop-search-panel" id="shopSearchPanel" hidden aria-labelledby="shopSearchTitle">
  <div class="shop-panel-head">
    <div><span>Поиск</span><strong id="shopSearchTitle">Найти товар</strong></div>
    <button type="button" class="shop-panel-close" data-shop-close aria-label="Закрыть">×</button>
  </div>
  <div class="shop-search-box">
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="shopSearchInput" type="search" placeholder="Футболка, худи, Naruto, Gojo..." autocomplete="off">
  </div>
  <div class="shop-search-results" id="shopSearchResults" aria-live="polite"></div>
</section>`;
}

function renderHeaderScript() {
  return `<script src="/assets/shop-header.js" defer></script>`;
}

function collectionStats(products) {
  const categories = new Map();
  const techniques = new Map();
  for (const product of products) {
    if (product.category) categories.set(product.category, (categories.get(product.category) || 0) + 1);
    if (product.decoration_type) techniques.set(product.decoration_type, (techniques.get(product.decoration_type) || 0) + 1);
  }
  return { categories, techniques };
}

function pluralRu(count, one, few, many) {
  const n = Math.abs(Number(count)) || 0;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function productCountText(count) {
  return `${count} ${pluralRu(count, 'товар', 'товара', 'товаров')}`;
}

function publicCopy(value) {
  return String(value || '')
    .replace(/Ozon-фото/gi, 'детальными фото')
    .replace(/фото\s+Ozon/gi, 'фото товара')
    .replace(/\bOzon\b/gi, 'маркетплейса')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function shortFrom(product) {
  const s = publicCopy(product.short_description || product.description);
  // Take first ~160 chars on a sentence-ish boundary for meta description.
  const clean = s.replace(/\s+/g, ' ').replace(/[🔹]/g, '').trim();
  if (clean.length <= 160) return clean;
  const cut = clean.slice(0, 157);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + '…';
}

function descriptionHtml(product) {
  const raw = publicCopy(product.description);
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
  return [...new Set(resolvePublicImages(list))];
}

function cleanChartCell(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSizeChartJson(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return value;
}

function firstProductSizeChart(product) {
  const direct = parseSizeChartJson(product.size_chart_json || product.sizeChartJson);
  if (direct) return direct;
  for (const offer of product.offers || []) {
    const chart = parseSizeChartJson(offer.size_chart_json || offer.sizeChartJson);
    if (chart) return chart;
  }
  return null;
}

function chartLabel(cell) {
  if (Array.isArray(cell)) {
    const [label, hint] = cell.map(cleanChartCell);
    if (label === 'RU') return hint || 'Российский';
    if (label === 'INT') return hint || 'Размер';
    return label || hint || '';
  }
  const label = cleanChartCell(cell);
  if (label === 'RU') return 'Российский';
  if (label === 'INT') return 'Размер';
  return label;
}

function isApparelSizeValue(value) {
  return /^(?:XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$/i.test(cleanChartCell(value));
}

function findOzonTcTable(chart) {
  const content = Array.isArray(chart && chart.content) ? chart.content : [];
  const widget = content.find(item => item && item.widgetName === 'tcTable' && item.table);
  return widget ? widget.table : null;
}

function tableFromOzonSizeChart(chart) {
  const table = findOzonTcTable(chart);
  const body = Array.isArray(table && table.body) ? table.body : [];
  const series = body
    .map(row => {
      const data = Array.isArray(row && row.data) ? row.data : [];
      if (data.length < 2) return null;
      return {
        label: chartLabel(data[0]),
        values: data.slice(1).map(cleanChartCell),
      };
    })
    .filter(Boolean);
  if (!series.length) return null;

  const sizeSeries = series.find(item =>
    item.values.some(isApparelSizeValue) && !/россий/i.test(item.label)
  ) || series.find(item =>
    /международ|^int$/i.test(item.label)
  ) || series[0];
  const maxRows = Math.max(...series.map(item => item.values.length));
  const columns = [
    'Размер',
    ...series
      .filter(item => item !== sizeSeries)
      .map(item => item.label || 'Параметр'),
  ];
  const rows = [];
  for (let index = 0; index < maxRows; index += 1) {
    const size = sizeSeries.values[index] || '';
    if (!size) continue;
    rows.push([
      size,
      ...series
        .filter(item => item !== sizeSeries)
        .map(item => item.values[index] || ''),
    ]);
  }
  if (!rows.length) return null;
  return {
    title: cleanChartCell(table.title) || 'Таблица размеров',
    columns,
    rows,
  };
}

function tableFromSimpleSizeChart(chart) {
  const table = chart && (chart.table || chart);
  const columns = Array.isArray(table && table.columns)
    ? table.columns.map(cleanChartCell).filter(Boolean)
    : [];
  const rows = Array.isArray(table && table.rows)
    ? table.rows.map(row => Array.isArray(row) ? row.map(cleanChartCell) : [])
    : [];
  if (!columns.length || !rows.length) return null;
  return {
    title: cleanChartCell(table.title) || 'Таблица размеров',
    columns,
    rows,
  };
}

function buildSizeChartTable(product) {
  const chart = firstProductSizeChart(product);
  if (!chart || typeof chart !== 'object') return null;
  return tableFromOzonSizeChart(chart) || tableFromSimpleSizeChart(chart);
}

function sizeChartHeaderHtml(column) {
  const label = cleanChartCell(column);
  if (label.toLowerCase() === 'российский размер') {
    return '<th class="is-ru-size">Российский<br>размер</th>';
  }
  if (label.toLowerCase() === 'размер указанный на этикетке') {
    return '<th class="is-label-size">Размер<br>указанный<br>на этикетке</th>';
  }
  return `<th>${escapeHtml(label)}</th>`;
}

function renderSizeChart(product) {
  const chart = buildSizeChartTable(product);
  if (!chart) return '';
  const title = chart.title || 'Таблица размеров';
  const columns = chart.columns.map(sizeChartHeaderHtml).join('');
  const rows = chart.rows
    .map(row => `<tr>${chart.columns.map((_, index) => `<td>${escapeHtml(row[index] || '')}</td>`).join('')}</tr>`)
    .join('');
  const itemType = product.product_type || product.category || 'изделия';
  return `<div class="p-size-chart-modal" id="pSizeChartModal" hidden>
    <div class="p-size-chart-dialog" role="dialog" aria-modal="true" aria-labelledby="pSizeChartTitle">
      <div class="p-size-chart-head">
        <div>
          <div class="p-size-chart-kicker">Размерная сетка</div>
          <h2 class="p-size-chart-title" id="pSizeChartTitle">${escapeHtml(title)}</h2>
          <p class="p-size-chart-sub">${escapeHtml(itemType)}: замеры изделия в сантиметрах.</p>
        </div>
        <button type="button" class="p-size-chart-close" id="pSizeChartClose" aria-label="Закрыть таблицу размеров">×</button>
      </div>
      <div class="p-size-chart-body">
        <div class="p-size-chart-scroll">
          <table class="p-size-chart-table">
            <thead><tr>${columns}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="p-size-chart-note">
          <p><strong>Как сверять:</strong> сравните замеры с вещью, которая уже хорошо сидит. Для оверсайз-посадки берите привычный размер или на один больше.</p>
          <p>Допустимое расхождение замеров: 1-2 см.</p>
        </div>
      </div>
    </div>
  </div>`;
}

function visibleOffers(product) {
  return (product.offers || []).filter(o => o && !o.archived && o.visible !== false);
}

function productSku(product) {
  const offerWithId = visibleOffers(product).find(o => o.offer_id);
  if (offerWithId) return String(offerWithId.offer_id);
  const firstOzonOfferId = Array.isArray(product.ozon_offer_ids)
    ? product.ozon_offer_ids.find(Boolean)
    : null;
  return String(firstOzonOfferId || product.slug || product.id || '');
}

function productSchemaPriceValidUntil() {
  return `${new Date().getUTCFullYear() + 1}-12-31`;
}

function productSchemaShippingDetails() {
  return {
    '@type': 'OfferShippingDetails',
    shippingDestination: {
      '@type': 'DefinedRegion',
      addressCountry: 'RU',
    },
    deliveryTime: {
      '@type': 'ShippingDeliveryTime',
      handlingTime: {
        '@type': 'QuantitativeValue',
        minValue: 1,
        maxValue: 3,
        unitCode: 'DAY',
      },
      transitTime: {
        '@type': 'QuantitativeValue',
        minValue: 2,
        maxValue: 10,
        unitCode: 'DAY',
      },
    },
    shippingSettingsLink: `${SITE_ORIGIN}/delivery`,
  };
}

function productSchemaReturnPolicy() {
  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'RU',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 7,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
    merchantReturnLink: `${SITE_ORIGIN}/returns`,
  };
}

function buildJsonLd(product) {
  const images = productImages(product).map(absolutizeUrl);
  const lowPrice = Number(product.price_min);
  const highPrice = Number(product.price_max);
  const priceValidUntil = productSchemaPriceValidUntil();
  const shippingDetails = productSchemaShippingDetails();
  const returnPolicy = productSchemaReturnPolicy();
  const offers = visibleOffers(product)
    .map(o => ({
      '@type': 'Offer',
      sku: String(o.offer_id || o.sku || ''),
      name: o.name || product.name,
      size: o.size || undefined,
      price: Number(o.price || lowPrice),
      priceCurrency: product.currency || 'RUB',
      priceValidUntil,
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      url: `${SITE_ORIGIN}/p/${product.slug}`,
      shippingDetails,
      hasMerchantReturnPolicy: returnPolicy,
    }));
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: product.name,
    description: shortFrom(product),
    image: images,
    sku: productSku(product),
    brand: { '@type': 'Brand', name: 'KOMUI' },
    category: product.category,
    color: product.color_name,
    material: '100% хлопок',
    url: `${SITE_ORIGIN}/p/${product.slug}`,
    datePublished: DATE_PUBLISHED_PLACEHOLDER,
    dateModified: DATE_MODIFIED_PLACEHOLDER,
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
      priceValidUntil,
      availability: 'https://schema.org/InStock',
      url: `${SITE_ORIGIN}/p/${product.slug}`,
      shippingDetails,
      hasMerchantReturnPolicy: returnPolicy,
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

function productRecommendationCard(product) {
  const images = productImages(product);
  const img = images[0] || '';
  const price = formatPriceRange(product.price_min, product.price_max);
  const oldPrice = Number(product.compare_at_price);
  const oldPriceHtml = oldPrice && oldPrice > Number(product.price_min)
    ? `<s class="p-reco-old">${oldPrice.toLocaleString('ru-RU')} ₽</s>`
    : '';
  const collection = product.collection_name || product.anime_title || '';
  const sizes = catalogSizesHtml(product.sizes || []);
  return `<article class="p-reco-card">
    <a class="p-reco-media" href="/p/${escapeAttr(product.slug)}" aria-label="${escapeAttr(product.name)}">
      ${img ? renderResponsiveImage(img, {
        alt: product.name,
        loading: 'lazy',
        sizes: '(max-width: 768px) 45vw, 220px',
      }) : ''}
    </a>
    <div class="p-reco-body">
      ${collection ? `<div class="p-reco-col">${escapeHtml(collection)}</div>` : ''}
      <h3><a href="/p/${escapeAttr(product.slug)}">${escapeHtml(product.name)}</a></h3>
      <div class="p-reco-meta">
        ${price ? `<span class="p-reco-price">${escapeHtml(price)}${oldPriceHtml}</span>` : ''}
        ${sizes}
      </div>
    </div>
  </article>`;
}

function productRecommendations(product, products) {
  const candidates = (products || [])
    .filter(p => p && p.slug && p.slug !== product.slug)
    .map(p => {
      let score = 0;
      if (p.collection_name && p.collection_name === product.collection_name) score += 8;
      if (p.anime_title && p.anime_title === product.anime_title) score += 6;
      if (p.category && p.category === product.category) score += 3;
      if (p.decoration_type && p.decoration_type === product.decoration_type) score += 1;
      return { product: p, score };
    })
    .sort((a, b) => b.score - a.score || String(a.product.name).localeCompare(String(b.product.name), 'ru'))
    .slice(0, 10)
    .map(item => item.product);
  if (!candidates.length) return '';
  return `<section class="p-reco" aria-labelledby="pRecoTitle">
    <div class="p-reco-head">
      <div>
        <div class="p-reco-kicker">Еще можно посмотреть</div>
        <h2 id="pRecoTitle">Рекомендации</h2>
      </div>
      <a href="/#catalog">В каталог</a>
    </div>
    <div class="p-reco-strip" aria-label="Рекомендованные товары">
      ${candidates.map(productRecommendationCard).join('')}
    </div>
  </section>`;
}

function renderProductPage(product, products = []) {
  const images = productImages(product);
  const heroImage = images[0] || '';
  const galleryThumbs = images.slice(0, 8);
  const priceText = formatPriceRange(product.price_min, product.price_max);
  const oldPrice = Number(product.compare_at_price);
  const oldPriceHtml = oldPrice && oldPrice > Number(product.price_min)
    ? `<span class="p-price-old">${oldPrice.toLocaleString('ru-RU')} ₽</span>`
    : '';
  const title = buildTitle(product);
  const description = shortFrom(product);
  const canonical = `${SITE_ORIGIN}/p/${product.slug}`;
  const ogImage = heroImage ? absolutizeUrl(heroImage) : `${SITE_ORIGIN}/assets/og-image.png`;
  const sizeButtons = product.sizes
    .map((s, i) => `<button type="button" class="p-size${i === 0 ? ' is-active' : ''}" data-size="${escapeAttr(s)}">${escapeHtml(s)}</button>`)
    .join('');
  const sizeChartHtml = renderSizeChart(product);
  const sizeChartButtonHtml = sizeChartHtml
    ? '\n              <button type="button" class="p-size-chart-btn" id="pSizeChartOpen">Таблица размеров</button>'
    : '';
  const sizeChartModalHtml = sizeChartHtml ? `\n  ${sizeChartHtml}` : '';
  const galleryHtml = images.length
    ? `<div class="p-gallery" data-p-gallery>
        <div class="p-hero">
          <div class="p-track" id="pTrack">
            ${images.map((u, i) => renderResponsiveImage(u, {
              className: 'p-slide',
              alt: `${product.name} — фото ${i + 1}`,
              loading: i === 0 ? 'eager' : 'lazy',
              fetchpriority: i === 0 ? 'high' : '',
              sizes: '(max-width: 900px) 100vw, 680px',
              draggable: false,
            })).join('')}
          </div>
          ${images.length > 1 ? `<button type="button" class="p-garr p-prev" id="pPrev" aria-label="Предыдущее фото"><span aria-hidden="true">‹</span></button>
          <button type="button" class="p-garr p-next" id="pNext" aria-label="Следующее фото"><span aria-hidden="true">›</span></button>
          <div class="p-gdots" aria-label="Фотографии товара">
            ${images.map((_, i) => `<button type="button" class="p-gdot${i === 0 ? ' is-active' : ''}" data-go="${i}" aria-label="Фото ${i + 1}"></button>`).join('')}
          </div>` : ''}
        </div>
        ${galleryThumbs.length > 1 ? `<div class="p-thumbs">${galleryThumbs.map((u, i) => `<button type="button" class="p-thumb${i === 0 ? ' is-active' : ''}" data-go="${i}" aria-label="Показать фото ${i + 1}">${renderResponsiveImage(u, {
          alt: `${product.name} — миниатюра ${i + 1}`,
          loading: 'lazy',
          variant: 'thumb',
          sizes: '96px',
        })}</button>`).join('')}</div>` : ''}
       </div>`
    : '';
  const recommendationsHtml = productRecommendations(product, products);
  const lead = publicCopy(product.short_description);
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
<link rel="stylesheet" href="/assets/fonts/komui-fonts.css">
<link rel="stylesheet" href="/legal.css" />
<link rel="stylesheet" href="/assets/product.css" />
<script type="application/ld+json">${buildJsonLd(product)}</script>
<script type="application/ld+json">${buildBreadcrumbLd(product)}</script>
</head>
<body>
${renderPromoBar()}
<header class="site-header">
  <div class="wrap nav">
    <a class="brand" href="/">KOMUI<span class="dot">.</span></a>
    ${renderHeaderActions()}
  </div>
</header>
${renderHeaderPanels()}
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
          ${lead ? `<p class="p-lead">${escapeHtml(lead)}</p>` : ''}
          <div class="p-price-row">
            <span class="p-price">${escapeHtml(priceText)}</span>
            ${oldPriceHtml}
          </div>
          <div class="p-meta">
            ${product.color_name ? `<div><span>Цвет</span><strong>${escapeHtml(product.color_name)}</strong></div>` : ''}
            ${product.decoration_type ? `<div><span>Оформление</span><strong>${escapeHtml(product.decoration_type)}</strong></div>` : ''}
            <div><span>Плотность</span><strong>240 г/м²</strong></div>
            <div><span>Состав</span><strong>100% хлопок</strong></div>
          </div>
          <div class="p-sizes-wrap">
            <div class="p-size-head">
              <div class="p-label">Размер</div>${sizeChartButtonHtml}
            </div>
            <div class="p-sizes" id="pSizes">${sizeButtons}</div>
          </div>
          <div class="p-actions">
            <button type="button" class="p-cta" id="pAdd" data-id="${escapeAttr(product.id)}">Добавить в корзину</button>
            <button type="button" class="p-cta p-cta-float" id="pAddFloat" data-id="${escapeAttr(product.id)}">Добавить в корзину</button>
            <a class="p-secondary" href="/#catalog">К другим товарам</a>
          </div>
        </div>
      </div>
      ${recommendationsHtml}
      ${product.description ? `<section class="p-desc"><h2>Описание</h2>${descriptionHtml(product)}</section>` : ''}
    </div>
  </section>
${sizeChartModalHtml}
</main>
<script src="/data/storefront-products.js" defer></script>
${renderHeaderScript()}
<footer><div class="wrap foot">
  <div><h5>KOMUI</h5><p>Аниме-мерч: футболки, худи и свитшоты с принтами и вышивкой.</p></div>
  <div><h5>Покупателю</h5><a href="/delivery">Доставка и оплата</a><a href="/returns">Возврат и обмен</a><a href="/sizes">Размерная сетка</a><a href="/care">Уход</a></div>
  <div><h5>Коллекции</h5>${renderCollectionFooterLinks()}</div>
  <div><h5>Документы</h5><a href="/seller">Продавец</a><a href="/offer">Публичная оферта</a><a href="/privacy">Политика ПДн</a></div>
  <div><h5>Контакты</h5><a href="mailto:smmshit@ya.ru">smmshit@ya.ru</a><a href="/#catalog">Каталог</a></div>
  ${renderUpdatedFooterPlaceholder()}
</div></footer>
<script>
(function(){
  var CART_KEY = 'komui-cart-v1';
  var sizes = document.getElementById('pSizes');
  var add = document.getElementById('pAdd');
  var addFloat = document.getElementById('pAddFloat');
  var chartOpen = document.getElementById('pSizeChartOpen');
  var chartModal = document.getElementById('pSizeChartModal');
  var chartClose = document.getElementById('pSizeChartClose');
  var lastChartFocus = null;
  function openSizeChart(){
    if (!chartModal) return;
    lastChartFocus = document.activeElement;
    chartModal.hidden = false;
    document.body.classList.add('has-size-chart');
    if (chartClose) chartClose.focus();
  }
  function closeSizeChart(){
    if (!chartModal) return;
    chartModal.hidden = true;
    document.body.classList.remove('has-size-chart');
    if (lastChartFocus && lastChartFocus.focus) lastChartFocus.focus();
  }
  if (chartOpen) chartOpen.addEventListener('click', openSizeChart);
  if (chartClose) chartClose.addEventListener('click', closeSizeChart);
  if (chartModal) {
    chartModal.addEventListener('click', function(e){
      if (e.target === chartModal) closeSizeChart();
    });
  }
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && chartModal && !chartModal.hidden) closeSizeChart();
  });
  if (sizes) {
    sizes.addEventListener('click', function(e){
      var btn = e.target.closest('.p-size');
      if (!btn) return;
      sizes.querySelectorAll('.p-size').forEach(function(b){ b.classList.remove('is-active'); });
      btn.classList.add('is-active');
    });
  }
  var gallery = document.querySelector('[data-p-gallery]');
  var autoplay = null;
  function initGallery(){
    if (!gallery) return;
    var track = document.getElementById('pTrack');
    if (!track || track.children.length < 2) return;
    var dots = Array.prototype.slice.call(gallery.querySelectorAll('.p-gdot'));
    var thumbs = Array.prototype.slice.call(gallery.querySelectorAll('.p-thumb'));
    var prev = document.getElementById('pPrev');
    var next = document.getElementById('pNext');
    var count = track.children.length;
    var index = 0;
    var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function go(nextIndex){
      index = (nextIndex % count + count) % count;
      track.style.transform = 'translateX(' + (-index * 100) + '%)';
      dots.forEach(function(dot, i){ dot.classList.toggle('is-active', i === index); });
      thumbs.forEach(function(thumb, i){ thumb.classList.toggle('is-active', i === index); });
    }
    function step(dir){ go(index + dir); }
    function stop(){
      if (autoplay) {
        clearInterval(autoplay);
        autoplay = null;
      }
    }
    function start(){
      if (prefersReduced || autoplay) return;
      autoplay = setInterval(function(){ step(1); }, 3800);
    }
    if (prev) prev.addEventListener('click', function(){ stop(); step(-1); });
    if (next) next.addEventListener('click', function(){ stop(); step(1); });
    dots.forEach(function(dot){
      dot.addEventListener('click', function(){ stop(); go(Number(dot.getAttribute('data-go')) || 0); });
    });
    thumbs.forEach(function(thumb){
      thumb.addEventListener('click', function(){ stop(); go(Number(thumb.getAttribute('data-go')) || 0); });
    });
    var startX = 0;
    var startY = 0;
    var dx = 0;
    var startIndex = 0;
    var dragging = false;
    var locked = false;
    function finishSwipe(){
      if (!dragging) return;
      dragging = false;
      track.style.transition = '';
      if (locked && Math.abs(dx) > Math.min(90, gallery.clientWidth * .18)) {
        step(dx < 0 ? 1 : -1);
      } else {
        go(startIndex);
      }
    }
    gallery.addEventListener('pointerdown', function(e){
      stop();
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.p-garr,.p-gdot,.p-thumb')) return;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      startIndex = index;
      dragging = true;
      locked = false;
      track.style.transition = 'none';
      if (gallery.setPointerCapture) gallery.setPointerCapture(e.pointerId);
    });
    gallery.addEventListener('pointermove', function(e){
      if (!dragging) return;
      dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!locked && Math.abs(dx) + Math.abs(dy) > 10) locked = Math.abs(dx) > Math.abs(dy);
      if (!locked) return;
      e.preventDefault();
      track.style.transform = 'translateX(calc(' + (-startIndex * 100) + '% + ' + dx + 'px))';
    }, { passive: false });
    gallery.addEventListener('pointerup', finishSwipe);
    gallery.addEventListener('pointercancel', finishSwipe);
    gallery.addEventListener('lostpointercapture', finishSwipe);
    gallery.addEventListener('mouseenter', stop, { once: true });
    go(0);
    start();
  }
  initGallery();
  var addedToCart = false;
  function goToCart(){ location.href = '/#cart'; }
  function handleAdd(){
      if (addedToCart) {
        goToCart();
        return;
      }
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
      document.dispatchEvent(new CustomEvent('komui:cart-updated'));
      add.textContent = 'Добавлено · перейти в корзину';
      if (addFloat) addFloat.textContent = 'Добавлено · перейти в корзину';
      add.classList.add('is-added');
      if (addFloat) addFloat.classList.add('is-added');
      addedToCart = true;
  }
  if (add) {
    add.addEventListener('click', handleAdd);
    if (addFloat) addFloat.addEventListener('click', handleAdd);
    if ('IntersectionObserver' in window && addFloat) {
      var addObserver = new IntersectionObserver(function(entries){
        var entry = entries[0];
        if (!entry) return;
        document.body.classList.toggle('has-p-cta-float', !entry.isIntersecting && entry.boundingClientRect.top < 0);
      }, { threshold: 0.05 });
      addObserver.observe(add);
    }
  }
})();
</script>
</body>
</html>
`;
}

function collectionProductCard(product) {
  const images = productImages(product);
  const img = images[0] || '';
  const price = formatPriceRange(product.price_min, product.price_max);
  const details = [product.category, product.decoration_type, product.color_name].filter(Boolean).join(' · ');
  const badges = [product.collection_name, product.character_name]
    .filter(Boolean)
    .filter((value, index, arr) => arr.findIndex(v => v.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, 2)
    .map(value => `<span>${escapeHtml(value)}</span>`)
    .join('');
  return `<article class="c-card">
    <a class="c-card-media" href="/p/${escapeAttr(product.slug)}" aria-label="${escapeAttr(product.name)}">
      ${img ? renderResponsiveImage(img, {
        alt: product.name,
        loading: 'lazy',
        sizes: '(max-width: 768px) 50vw, 280px',
      }) : ''}
    </a>
    <div class="c-card-body">
      ${badges ? `<div class="c-card-badges">${badges}</div>` : ''}
      <h3><a href="/p/${escapeAttr(product.slug)}">${escapeHtml(product.name)}</a></h3>
      ${details ? `<p>${escapeHtml(details)}</p>` : ''}
      <div class="c-card-bottom">
        ${price ? `<strong>${escapeHtml(price)}</strong>` : '<strong>Цена в карточке</strong>'}
        <a href="/p/${escapeAttr(product.slug)}">Смотреть</a>
      </div>
    </div>
  </article>`;
}

function mapNames(map) {
  return [...map.keys()].filter(Boolean);
}

function joinedList(values, fallback) {
  const list = values.filter(Boolean);
  if (!list.length) return fallback;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} и ${list[list.length - 1]}`;
}

function collectionSeoSections(landing, stats) {
  const count = productCountText(landing.products.length);
  const categories = joinedList(mapNames(stats.categories).map(value => value.toLowerCase()), 'футболки, худи и свитшоты');
  const techniques = joinedList(mapNames(stats.techniques).map(value => value.toLowerCase()), 'принт и вышивка');
  const colors = joinedList([...new Set(landing.products.map(product => product.color_name).filter(Boolean))], 'базовые цвета');

  return [
    {
      title: `Какие вещи входят в подборку ${landing.name}`,
      body: `В коллекции сейчас ${count}: ${categories}. Модели различаются по цвету (${colors}), посадке и технике нанесения — ${techniques}. Каждая карточка ведет на отдельную страницу с фотографиями, размерами, ценой и условиями заказа.`,
    },
    {
      title: `Как выбрать ${landing.name} под свой стиль`,
      body: `Для более заметного образа обычно лучше работают крупный принт, вареная ткань и контрастные цвета. Для спокойной повседневной носки выбирайте вышивку, черную или белую базу и привычную посадку. Перед оплатой сравните размерную сетку с вещью, которая уже хорошо сидит.`,
    },
  ];
}

function collectionFaq(landing, stats) {
  const count = productCountText(landing.products.length);
  const categories = joinedList(mapNames(stats.categories).map(value => value.toLowerCase()), 'футболки, худи и свитшоты');
  const techniques = joinedList(mapNames(stats.techniques).map(value => value.toLowerCase()), 'принт и вышивка');

  return [
    {
      question: `Что есть в коллекции ${landing.name}?`,
      answer: `В подборке ${landing.name} сейчас ${count}: ${categories}. В карточках можно сравнить доступные размеры, цвета, цены, фотографии и тип нанесения.`,
    },
    {
      question: `Что выбрать: принт или вышивку ${landing.name}?`,
      answer: `Принт заметнее и лучше подходит для акцентного образа. Вышивка выглядит спокойнее, проще сочетается с базовой одеждой и хорошо подходит для ежедневной носки.`,
    },
    {
      question: `Как доставляются товары ${landing.name}?`,
      answer: `Заказ оформляется онлайн, пункт выдачи выбирается в чекауте. Доставка выполняется СДЭК по России, а итоговая стоимость рассчитывается до оплаты.`,
    },
  ];
}

function buildCollectionFaqLd(landing, stats) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: collectionFaq(landing, stats).map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  });
}

function buildCollectionPageLd(landing) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: landing.h1,
    description: landing.metaDescription,
    url: `${SITE_ORIGIN}/collections/${landing.slug}`,
    inLanguage: 'ru-RU',
    datePublished: DATE_PUBLISHED_PLACEHOLDER,
    dateModified: DATE_MODIFIED_PLACEHOLDER,
    about: landing.name,
    mainEntity: {
      '@type': 'ItemList',
      name: landing.title,
      itemListElement: landing.products.map((product, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: product.name,
        url: `${SITE_ORIGIN}/p/${product.slug}`,
      })),
    },
  });
}

function buildCollectionBreadcrumbLd(landing) {
  return JSON.stringify({
    '@context': 'https://schema.org/',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'KOMUI', item: SITE_ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: 'Коллекции', item: SITE_ORIGIN + '/#strip' },
      { '@type': 'ListItem', position: 3, name: landing.name, item: `${SITE_ORIGIN}/collections/${landing.slug}` },
    ],
  });
}

function renderCollectionPage(landing) {
  const canonical = `${SITE_ORIGIN}/collections/${landing.slug}`;
  const stats = collectionStats(landing.products);
  const categories = [...stats.categories.entries()]
    .map(([name, count]) => `<span>${escapeHtml(name)} · ${count}</span>`)
    .join('');
  const techniques = [...stats.techniques.entries()]
    .map(([name, count]) => `<span>${escapeHtml(name)} · ${count}</span>`)
    .join('');
  const cards = landing.products.map(collectionProductCard).join('');
  const related = COLLECTION_LANDINGS
    .filter(item => item.slug !== landing.slug)
    .map(item => `<a href="/collections/${escapeAttr(item.slug)}">${escapeHtml(item.name)}</a>`)
    .join('');
  const introCopy = landing.copy.map(text => `<p>${escapeHtml(text)}</p>`).join('');
  const seoSections = collectionSeoSections(landing, stats)
    .map(section => `<section class="c-copy-question">
          <h3>${escapeHtml(section.title)}</h3>
          <p>${escapeHtml(section.body)}</p>
        </section>`)
    .join('');
  const faq = collectionFaq(landing, stats);
  const faqHtml = faq
    .map(item => `<section class="c-faq-item">
        <h3>${escapeHtml(item.question)}</h3>
        <p>${escapeHtml(item.answer)}</p>
      </section>`)
    .join('');
  const title = `${landing.title} — KOMUI`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttr(landing.metaDescription)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:site_name" content="KOMUI" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeAttr(title)}" />
<meta property="og:description" content="${escapeAttr(landing.metaDescription)}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:image" content="${SITE_ORIGIN}/assets/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeAttr(title)}" />
<meta name="twitter:description" content="${escapeAttr(landing.metaDescription)}" />
<meta name="twitter:image" content="${SITE_ORIGIN}/assets/og-image.png" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/assets/fonts/komui-fonts.css">
<link rel="stylesheet" href="/legal.css" />
<link rel="stylesheet" href="/assets/product.css" />
<script type="application/ld+json">${buildCollectionPageLd(landing)}</script>
<script type="application/ld+json">${buildCollectionBreadcrumbLd(landing)}</script>
<script type="application/ld+json">${buildCollectionFaqLd(landing, stats)}</script>
</head>
<body>
${renderPromoBar()}
<header class="site-header">
  <div class="wrap nav">
    <a class="brand" href="/">KOMUI<span class="dot">.</span></a>
    ${renderHeaderActions()}
  </div>
</header>
${renderHeaderPanels()}
<main class="c-page">
  <section class="c-hero">
    <div class="wrap">
      <nav class="crumb" aria-label="Хлебные крошки"><a href="/">KOMUI</a><span>/</span><a href="/#strip">Коллекции</a><span>/</span><span>${escapeHtml(landing.name)}</span></nav>
      <div class="eyebrow">Коллекция</div>
      <h1>${escapeHtml(landing.h1)}</h1>
      <p class="lead">${escapeHtml(landing.lead)}</p>
      <div class="c-actions">
        <a class="btn btn-primary" href="#products">Смотреть товары</a>
        <a class="btn btn-ghost" href="/delivery">Доставка СДЭК</a>
      </div>
    </div>
  </section>
  <section class="c-main" id="products">
    <div class="wrap">
      <div class="c-head">
        <div>
          <div class="eyebrow">Фильтр по теме</div>
          <h2>${escapeHtml(landing.name)}: товары в наличии</h2>
          <p>На странице показаны товары KOMUI, отобранные по теме ${escapeHtml(landing.name)}. Можно сравнить принты, вышивку, цвета, категории и перейти в карточку нужной вещи.</p>
        </div>
        <div class="c-count">${landing.products.length}</div>
      </div>
      <div class="c-chips"><span class="is-active">${escapeHtml(landing.name)}</span>${categories}${techniques}</div>
      <div class="c-grid">${cards}</div>
    </div>
  </section>
  <section class="c-copy">
    <div class="wrap c-copy-grid">
      <div>
        <div class="eyebrow">Как выбрать</div>
        <h2>${escapeHtml(landing.title)} от KOMUI</h2>
      </div>
      <div class="c-copy-text">${introCopy}${seoSections}</div>
    </div>
  </section>
  <section class="c-faq">
    <div class="wrap">
      <div class="eyebrow">Вопросы по коллекции</div>
      <h2>${escapeHtml(landing.name)}: коротко перед заказом</h2>
      <div class="c-faq-list">${faqHtml}</div>
    </div>
  </section>
  <section class="c-related">
    <div class="wrap">
      <h2>Другие коллекции</h2>
      <div class="c-related-links">${related}</div>
    </div>
  </section>
</main>
<script src="/data/storefront-products.js" defer></script>
${renderHeaderScript()}
<footer><div class="wrap foot">
  <div><h5>KOMUI</h5><p>Аниме-мерч: футболки, худи и свитшоты с принтами и вышивкой.</p></div>
  <div><h5>Покупателю</h5><a href="/delivery">Доставка и оплата</a><a href="/returns">Возврат и обмен</a><a href="/sizes">Размерная сетка</a><a href="/care">Уход</a></div>
  <div><h5>Коллекции</h5>${renderCollectionFooterLinks()}</div>
  <div><h5>Документы</h5><a href="/seller">Продавец</a><a href="/offer">Публичная оферта</a><a href="/privacy">Политика ПДн</a></div>
  <div><h5>Контакты</h5><a href="mailto:smmshit@ya.ru">smmshit@ya.ru</a><a href="/#catalog">Каталог</a></div>
  ${renderUpdatedFooterPlaceholder()}
</div></footer>
</body>
</html>
`;
}

function renderSitemap(products, collectionLandings = [], tracker) {
  const urls = [
    ...STATIC_PAGES.map(p => ({
      loc: SITE_ORIGIN + p.url,
      lastmod: tracker.sitemapDate(p.url),
      changefreq: p.changefreq,
      priority: p.priority,
    })),
    { loc: `${SITE_ORIGIN}/llms.txt`, lastmod: tracker.sitemapDate('/llms.txt'), changefreq: 'weekly', priority: '0.3' },
    { loc: `${SITE_ORIGIN}/llms-full.txt`, lastmod: tracker.sitemapDate('/llms-full.txt'), changefreq: 'weekly', priority: '0.3' },
    ...collectionLandings.map(landing => ({
      loc: `${SITE_ORIGIN}/collections/${landing.slug}`,
      lastmod: tracker.sitemapDate(`/collections/${landing.slug}`),
      changefreq: 'weekly',
      priority: '0.75',
    })),
    ...products.map(p => ({
      loc: `${SITE_ORIGIN}/p/${p.slug}`,
      lastmod: tracker.sitemapDate(`/p/${p.slug}`),
      changefreq: 'weekly',
      priority: '0.8',
    })),
  ];
  const body = urls
    .map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function renderCatalogPrerender(products, limit = 12) {
  // Lightweight card stubs injected into index.html#grid between markers.
  // The live JS catalog overwrites #grid.innerHTML once KOMUI API data loads,
  // so these stubs are visible only during the brief moment before hydration.
  // Their primary purpose: give crawlers (Yandex/Google/GPTBot/PerplexityBot)
  // a real HTML list of products with descriptive text and direct links.
  const items = products.slice(0, limit).map(p => {
    const img = productImages(p)[0] || '';
    const price = formatPriceRange(p.price_min, p.price_max) || '';
    const oldPrice = Number(p.compare_at_price);
    const oldPriceHtml = oldPrice && oldPrice > Number(p.price_min)
      ? `<s class="price-old">${oldPrice.toLocaleString('ru-RU')} ₽</s>`
      : '';
    const sizes = catalogSizesHtml(p.sizes || []);
    const collection = p.collection_name || p.anime_title || '';
    const altParts = [p.color_name, p.category, p.decoration_type ? `с ${p.decoration_type.toLowerCase()}ом` : '', p.collection_name && `«${p.collection_name}»`].filter(Boolean);
    const alt = altParts.length ? altParts.join(' ') : p.name;
    return `<article class="card prerender" data-id="${escapeAttr(p.id)}">` +
      `<a class="media" href="/p/${escapeAttr(p.slug)}" aria-label="${escapeAttr(p.name)}">` +
        (img ? renderResponsiveImage(img, {
          alt,
          loading: 'lazy',
          sizes: '(max-width: 768px) 50vw, 320px',
        }) : '') +
      `</a>` +
      `<div class="info">` +
        (collection ? `<div class="col">${escapeHtml(collection)}</div>` : '') +
        `<h3><a href="/p/${escapeAttr(p.slug)}">${escapeHtml(p.name)}</a></h3>` +
        `<div class="meta">` +
          (price ? `<span class="price">${escapeHtml(price)}${oldPriceHtml}</span>` : '') +
          sizes +
        `</div>` +
      `</div>` +
    `</article>`;
  }).join('');
  return items;
}

function injectCatalogPrerender(html, prerender) {
  const startMark = '<!--catalog:prerender:start-->';
  const endMark = '<!--catalog:prerender:end-->';
  const startIdx = html.indexOf(startMark);
  const endIdx = html.indexOf(endMark);
  if (startIdx === -1 || endIdx === -1) return null;
  return (
    html.slice(0, startIdx + startMark.length) +
    prerender +
    html.slice(endIdx)
  );
}

function stripGeneratedPageMeta(html) {
  return String(html)
    .replace(/\n?<!--komui:dates:start-->[\s\S]*?<!--komui:dates:end-->/g, '')
    .replace(/\n?<!--komui:updated:start-->[\s\S]*?<!--komui:updated:end-->/g, '');
}

function injectStaticPageMeta(html, meta) {
  const clean = stripGeneratedPageMeta(html);
  const headMeta = `<!--komui:dates:start-->
<meta name="datePublished" content="${escapeAttr(meta.datePublished)}" />
<meta name="dateModified" content="${escapeAttr(meta.dateModified)}" />
<!--komui:dates:end-->`;
  const updated = `<!--komui:updated:start-->
${renderUpdatedBadge(meta, 'footer-updated static-updated')}
<!--komui:updated:end-->`;
  let patched = clean.includes('</head>')
    ? clean.replace('</head>', `${headMeta}\n</head>`)
    : clean;
  if (patched.includes('</footer>')) {
    patched = patched.replace('</footer>', `${updated}\n</footer>`);
  } else {
    patched = patched.replace('</main>', `${updated}\n</main>`);
  }
  return patched;
}

function updateStaticPagesWithDates(tracker) {
  for (const page of STATIC_PAGES) {
    const filePath = path.join(ROOT, page.file);
    if (!fs.existsSync(filePath)) continue;
    const clean = stripGeneratedPageMeta(fs.readFileSync(filePath, 'utf8'));
    const meta = tracker.track(page.url, clean, gitDateForPath(page.file));
    fs.writeFileSync(filePath, injectStaticPageMeta(clean, meta), 'utf8');
  }
}

function findIndexNowKeyFile() {
  if (INDEXNOW_KEY_FILE) return path.resolve(ROOT, INDEXNOW_KEY_FILE);
  const candidates = fs.readdirSync(ROOT)
    .filter(file => /^[A-Za-z0-9-]{8,128}\.txt$/.test(file))
    .map(file => path.join(ROOT, file))
    .filter(file => {
      try {
        const key = path.basename(file, '.txt');
        return fs.readFileSync(file, 'utf8').trim() === key;
      } catch {
        return false;
      }
    });
  return candidates[0] || '';
}

function indexNowConfig() {
  const keyFile = findIndexNowKeyFile();
  if (!keyFile) return null;
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  const fileName = path.basename(keyFile);
  return {
    key,
    keyLocation: `${SITE_ORIGIN}/${fileName}`,
  };
}

function sitemapUrls() {
  const sitemapPath = path.join(ROOT, 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return [];
  const xml = fs.readFileSync(sitemapPath, 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(match => match[1])
    .filter(url => url.startsWith(`${SITE_ORIGIN}/`));
}

async function pingIndexNow(urls) {
  if (!INDEXNOW_ENABLED) {
    console.log('! IndexNow ping skipped: KOMUI_INDEXNOW_PING is not 1');
    return;
  }
  const config = indexNowConfig();
  if (!config) {
    console.warn('! IndexNow ping skipped: key file not found');
    return;
  }
  if (!urls.length) {
    console.warn('! IndexNow ping skipped: no URLs');
    return;
  }
  if (typeof fetch !== 'function') {
    console.warn('! IndexNow ping skipped: global fetch unavailable');
    return;
  }

  const payload = {
    host: new URL(SITE_ORIGIN).hostname,
    key: config.key,
    keyLocation: config.keyLocation,
    urlList: urls.slice(0, 10000),
  };

  try {
    const response = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (!response.ok && response.status !== 202) {
      const body = await response.text().catch(() => '');
      console.warn(`! IndexNow ping returned HTTP ${response.status}: ${body.slice(0, 500)}`);
      return;
    }
    console.log(`✓ IndexNow ping accepted (${response.status}) for ${payload.urlList.length} URL(s)`);
  } catch (err) {
    console.warn(`! IndexNow ping failed: ${err.message}`);
  }
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

# AI discovery files (llmstxt.org convention):
# llms: ${SITE_ORIGIN}/llms.txt
# llms-full: ${SITE_ORIGIN}/llms-full.txt
`;
}

function renderLlmsFull(products) {
  const groups = new Map();
  for (const p of products) {
    const key = p.anime_title || p.collection_name || 'Другие коллекции';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const lines = [
    '# KOMUI — полный каталог для AI-систем',
    '',
    `> Все товары интернет-магазина KOMUI (https://komui.ru) с актуальными ценами, размерами, цветами и типом нанесения. Обновлено: ${DATE_MODIFIED_PLACEHOLDER}. Краткая версия: https://komui.ru/llms.txt`,
    '',
  ];

  for (const [group, items] of groups) {
    lines.push(`## ${group} (${items.length} тов.)`);
    lines.push('');
    for (const p of items) {
      const facts = [
        formatPriceRange(p.price_min, p.price_max),
        p.decoration_type ? `нанесение: ${p.decoration_type.toLowerCase()}` : '',
        p.color_name ? `цвет: ${p.color_name.toLowerCase()}` : '',
        (p.sizes || []).length ? `размеры: ${p.sizes.join(', ')}` : '',
        p.category ? `категория: ${p.category.toLowerCase()}` : '',
        p.character_name ? `персонаж: ${p.character_name}` : '',
      ].filter(Boolean).join('; ');
      lines.push(`- [${p.name}](${SITE_ORIGIN}/p/${p.slug}): ${facts}`);
    }
    lines.push('');
  }

  lines.push('## Покупателям');
  lines.push('');
  lines.push(`- [Доставка и оплата](${SITE_ORIGIN}/delivery): доставка СДЭК до пункта выдачи по России, стоимость рассчитывается в чекауте до оплаты`);
  lines.push(`- [Возврат и обмен](${SITE_ORIGIN}/returns): условия возврата и обмена товара при дистанционной покупке`);
  lines.push(`- [Размеры](${SITE_ORIGIN}/sizes): таблицы замеров изделий в сантиметрах и советы по выбору размера`);
  lines.push(`- [Уход за вещами](${SITE_ORIGIN}/care): стирка наизнанку до 30 °C, без отбеливателя и прямого утюга по рисунку`);
  lines.push(`- [О продавце](${SITE_ORIGIN}/seller): реквизиты ИП Кадимагомедов М. А., ИНН 053602598018`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const sourceProducts = await loadProducts();
  if (!sourceProducts.length) {
    console.error('No products found in data/storefront-products.js');
    process.exit(1);
  }
  if (MEDIA_MANIFEST.loaded) {
    console.log(`✓ Loaded media manifest: ${MEDIA_MANIFEST.path} (${MEDIA_MANIFEST.bySource.size} source image(s))`);
  } else if (MEDIA_STRICT) {
    throw new Error(`KOMUI_MEDIA_STRICT=1 but media manifest was not found: ${MEDIA_MANIFEST.path}`);
  } else {
    console.warn(`! Media manifest not found: ${MEDIA_MANIFEST.path}; image URLs will be left as-is`);
  }

  const tracker = createPageMetaTracker();
  const products = sourceProducts.map(mapProductMedia);
  writeStorefrontProductsFallback(products);
  const collectionLandings = buildCollectionLandings(products);
  const productRedirects = buildProductRedirects(products);
  const productFallbackDate = maxDate(
    gitDateForPath('data/storefront-products.js'),
    gitDateForPath('scripts/build-products.js'),
  );

  const outDir = path.join(ROOT, 'p');
  fs.mkdirSync(outDir, { recursive: true });

  // Wipe stale .html files in /p (slugs may have changed).
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith('.html')) fs.unlinkSync(path.join(outDir, file));
  }

  let written = 0;
  for (const product of products) {
    const htmlWithPlaceholders = renderProductPage(product, products);
    const meta = tracker.track(`/p/${product.slug}`, htmlWithPlaceholders, productFallbackDate);
    const html = replaceDatePlaceholders(htmlWithPlaceholders, meta);
    fs.writeFileSync(path.join(outDir, `${product.slug}.html`), html, 'utf8');
    written += 1;
  }
  for (const { oldSlug, product } of productRedirects) {
    fs.writeFileSync(
      path.join(outDir, `${oldSlug}.html`),
      renderProductRedirectPage(oldSlug, product),
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(ROOT, 'nginx-product-redirects.conf'),
    renderNginxProductRedirects(productRedirects),
    'utf8',
  );

  const collectionDir = path.join(ROOT, 'collections');
  fs.mkdirSync(collectionDir, { recursive: true });
  for (const file of fs.readdirSync(collectionDir)) {
    if (file.endsWith('.html')) fs.unlinkSync(path.join(collectionDir, file));
  }
  for (const landing of collectionLandings) {
    const htmlWithPlaceholders = renderCollectionPage(landing);
    const meta = tracker.track(`/collections/${landing.slug}`, htmlWithPlaceholders, productFallbackDate);
    const html = replaceDatePlaceholders(htmlWithPlaceholders, meta);
    fs.writeFileSync(path.join(collectionDir, `${landing.slug}.html`), html, 'utf8');
  }

  // Inject 12 prerendered catalog cards into index.html between markers
  // so crawlers see the assortment without executing JS.
  const indexPath = path.join(ROOT, 'index.html');
  const indexHtml = stripGeneratedPageMeta(fs.readFileSync(indexPath, 'utf8'));
  const prerender = renderCatalogPrerender(products, 12);
  const patched = injectCatalogPrerender(indexHtml, prerender);
  if (patched && patched !== indexHtml) {
    fs.writeFileSync(indexPath, patched, 'utf8');
    console.log('✓ Injected catalog prerender into index.html');
  } else if (!patched) {
    console.warn('! catalog:prerender markers not found in index.html — skipped');
  }

  const robotsPath = path.join(ROOT, 'robots.txt');
  fs.writeFileSync(robotsPath, renderRobots(), 'utf8');

  const llmsFullWithPlaceholders = renderLlmsFull(products);
  const llmsFullMeta = tracker.track(
    '/llms-full.txt',
    llmsFullWithPlaceholders,
    maxDate(productFallbackDate, gitDateForPath('scripts/build-products.js')),
  );
  fs.writeFileSync(
    path.join(ROOT, 'llms-full.txt'),
    replaceDatePlaceholders(llmsFullWithPlaceholders, llmsFullMeta),
    'utf8',
  );
  const llmsPath = path.join(ROOT, 'llms.txt');
  if (fs.existsSync(llmsPath)) {
    tracker.track('/llms.txt', fs.readFileSync(llmsPath, 'utf8'), gitDateForPath('llms.txt'));
  }
  console.log('✓ Wrote llms-full.txt');

  updateStaticPagesWithDates(tracker);

  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), renderSitemap(products, collectionLandings, tracker), 'utf8');
  tracker.save();

  await pingIndexNow(sitemapUrls());

  console.log(`✓ Wrote ${written} product page(s) to /p`);
  console.log(`✓ Wrote ${productRedirects.length} product redirect(s)`);
  console.log(`✓ Wrote ${collectionLandings.length} collection page(s) to /collections`);
  console.log('✓ Wrote sitemap.xml');
  console.log('✓ Wrote robots.txt');
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
