#!/usr/bin/env node
/*
 * Synchronize product images from external Ozon CDN into KOMUI-owned media cache.
 *
 * Default local cache:
 *   .komui/media-cache
 *
 * Production cache:
 *   KOMUI_MEDIA_CACHE_DIR=/var/lib/komui/media-cache
 *
 * Manifest:
 *   <cache>/manifest.json
 *
 * Public files:
 *   <cache>/public/products/<hash-prefix>/<hash>/{original.*,480.webp,800.webp,1200.webp,thumb.webp}
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CACHE_DIR = path.join(ROOT, '.komui', 'media-cache');
const OZON_IMAGE_HOST = 'ir.ozone.ru';
const PUBLIC_PRODUCTS_PREFIX = '/media/products/';
const VARIANT_WIDTHS = [480, 800, 1200];
const THUMB_WIDTH = 320;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.KOMUI_MEDIA_DOWNLOAD_TIMEOUT_MS || 20_000);
const API_PRODUCTS_PATH = process.env.KOMUI_API_PRODUCTS_PATH || '/v1/products?limit=500';
const API_TIMEOUT_MS = Number(process.env.KOMUI_API_TIMEOUT_MS || 10_000);

function parseArgs(argv) {
  const args = {
    dryRun: false,
    source: '',
    cacheDir: process.env.KOMUI_MEDIA_CACHE_DIR || DEFAULT_CACHE_DIR,
    reportDir: process.env.KOMUI_MEDIA_REPORT_DIR || '',
    limit: 0,
    strict: process.env.KOMUI_MEDIA_STRICT === '1',
    cleanupDryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--cleanup-dry-run') args.cleanupDryRun = true;
    else if (arg === '--source') args.source = argv[++i] || '';
    else if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg === '--cache-dir') args.cacheDir = argv[++i] || args.cacheDir;
    else if (arg.startsWith('--cache-dir=')) args.cacheDir = arg.slice('--cache-dir='.length);
    else if (arg === '--report-dir') args.reportDir = argv[++i] || '';
    else if (arg.startsWith('--report-dir=')) args.reportDir = arg.slice('--report-dir='.length);
    else if (arg === '--limit') args.limit = Math.max(0, Number(argv[++i] || 0));
    else if (arg.startsWith('--limit=')) args.limit = Math.max(0, Number(arg.slice('--limit='.length)));
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.cacheDir = path.resolve(args.cacheDir);
  args.reportDir = args.reportDir
    ? path.resolve(args.reportDir)
    : path.join(args.cacheDir, 'reports');
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync-product-media.js [options]

Options:
  --dry-run                 Collect URLs and print report without writing files.
  --source <file>           Read products from local JS file instead of API/default fallback.
  --cache-dir <dir>         Media cache directory. Default: ${DEFAULT_CACHE_DIR}
  --report-dir <dir>        Report directory. Default: <cache-dir>/reports
  --limit <n>               Process only first n unique image URLs.
  --strict                  Exit non-zero if a hero image cannot be synchronized.
  --cleanup-dry-run         Print orphan candidates; does not delete files.

Environment:
  KOMUI_API_BASE_URL        Optional API source, for example http://127.0.0.1:3001/api
  KOMUI_API_PRODUCTS_PATH   Default: ${API_PRODUCTS_PATH}
  KOMUI_API_BASIC_AUTH      Optional Basic auth header value
  KOMUI_MEDIA_CACHE_DIR     Recommended on server: /var/lib/komui/media-cache
  KOMUI_MEDIA_REPORT_DIR    Recommended on server: /var/log/komui/media-sync
`);
}

function nowIso() {
  return new Date().toISOString();
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function loadProductsFromLocalFile(sourcePath) {
  const resolved = path.resolve(ROOT, sourcePath);
  const src = fs.readFileSync(resolved, 'utf8');
  const sandbox = { window: {} };
  const fn = new Function('window', src);
  fn(sandbox.window);
  if (!Array.isArray(sandbox.window.KOMUI_PRODUCTS)) {
    throw new Error(`${sourcePath} does not expose window.KOMUI_PRODUCTS`);
  }
  return sandbox.window.KOMUI_PRODUCTS;
}

function apiBasicAuthHeader() {
  if (process.env.KOMUI_API_BASIC_AUTH) return process.env.KOMUI_API_BASIC_AUTH;
  if (!process.env.KOMUI_API_BASIC_USER || !process.env.KOMUI_API_BASIC_PASSWORD) return '';
  return `Basic ${Buffer.from(`${process.env.KOMUI_API_BASIC_USER}:${process.env.KOMUI_API_BASIC_PASSWORD}`).toString('base64')}`;
}

async function loadProductsFromApi() {
  const baseUrl = String(process.env.KOMUI_API_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('KOMUI_API_BASE_URL is not set');
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable; Node >= 18 is required');

  const url = `${baseUrl}${API_PRODUCTS_PATH.startsWith('/') ? API_PRODUCTS_PATH : `/${API_PRODUCTS_PATH}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const authorization = apiBasicAuthHeader();
    const res = await fetch(url, {
      headers: authorization ? { Authorization: authorization } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(`Unexpected API response shape from ${url}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadProducts(args) {
  if (args.source) {
    const products = loadProductsFromLocalFile(args.source);
    return { products, source: args.source };
  }

  try {
    const products = await loadProductsFromApi();
    return { products, source: `${process.env.KOMUI_API_BASE_URL}${API_PRODUCTS_PATH}` };
  } catch (err) {
    const fallback = 'data/storefront-products.js';
    console.warn(`! API source unavailable: ${err.message}`);
    console.warn(`! Falling back to ${fallback}`);
    const products = loadProductsFromLocalFile(fallback);
    return { products, source: fallback };
  }
}

function normalizeImageUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).toString();
  } catch {
    return '';
  }
}

function isOzonImageUrl(value) {
  const url = normalizeImageUrl(value);
  if (!url) return false;
  try {
    return new URL(url).hostname === OZON_IMAGE_HOST;
  } catch {
    return false;
  }
}

function addImageCandidate(map, rawUrl, product, role, hero = false) {
  const url = normalizeImageUrl(rawUrl);
  if (!url || !isOzonImageUrl(url)) return;

  const productSlug = String(product.slug || product.id || 'unknown');
  const productName = String(product.name || '');
  const entry = map.get(url) || {
    url,
    roles: new Set(),
    products: new Map(),
    hero: false,
  };
  entry.roles.add(role);
  entry.hero = entry.hero || hero;
  entry.products.set(productSlug, productName);
  map.set(url, entry);
}

function collectImageCandidates(products) {
  const map = new Map();
  for (const product of products) {
    if (!product || typeof product !== 'object') continue;

    const heroUrl =
      product.primary_image_url ||
      product.main_image_path ||
      (Array.isArray(product.image_urls) ? product.image_urls[0] : '') ||
      '';

    addImageCandidate(map, product.primary_image_url, product, 'product.primary_image_url', product.primary_image_url === heroUrl);
    addImageCandidate(map, product.main_image_path, product, 'product.main_image_path', product.main_image_path === heroUrl);

    if (Array.isArray(product.image_urls)) {
      product.image_urls.forEach((url, index) => {
        addImageCandidate(map, url, product, `product.image_urls[${index}]`, url === heroUrl);
      });
    }

    if (Array.isArray(product.offers)) {
      product.offers.forEach((offer, offerIndex) => {
        if (!offer || typeof offer !== 'object') return;
        addImageCandidate(
          map,
          offer.primary_image,
          product,
          `offers[${offerIndex}].primary_image`,
          offer.primary_image === heroUrl,
        );
        if (Array.isArray(offer.images)) {
          offer.images.forEach((url, imageIndex) => {
            addImageCandidate(map, url, product, `offers[${offerIndex}].images[${imageIndex}]`, url === heroUrl);
          });
        }
      });
    }
  }

  return [...map.values()].map((entry) => ({
    url: entry.url,
    roles: [...entry.roles].sort(),
    products: [...entry.products.entries()].map(([slug, name]) => ({ slug, name })),
    hero: entry.hero,
  }));
}

function publicUrlToFilePath(cacheDir, publicUrl) {
  if (typeof publicUrl !== 'string' || !publicUrl.startsWith(PUBLIC_PRODUCTS_PREFIX)) return '';
  const rest = publicUrl.slice(PUBLIC_PRODUCTS_PREFIX.length);
  return path.join(cacheDir, 'public', 'products', rest);
}

function manifestEntryComplete(cacheDir, entry) {
  if (!entry || typeof entry !== 'object') return false;
  const paths = [];
  if (entry.original) paths.push(entry.original);
  if (entry.fallback) paths.push(entry.fallback);
  if (entry.thumb) paths.push(entry.thumb);
  if (Array.isArray(entry.variants)) {
    for (const variant of entry.variants) {
      if (variant && variant.url) paths.push(variant.url);
    }
  }
  if (!paths.length) return false;
  return paths.every((url) => {
    const filePath = publicUrlToFilePath(cacheDir, url);
    return filePath && fileExists(filePath);
  });
}

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'KOMUI media sync/1.0 (+https://komui.ru)',
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('image/')) {
        throw new Error(`Unexpected content-type: ${contentType || 'unknown'}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function originalExtension(contentType, format) {
  if (format === 'jpeg' || contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (format === 'png' || contentType.includes('png')) return 'png';
  if (format === 'webp' || contentType.includes('webp')) return 'webp';
  if (format === 'gif' || contentType.includes('gif')) return 'gif';
  return 'bin';
}

function publicUrlFor(hash, filename) {
  return `${PUBLIC_PRODUCTS_PREFIX}${hash.slice(0, 2)}/${hash}/${filename}`;
}

async function synchronizeImage(candidate, args) {
  const sharp = require('sharp');
  const { buffer, contentType } = await fetchWithRetry(candidate.url);
  const metadata = await sharp(buffer).metadata();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const ext = originalExtension(contentType, metadata.format);
  const dir = path.join(args.cacheDir, 'public', 'products', hash.slice(0, 2), hash);
  ensureDir(dir);

  const originalName = `original.${ext}`;
  const originalPath = path.join(dir, originalName);
  fs.writeFileSync(originalPath, buffer);

  const variants = [];
  for (const width of VARIANT_WIDTHS) {
    const output = await sharp(buffer)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    const fileName = `${width}.webp`;
    fs.writeFileSync(path.join(dir, fileName), output.data);
    variants.push({
      width: output.info.width,
      height: output.info.height,
      format: 'webp',
      url: publicUrlFor(hash, fileName),
    });
  }

  const thumbOutput = await sharp(buffer)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  fs.writeFileSync(path.join(dir, 'thumb.webp'), thumbOutput.data);

  const fallback = variants.find((variant) => variant.width >= 800) || variants[variants.length - 1];

  return {
    sourceUrl: candidate.url,
    hash,
    width: metadata.width || fallback.width,
    height: metadata.height || fallback.height,
    mime: contentType.split(';')[0],
    original: publicUrlFor(hash, originalName),
    fallback: fallback.url,
    variants,
    thumb: publicUrlFor(hash, 'thumb.webp'),
    lastSyncedAt: nowIso(),
  };
}

function buildOrphanReport(cacheDir, nextManifest) {
  const publicProductsDir = path.join(cacheDir, 'public', 'products');
  const referenced = new Set();
  for (const entry of Object.values(nextManifest.images || {})) {
    for (const url of [
      entry.original,
      entry.fallback,
      entry.thumb,
      ...(Array.isArray(entry.variants) ? entry.variants.map((variant) => variant.url) : []),
    ]) {
      const filePath = publicUrlToFilePath(cacheDir, url);
      if (filePath) referenced.add(path.resolve(filePath));
    }
  }

  const existing = [];
  function walk(dir) {
    if (!fileExists(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const itemPath = path.join(dir, item.name);
      if (item.isDirectory()) walk(itemPath);
      else existing.push(path.resolve(itemPath));
    }
  }
  walk(publicProductsDir);

  return existing.filter((filePath) => !referenced.has(filePath));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = nowIso();
  const manifestPath = path.join(args.cacheDir, 'manifest.json');
  const previousManifestPath = path.join(args.cacheDir, 'manifest.previous.json');

  const { products, source } = await loadProducts(args);
  const candidates = collectImageCandidates(products);
  const limitedCandidates = args.limit > 0 ? candidates.slice(0, args.limit) : candidates;
  const previousManifest = readJsonIfExists(manifestPath, { version: 1, updatedAt: '', images: {} });
  const nextManifest = {
    version: 1,
    updatedAt: nowIso(),
    images: { ...(previousManifest.images || {}) },
  };

  const report = {
    startedAt,
    finishedAt: '',
    source,
    dryRun: args.dryRun,
    cacheDir: args.cacheDir,
    products: products.length,
    uniqueOzonUrls: candidates.length,
    processedUrls: limitedCandidates.length,
    heroUrls: candidates.filter((candidate) => candidate.hero).length,
    downloaded: 0,
    reused: 0,
    failed: [],
    fatal: false,
    orphanCandidates: [],
  };

  console.log(`Source: ${source}`);
  console.log(`Products: ${products.length}`);
  console.log(`Unique Ozon image URLs: ${candidates.length}`);
  if (args.limit > 0) console.log(`Limit: ${args.limit}`);

  if (args.dryRun) {
    const reusable = limitedCandidates.filter((candidate) =>
      manifestEntryComplete(args.cacheDir, nextManifest.images[candidate.url]),
    );
    report.reused = reusable.length;
    report.downloaded = Math.max(0, limitedCandidates.length - reusable.length);
    report.finishedAt = nowIso();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  ensureDir(args.cacheDir);
  ensureDir(path.join(args.cacheDir, 'public', 'products'));
  ensureDir(args.reportDir);

  for (const candidate of limitedCandidates) {
    const existing = nextManifest.images[candidate.url];
    if (manifestEntryComplete(args.cacheDir, existing)) {
      report.reused += 1;
      continue;
    }

    try {
      nextManifest.images[candidate.url] = await synchronizeImage(candidate, args);
      report.downloaded += 1;
      console.log(`✓ ${candidate.url}`);
    } catch (err) {
      const failure = {
        url: candidate.url,
        hero: candidate.hero,
        message: err && err.message ? err.message : String(err),
        products: candidate.products,
        roles: candidate.roles,
      };
      report.failed.push(failure);
      if (candidate.hero) report.fatal = true;
      console.warn(`! ${candidate.url}: ${failure.message}`);
      if (candidate.hero && args.strict) break;
    }
  }

  report.orphanCandidates = args.cleanupDryRun ? buildOrphanReport(args.cacheDir, nextManifest) : [];
  report.finishedAt = nowIso();

  if (fileExists(manifestPath)) {
    fs.copyFileSync(manifestPath, previousManifestPath);
  }
  writeJsonAtomic(manifestPath, nextManifest);

  const reportPath = path.join(args.reportDir, `${timestamp()}.json`);
  writeJsonAtomic(reportPath, report);

  console.log(`Manifest: ${manifestPath}`);
  if (fileExists(previousManifestPath)) console.log(`Previous manifest: ${previousManifestPath}`);
  console.log(`Report: ${reportPath}`);
  console.log(
    `Done: downloaded=${report.downloaded}, reused=${report.reused}, failed=${report.failed.length}, fatal=${report.fatal}`,
  );

  if (report.fatal && args.strict) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
