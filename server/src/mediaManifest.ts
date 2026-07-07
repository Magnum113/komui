import fs from "node:fs";
import path from "node:path";

const PUBLIC_PRODUCTS_PREFIX = "/media/products/";
const OZON_IMAGE_HOST = "ir.ozone.ru";
const DEFAULT_MANIFEST_PATH = "/var/lib/komui/media-cache/manifest.json";

type MediaVariant = {
  width?: number;
  height?: number;
  format?: string;
  url?: string;
};

type MediaManifestEntry = {
  sourceUrl?: string;
  hash?: string;
  width?: number;
  height?: number;
  mime?: string;
  original?: string;
  fallback?: string;
  variants?: MediaVariant[];
  thumb?: string;
  lastSyncedAt?: string;
};

type MediaManifest = {
  version?: number;
  updatedAt?: string;
  images?: Record<string, MediaManifestEntry>;
};

type ManifestCache = {
  path: string;
  mtimeMs: number;
  bySource: Map<string, MediaManifestEntry>;
  byPublicUrl: Map<string, MediaManifestEntry>;
  loaded: boolean;
};

let cache: ManifestCache | null = null;

export function mediaManifestPath(env: NodeJS.ProcessEnv = process.env) {
  return env.KOMUI_MEDIA_MANIFEST_PATH || DEFAULT_MANIFEST_PATH;
}

export function mediaStrict(env: NodeJS.ProcessEnv = process.env) {
  return env.KOMUI_MEDIA_STRICT === "1";
}

function isOzonImageUrl(value: string) {
  try {
    return new URL(value).hostname === OZON_IMAGE_HOST;
  } catch {
    return false;
  }
}

function addPublicUrl(
  byPublicUrl: Map<string, MediaManifestEntry>,
  url: unknown,
  entry: MediaManifestEntry,
) {
  if (typeof url === "string" && url.startsWith(PUBLIC_PRODUCTS_PREFIX)) {
    byPublicUrl.set(url, entry);
  }
}

function statManifest(filePath: string) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function loadManifest(filePath: string): ManifestCache {
  const stat = statManifest(filePath);
  if (!stat) {
    cache = {
      path: filePath,
      mtimeMs: 0,
      bySource: new Map(),
      byPublicUrl: new Map(),
      loaded: false,
    };
    return cache;
  }

  if (cache && cache.path === filePath && cache.mtimeMs === stat.mtimeMs) {
    return cache;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as MediaManifest;
  const images =
    raw && raw.images && typeof raw.images === "object" ? raw.images : {};
  const bySource = new Map<string, MediaManifestEntry>();
  const byPublicUrl = new Map<string, MediaManifestEntry>();

  for (const [sourceUrl, entry] of Object.entries(images)) {
    if (!entry || typeof entry !== "object") continue;
    bySource.set(sourceUrl, entry);
    addPublicUrl(byPublicUrl, entry.original, entry);
    addPublicUrl(byPublicUrl, entry.fallback, entry);
    addPublicUrl(byPublicUrl, entry.thumb, entry);
    if (Array.isArray(entry.variants)) {
      for (const variant of entry.variants) {
        addPublicUrl(byPublicUrl, variant && variant.url, entry);
      }
    }
  }

  cache = {
    path: filePath,
    mtimeMs: stat.mtimeMs,
    bySource,
    byPublicUrl,
    loaded: true,
  };
  return cache;
}

export function mediaManifestStatus(env: NodeJS.ProcessEnv = process.env) {
  const manifest = loadManifest(mediaManifestPath(env));
  return {
    path: manifest.path,
    loaded: manifest.loaded,
    sourceImages: manifest.bySource.size,
    publicImages: manifest.byPublicUrl.size,
    strict: mediaStrict(env),
  };
}

export function resolvePublicMediaUrl(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (typeof value !== "string" || !value) return value;
  if (value.startsWith(PUBLIC_PRODUCTS_PREFIX)) return value;

  const manifest = loadManifest(mediaManifestPath(env));
  const entry = manifest.bySource.get(value);
  if (entry && entry.fallback) return entry.fallback;

  if (mediaStrict(env) && isOzonImageUrl(value)) {
    throw new Error(`Media manifest does not contain Ozon image URL: ${value}`);
  }

  return value;
}

export function resolvePublicMediaUrls(
  values: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => resolvePublicMediaUrl(value, env))
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
}

export function mediaFilePathFromPublicUrl(
  publicUrl: string,
  cacheDir = path.dirname(mediaManifestPath()),
) {
  if (!publicUrl.startsWith(PUBLIC_PRODUCTS_PREFIX)) return "";
  return path.join(
    cacheDir,
    "public",
    "products",
    publicUrl.slice(PUBLIC_PRODUCTS_PREFIX.length),
  );
}
