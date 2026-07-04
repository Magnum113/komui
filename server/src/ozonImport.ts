import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { auditAdminEvent } from "./audit";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { buildSeoProductSlug } from "./seoSlugs";

const OZON_PRICE_PATH = "/v5/product/info/prices";
const OZON_PRODUCT_INFO_LIST_PATH = "/v3/product/info/list";
const OZON_PRODUCT_INFO_ATTRIBUTES_PATH = "/v4/product/info/attributes";
const OZON_DEFAULT_BASE_URL = "https://api-seller.ozon.ru";
const OZON_SIZE_CHART_ATTRIBUTE_ID = 13164;

const LEGACY_DESIGN_KEY_ALIASES: Record<string, string[]> = {
  // Historical storefront records were created before Ozon offer_id design
  // numbers became stable. These aliases keep preview/import from offering
  // duplicate "new cards" for known products that already exist on the site.
  "var2|embroidery|tshirt|white": ["var13|embroidery|tshirt|white"],
  "var25|print|tshirt|black": ["var5|print|tshirt|black"],
  "var7|print|tshirt|white": ["var7|print|tshirt|other"],
};

const targetSchema = z
  .object({
    serverPostgres: z.boolean().optional(),
    supabase: z.boolean().optional(),
  })
  .default({});

const previewRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
    includeArchived: z.boolean().optional(),
    // When false, existing offers/products keep their current prices:
    // price/old_price/min_price and merch sale_price are excluded from the
    // import plan. Ozon prices are still returned in preview for admin UI.
    updatePrices: z.boolean().optional(),
    // "add" only adds newly detected Ozon sizes to storefront products.
    // It does not remove sizes when Ozon items disappear or are archived.
    syncSizes: z.enum(["add", "off"]).optional(),
    targets: targetSchema.optional(),
  })
  .default({});

const importRequestSchema = z.object({
  previewId: z.string().uuid(),
  confirm: z.literal(true),
  targets: targetSchema.optional(),
  itemIds: z.array(z.string().trim().min(1).max(64)).max(10_000).optional(),
  offerIds: z.array(z.string().trim().min(1).max(160)).max(10_000).optional(),
});

const priceSchema = z.coerce.number().positive().max(1_000_000);

const createStorefrontProductRequestSchema = z.object({
  previewId: z.string().uuid(),
  offerItemIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  offerIds: z.array(z.string().trim().min(1).max(160)).max(500).optional(),
  product: z
    .object({
      designKey: z.string().trim().min(1).max(160).optional(),
      ozonVariant: z.string().trim().min(1).max(80).optional(),
      slug: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .optional(),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(20_000).nullable().optional(),
      ozonDescription: z.string().max(20_000).nullable().optional(),
      shortDescription: z.string().max(1_000).nullable().optional(),
      category: z.string().trim().min(1).max(120).optional(),
      categorySlug: z.string().trim().min(1).max(120).optional(),
      productType: z.string().trim().min(1).max(120).optional(),
      productTypeSlug: z.string().trim().min(1).max(120).optional(),
      decorationType: z.string().trim().min(1).max(120).optional(),
      decorationSlug: z.string().trim().min(1).max(120).optional(),
      colorName: z.string().trim().min(1).max(120).nullable().optional(),
      colorSlug: z.string().trim().min(1).max(120).nullable().optional(),
      colorHex: z.string().trim().min(1).max(32).nullable().optional(),
      franchiseType: z.string().trim().min(1).max(80).optional(),
      titleName: z.string().trim().min(1).max(160).nullable().optional(),
      titleSlug: z.string().trim().min(1).max(160).nullable().optional(),
      animeTitle: z.string().trim().min(1).max(160).nullable().optional(),
      animeSlug: z.string().trim().min(1).max(160).nullable().optional(),
      characterName: z.string().trim().min(1).max(160).nullable().optional(),
      characterSlug: z.string().trim().min(1).max(160).nullable().optional(),
      collectionName: z.string().trim().min(1).max(160).nullable().optional(),
      collectionSlug: z.string().trim().min(1).max(160).nullable().optional(),
      designName: z.string().trim().min(1).max(160).nullable().optional(),
      designSlug: z.string().trim().min(1).max(160).nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(80)).max(80).optional(),
      badges: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      sizes: z.array(z.string().trim().min(1).max(32)).max(30).optional(),
      salePrice: priceSchema,
      regularPrice: priceSchema.nullable().optional(),
      imageUrls: z
        .array(z.string().trim().min(1).max(2_048))
        .min(1)
        .max(80)
        .optional(),
      sizeChartJson: z.unknown().nullable().optional(),
      mainImagePath: z.string().trim().min(1).max(2_048).nullable().optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.coerce.number().int().min(0).max(1_000_000).optional(),
    })
    .strict(),
});

const linkStorefrontOffersRequestSchema = z.object({
  previewId: z.string().uuid(),
  productId: z.string().uuid(),
  offerItemIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  offerIds: z.array(z.string().trim().min(1).max(160)).max(500).optional(),
  updatePrices: z.boolean().optional(),
  syncSizes: z.enum(["add", "off"]).optional(),
});

type Targets = {
  serverPostgres: boolean;
  supabase: boolean;
};

type OzonImportEnv = {
  configured: boolean;
  clientId?: string;
  apiKey?: string;
  apiBaseUrl: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  supabaseWriteEnabled: boolean;
  mode: string;
};

export type OzonPriceItem = {
  offer_id?: string;
  product_id?: string | number;
  id?: string | number;
  sku?: string | number;
  name?: string;
  price?: {
    price?: string | number | null;
    marketing_seller_price?: string | number | null;
    old_price?: string | number | null;
    min_price?: string | number | null;
  };
  visible?: boolean | null;
  archived?: boolean;
  primary_image?: unknown;
  images?: unknown;
  images360?: unknown;
  color_image?: unknown;
  media_loaded?: boolean;
  size_chart_json?: unknown;
};

type StorefrontRow = {
  id: string;
  design_key: string;
  name: string;
  slug: string;
  sizes: unknown;
  price_min: string | number | null;
  price_max: string | number | null;
  primary_image_url: string | null;
  main_image_path: string | null;
  image_urls: unknown;
  size_chart_json?: unknown;
  ozon_product_ids: unknown;
  ozon_skus: unknown;
  ozon_offer_ids: unknown;
  offers: unknown;
};

type MerchProductRow = {
  id: string | number;
  sku: string | null;
  legacy_skus: unknown;
  ozon_sku: string | number | null;
  sale_price: string | number | null;
};

export type OzonPreviewItem = {
  itemId: string;
  status: "matched" | "unmatched" | "noop";
  severity: "info" | "warning";
  offerId?: string;
  normalizedOfferId?: string;
  productId?: string;
  sku?: string;
  name?: string;
  size?: string;
  price?: number;
  oldPrice?: number;
  minPrice?: number;
  visible?: boolean | null;
  archived?: boolean;
  sizeChartJson?: unknown;
  media?: {
    primaryImage?: string | null;
    images?: string[];
    images360?: string[];
    colorImage?: string | null;
  };
  matchReason?: string;
  inferredProduct?: OzonInferredProduct;
  importOptions?: {
    updatePrices: boolean;
    syncSizes: "add" | "off";
  };
  targetProduct?: {
    id: string;
    designKey: string;
    slug: string;
    name: string;
  };
  targetMerchProduct?: {
    id: string | number;
    sku?: string;
  };
  plannedActions: Array<{
    target: "serverPostgres" | "supabase";
    action:
      | "create_storefront_offer"
      | "update_storefront_offer"
      | "update_merch_product_price"
      | "create_storefront_product"
      | "skip";
    reason?: string;
  }>;
  diff?: {
    target: "serverPostgres";
    table: "merch_storefront_products" | "merch_products";
    operation:
      | "create_storefront_offer"
      | "update_storefront_offer"
      | "update_merch_product_price"
      | "create_storefront_product"
      | "noop";
    changed: boolean;
    changedFields: string[];
    fields: Array<{
      field: string;
      current: unknown;
      next: unknown;
      changed: boolean;
    }>;
  };
  mediaDiff?: {
    offer: {
      primaryImage: {
        current: string | null;
        next: string | null;
        changed: boolean;
      };
      images: {
        current: string[];
        next: string[];
        added: string[];
        removed: string[];
        orderChanged: boolean;
        changed: boolean;
      };
    };
    product: {
      primaryImageUrl: {
        current: string | null;
        next: string | null;
        changed: boolean;
      };
      mainImagePath: {
        current: string | null;
        next: string | null;
        changed: boolean;
        preservedManualOverride: boolean;
      };
      imageUrls: {
        current: string[];
        next: string[];
        added: string[];
        removed: string[];
        orderChanged: boolean;
        changed: boolean;
      };
    };
  };
};

type PreviewBuildResult = {
  summary: {
    totalOzonItems: number;
    matchedStorefront: number;
    matchedMerchProducts: number;
    unmatched: number;
    newProductGroups: number;
    actionableServerPostgres: number;
    actionableSupabase: number;
    noop: number;
  };
  canImport: boolean;
  warnings: Array<{ code: string; message: string; count?: number }>;
  items: OzonPreviewItem[];
  newProductGroups: OzonProductGroup[];
};

type OzonInferredProduct = {
  designKey: string;
  slug: string;
  ozonVariant: string;
  productType: string;
  productTypeSlug: string;
  category: string;
  categorySlug: string;
  decorationType: string;
  decorationSlug: string;
  colorName: string;
  colorSlug: string;
  colorHex: string;
  tags: string[];
};

type OzonProductGroup = OzonInferredProduct & {
  itemIds: string[];
  offerIds: string[];
  skus: string[];
  productIds: string[];
  sizes: string[];
  suggestedName: string;
  primaryImageUrl: string | null;
  imageUrls: string[];
  sizeChartJson?: unknown;
  minOzonPrice: number | null;
  maxOzonPrice: number | null;
};

type StoredPreview = {
  id: string;
  import_type: string;
  request_payload: unknown;
  summary: unknown;
  items: unknown;
  can_import: boolean;
  warnings: unknown;
  created_at: Date | string;
};

type JobRow = {
  id: string;
  job_type: string;
  status: string;
  preview_id: string | null;
  request_payload: unknown;
  result_payload: unknown;
  errors: unknown;
  progress_current: number;
  progress_total: number;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  updated_at: Date | string;
};

type SupabasePatch = {
  table: string;
  id: string | number;
  patch: Record<string, unknown>;
};

type StorefrontUpdateResult = {
  table: "merch_storefront_products";
  id: string;
  patch: Record<string, unknown>;
};

type MerchProductUpdateResult = {
  table: "merch_products";
  id: string | number;
  patch: Record<string, unknown>;
};

type AppliedUpdate = StorefrontUpdateResult | MerchProductUpdateResult;

type OzonImportContext = {
  config: AppConfig;
  db: Db;
  fetchImpl?: typeof fetch;
};

function parseBoolean(value: string | undefined, fallback = false) {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function stripEnvQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvText(text: string) {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [rawKey, ...rawValue] = line.split("=");
    const key = rawKey.trim();
    if (!key) continue;
    env[key] = stripEnvQuotes(rawValue.join("="));
  }
  return env;
}

async function loadOzonImportEnv(config: AppConfig): Promise<OzonImportEnv> {
  let text = "";
  try {
    text = await readFile(config.OZON_IMPORT_ENV_FILE, "utf8");
  } catch (error) {
    return {
      configured: false,
      apiBaseUrl: OZON_DEFAULT_BASE_URL,
      supabaseWriteEnabled: false,
      mode: "missing_env_file",
    };
  }

  const env = parseEnvText(text);
  const clientId = env.OZON_CLIENT_ID;
  const apiKey = env.OZON_API_KEY;
  return {
    configured: Boolean(clientId && apiKey),
    clientId,
    apiKey,
    apiBaseUrl: env.OZON_API_BASE_URL || OZON_DEFAULT_BASE_URL,
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceKey: env.SUPABASE_SERVICE_KEY,
    supabaseWriteEnabled: parseBoolean(env.OZON_IMPORT_WRITE_SUPABASE),
    mode: env.OZON_IMPORT_MODE || "dry_run",
  };
}

function normalizeTargets(input: Partial<Targets> | undefined): Targets {
  return {
    serverPostgres: input?.serverPostgres !== false,
    supabase: input?.supabase === true,
  };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(",", ".").trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStringId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toNumericId(value: unknown): number | undefined {
  const text = toStringId(value);
  if (!text || !/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberArray(value: unknown): number[] {
  return unknownArray(value)
    .map(toNumericId)
    .filter((item): item is number => item !== undefined);
}

function stringArray(value: unknown): string[] {
  return unknownArray(value)
    .map(toStringId)
    .filter((item): item is string => item !== undefined);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap(collectStrings);
}

function uniqueStrings(values: unknown[]) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values.flatMap(collectStrings)) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function blankToNull(value: unknown): string | null {
  return toStringId(value) ?? null;
}

function arrayDiff(current: string[], next: string[]) {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  const added = next.filter((item) => !currentSet.has(item));
  const removed = current.filter((item) => !nextSet.has(item));
  const orderChanged =
    added.length === 0 && removed.length === 0 && !sameArray(current, next);
  return {
    added,
    removed,
    orderChanged,
    changed: added.length > 0 || removed.length > 0 || orderChanged,
  };
}

function mediaFromOzonItem(item: Pick<
  OzonPriceItem,
  "primary_image" | "images" | "images360" | "color_image"
>) {
  const primaryImage = collectStrings(item.primary_image)[0];
  const images = uniqueStrings([primaryImage, item.images]);
  const images360 = uniqueStrings([item.images360]);
  const colorImage = collectStrings(item.color_image)[0];
  return {
    primaryImage,
    images,
    images360,
    colorImage,
  };
}

function normalizeSizeChartJson(value: unknown): unknown | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (typeof value === "object") return value;
  return undefined;
}

function extractOzonSizeChartJson(value: unknown): unknown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as {
    attributes?: Array<{
      attribute_id?: unknown;
      id?: unknown;
      values?: unknown[];
    }>;
  };
  for (const attribute of unknownArray(item.attributes)) {
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute)) {
      continue;
    }
    const attr = attribute as {
      attribute_id?: unknown;
      id?: unknown;
      values?: unknown[];
    };
    const attributeId = toNumericId(attr.attribute_id ?? attr.id);
    if (attributeId !== OZON_SIZE_CHART_ATTRIBUTE_ID) continue;

    for (const rawValue of unknownArray(attr.values)) {
      const valueObject =
        rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
          ? (rawValue as { value?: unknown })
          : undefined;
      const parsed = normalizeSizeChartJson(valueObject ? valueObject.value : rawValue);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function mediaFromOffer(offer: Record<string, unknown> | undefined) {
  const primaryImage = blankToNull(offer?.primary_image);
  return {
    primaryImage,
    images: uniqueStrings([primaryImage, offer?.images]),
  };
}

function imageUrlsFromOffers(
  offers: Array<Record<string, unknown>>,
  fallback: unknown,
) {
  const activeOffers = offers.filter((offer) => offer.archived !== true);
  const sourceOffers = activeOffers.length > 0 ? activeOffers : offers;
  const images = uniqueStrings(
    sourceOffers.flatMap((offer) => [
      offer.primary_image,
      offer.images,
    ]),
  );
  return images.length > 0 ? images : stringArray(fallback);
}

function nextMainImagePath(current: unknown, nextPrimaryImage: string | null) {
  return blankToNull(current) ?? nextPrimaryImage;
}

function normalizeKey(value: unknown): string | undefined {
  const text = toStringId(value);
  return text ? text.toUpperCase() : undefined;
}

export function normalizeOfferId(value: unknown): string | undefined {
  const text = toStringId(value);
  if (!text) return undefined;
  return text
    .replace(/\s+/g, "")
    .replace(/_/g, "-")
    .toUpperCase()
    .replace(/^D0*(\d+)(?=$|-)/, "D$1")
    .replace(/^VAR0*(\d+)(?=$|-)/, "VAR$1");
}

function offerIdForDisplay(value: unknown): string | undefined {
  const text = toStringId(value);
  return text || undefined;
}

export function priceFromOzonItem(item: Pick<OzonPriceItem, "price">) {
  return (
    toNumber(item.price?.marketing_seller_price) ??
    toNumber(item.price?.price) ??
    undefined
  );
}

function oldPriceFromOzonItem(item: Pick<OzonPriceItem, "price">) {
  return toNumber(item.price?.old_price);
}

function minPriceFromOzonItem(item: Pick<OzonPriceItem, "price">) {
  return toNumber(item.price?.min_price);
}

const PRODUCT_CODE_TO_SLUG: Record<string, string> = {
  TSH: "tshirt",
  TSHIRT: "tshirt",
  HDY: "hoodie",
  HOODIE: "hoodie",
  HOD: "hoodie",
  SWT: "sweatshirt",
  SWEAT: "sweatshirt",
  SWEATSHIRT: "sweatshirt",
};

const DECORATION_CODE_TO_SLUG: Record<string, string> = {
  PRT: "print",
  PRINT: "print",
  EMB: "embroidery",
  EMBROIDERY: "embroidery",
};

const COLOR_CODE_TO_SLUG: Record<string, string> = {
  WHT: "white",
  WHITE: "white",
  BLK: "black",
  BLACK: "black",
  GRY: "grey",
  GREY: "grey",
  GRAY: "grey",
  WGRY: "washed-grey",
  GRYW: "washed-grey",
  GREYW: "washed-grey",
  WASHEDGREY: "washed-grey",
  WASHEDGRAY: "washed-grey",
  WBEG: "washed-beige",
  BEGW: "washed-beige",
  BEIGE: "beige",
  BEG: "beige",
  BLU: "blue",
  BLUE: "blue",
};

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL"];

const PRODUCT_META: Record<
  string,
  { productType: string; category: string; categorySlug: string }
> = {
  tshirt: {
    productType: "Футболка",
    category: "Футболки",
    categorySlug: "tshirts",
  },
  hoodie: {
    productType: "Худи",
    category: "Худи",
    categorySlug: "hoodies",
  },
  sweatshirt: {
    productType: "Свитшот",
    category: "Свитшоты",
    categorySlug: "sweatshirts",
  },
};

const DECORATION_META: Record<string, string> = {
  print: "Принт",
  embroidery: "Вышивка",
};

const COLOR_META: Record<string, { name: string; hex: string }> = {
  white: { name: "Белый", hex: "#ffffff" },
  black: { name: "Черный", hex: "#111111" },
  grey: { name: "Серый", hex: "#9ca3af" },
  "washed-grey": { name: "Вареный серый", hex: "#9ca3af" },
  beige: { name: "Бежевый", hex: "#d8c4a8" },
  "washed-beige": { name: "Вареный бежевый", hex: "#c8b6a6" },
  blue: { name: "Синий", hex: "#2563eb" },
};

function normalizeSize(value: unknown): string | undefined {
  const text = toStringId(value)?.toUpperCase();
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, "").replace(/_/g, "-");
  if (compact === "2XL" || compact === "XXL" || compact === "2-XL") {
    return "XXL";
  }
  if (compact === "3XL" || compact === "XXXL" || compact === "3-XL") {
    return "3XL";
  }
  if (compact === "4XL" || compact === "XXXXL" || compact === "4-XL") {
    return "4XL";
  }
  if (["XS", "S", "M", "L", "XL"].includes(compact)) return compact;
  return undefined;
}

function sortSizes(values: string[]) {
  return uniqueStrings(values)
    .map(normalizeSize)
    .filter((item): item is string => item !== undefined)
    .sort((left, right) => {
      const leftIndex = SIZE_ORDER.indexOf(left);
      const rightIndex = SIZE_ORDER.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? 999 : leftIndex) -
          (rightIndex === -1 ? 999 : rightIndex);
      }
      return left.localeCompare(right);
    });
}

function normalizeSlugSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferSizeFromName(value: unknown) {
  const text = toStringId(value);
  if (!text) return undefined;
  const match = /(?:^|\s|\()((?:[234]\s?XL)|XXXL|XXL|XL|XS|S|M|L)(?:\)|\s|$)/i.exec(
    text,
  );
  return normalizeSize(match?.[1]);
}

function offerPartsFromOfferId(value: unknown) {
  const normalized = normalizeOfferId(value);
  if (!normalized) return undefined;
  const parts = normalized.split("-").filter(Boolean);
  if (parts.length < 4) return undefined;

  const modern = /^D(\d+)$/.exec(parts[0]);
  if (!modern) return undefined;
  const productTypeSlug = PRODUCT_CODE_TO_SLUG[parts[1]];
  const decorationSlug = DECORATION_CODE_TO_SLUG[parts[2]];
  const colorSlug = COLOR_CODE_TO_SLUG[parts[3]];
  if (!productTypeSlug || !decorationSlug || !colorSlug) return undefined;

  const size = [...parts]
    .reverse()
    .map(normalizeSize)
    .find((item): item is string => item !== undefined);

  return {
    designNumber: Number(modern[1]),
    productTypeSlug,
    decorationSlug,
    colorSlug,
    size,
  };
}

function inferSizeFromOzonItem(item: Pick<OzonPriceItem, "offer_id" | "name">) {
  return offerPartsFromOfferId(item.offer_id)?.size ?? inferSizeFromName(item.name);
}

function inferredProductFromOfferId(value: unknown): OzonInferredProduct | undefined {
  const parts = offerPartsFromOfferId(value);
  if (!parts) return undefined;
  const product = PRODUCT_META[parts.productTypeSlug];
  const decorationType = DECORATION_META[parts.decorationSlug];
  const color = COLOR_META[parts.colorSlug];
  if (!product || !decorationType || !color) return undefined;

  const ozonVariant = `var${parts.designNumber}`;
  const designKey = `${ozonVariant}|${parts.decorationSlug}|${parts.productTypeSlug}|${parts.colorSlug}`;
  const slug = [
    ozonVariant,
    parts.decorationSlug,
    parts.productTypeSlug,
    parts.colorSlug,
  ]
    .map(normalizeSlugSegment)
    .filter(Boolean)
    .join("-");

  return {
    designKey,
    slug,
    ozonVariant,
    productType: product.productType,
    productTypeSlug: parts.productTypeSlug,
    category: product.category,
    categorySlug: product.categorySlug,
    decorationType,
    decorationSlug: parts.decorationSlug,
    colorName: color.name,
    colorSlug: parts.colorSlug,
    colorHex: color.hex,
    tags: [
      parts.productTypeSlug,
      parts.decorationSlug,
      parts.colorSlug,
      "anime",
    ],
  };
}

export function designKeyCandidatesFromOfferId(value: unknown): string[] {
  const normalized = normalizeOfferId(value);
  if (!normalized) return [];

  const candidates = new Set<string>();
  const addCandidate = (designKey: string) => {
    candidates.add(designKey);
    for (const alias of LEGACY_DESIGN_KEY_ALIASES[designKey] ?? []) {
      candidates.add(alias);
    }
  };
  const modern = /^D(\d+)-([A-Z]+)-([A-Z]+)-([A-Z]+)(?:-|$)/.exec(
    normalized,
  );
  if (modern) {
    const [, designNumber, productCode, decorationCode, colorCode] = modern;
    const product = PRODUCT_CODE_TO_SLUG[productCode];
    const decoration = DECORATION_CODE_TO_SLUG[decorationCode];
    const color = COLOR_CODE_TO_SLUG[colorCode];
    if (product && decoration && color) {
      addCandidate(`var${Number(designNumber)}|${decoration}|${product}|${color}`);
    }
  }

  const legacy = /^VAR(\d+)(?:-|$)/.exec(normalized);
  if (legacy) {
    const design = `var${Number(legacy[1])}`;
    const lower = normalized.toLowerCase();
    const product =
      lower.includes("tshirt") || lower.includes("t-sh") || lower.includes("tsh")
        ? "tshirt"
        : lower.includes("hoodie") || lower.includes("hdy")
          ? "hoodie"
          : lower.includes("sweat") || lower.includes("swt")
            ? "sweatshirt"
            : undefined;
    const decoration =
      lower.includes("print") || lower.includes("prt")
        ? "print"
        : lower.includes("emb") || lower.includes("выш")
          ? "embroidery"
          : undefined;
    const color = lower.includes("greyw") || lower.includes("wgry")
      ? "washed-grey"
      : lower.includes("black") || lower.includes("blk")
        ? "black"
        : lower.includes("white") || lower.includes("wht")
          ? "white"
          : lower.includes("blue") || lower.includes("blu")
            ? "blue"
            : lower.includes("beige") || lower.includes("beg")
              ? "beige"
              : undefined;
    if (product && decoration && color) {
      addCandidate(`${design}|${decoration}|${product}|${color}`);
    }
  }

  return [...candidates];
}

function getOfferArray(row: StorefrontRow): Array<Record<string, unknown>> {
  return unknownArray(row.offers).filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function addUniqueNumber(values: number[], value: unknown) {
  const numeric = toNumericId(value);
  if (numeric !== undefined && !values.includes(numeric)) values.push(numeric);
  return values;
}

function addUniqueOfferId(values: string[], value: unknown) {
  const text = toStringId(value);
  const normalized = normalizeOfferId(text);
  if (
    text &&
    !values.some((existingValue) => {
      const existing = normalizeOfferId(existingValue);
      return existing && normalized && existing === normalized;
    })
  ) {
    values.push(text);
  }
  return values;
}

function productKey(product: StorefrontRow) {
  return {
    id: product.id,
    designKey: product.design_key,
    slug: product.slug,
    name: product.name,
  };
}

function merchProductKey(product: MerchProductRow) {
  return {
    id: product.id,
    sku: product.sku || undefined,
  };
}

type PreviewOzonFields = Pick<
  OzonPreviewItem,
  | "offerId"
  | "normalizedOfferId"
  | "productId"
  | "sku"
  | "name"
  | "size"
  | "price"
  | "oldPrice"
  | "minPrice"
  | "visible"
  | "archived"
  | "sizeChartJson"
  | "media"
>;

type PreviewDiff = NonNullable<OzonPreviewItem["diff"]>;
type PreviewDiffField = PreviewDiff["fields"][number];

function jsonValue(value: unknown) {
  return value === undefined ? null : value;
}

function sameNumberValue(current: unknown, next: unknown) {
  const currentNumber = toNumber(current);
  const nextNumber = toNumber(next);
  if (currentNumber !== undefined || nextNumber !== undefined) {
    return currentNumber === nextNumber;
  }
  return current === next;
}

function sameJsonValue(current: unknown, next: unknown) {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function sameDiffValue(field: string, current: unknown, next: unknown) {
  const baseField = field.includes(".") ? field.split(".").at(-1) || field : field;
  if (baseField === "size_chart_json") {
    return sameJsonValue(current, next);
  }
  if (baseField === "offer_id") {
    return normalizeOfferId(current) === normalizeOfferId(next);
  }
  if (baseField === "product_id" || baseField === "sku") {
    return toStringId(current) === toStringId(next);
  }
  if (
    baseField === "primary_image" ||
    baseField === "primary_image_url" ||
    baseField === "main_image_path" ||
    baseField === "color_image"
  ) {
    return blankToNull(current) === blankToNull(next);
  }
  if (
    baseField === "price" ||
    baseField === "old_price" ||
    baseField === "min_price" ||
    baseField === "price_min" ||
    baseField === "price_max" ||
    baseField === "sale_price"
  ) {
    return sameNumberValue(current, next);
  }
  if (
    baseField === "images" ||
    baseField === "image_urls" ||
    baseField === "images360"
  ) {
    return sameArray(uniqueStrings([current]), uniqueStrings([next]));
  }
  return current === next;
}

function diffField(field: string, current: unknown, next: unknown): PreviewDiffField {
  const changed = !sameDiffValue(field, current, next);
  return {
    field,
    current: jsonValue(current),
    next: jsonValue(next),
    changed,
  };
}

function sameArray(left: unknown[], right: unknown[]) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function diffArrayField(
  field: string,
  current: unknown[],
  next: unknown[],
): PreviewDiffField {
  return {
    field,
    current,
    next,
    changed: !sameArray(current, next),
  };
}

function offerPatchFromPreviewItem(
  item: PreviewOzonFields,
  syncedAt?: string,
  options: {
    includePrices?: boolean;
    priceOverride?: number;
  } = {},
): Record<string, unknown> {
  const includePrices = options.includePrices !== false;
  const patch: Record<string, unknown> = {
    offer_id: item.offerId,
    product_id: toNumericId(item.productId) ?? item.productId,
    sku: toNumericId(item.sku) ?? item.sku,
    name: item.name,
    size: item.size,
    price: options.priceOverride ?? (includePrices ? item.price : undefined),
    old_price: includePrices ? item.oldPrice : undefined,
    min_price: includePrices ? item.minPrice : undefined,
    ozon_price: includePrices ? undefined : item.price,
    ozon_old_price: includePrices ? undefined : item.oldPrice,
    ozon_min_price: includePrices ? undefined : item.minPrice,
    visible: item.visible,
    archived: item.archived,
    primary_image: item.media?.primaryImage,
    images: item.media?.images,
  };

  if (syncedAt !== undefined) {
    patch.last_ozon_sync_at = syncedAt;
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete patch[key];
  }

  return patch;
}

function findMatchingOfferIndex(
  currentOffers: Array<Record<string, unknown>>,
  item: PreviewOzonFields,
) {
  return currentOffers.findIndex((offer) => {
    const offerId = normalizeOfferId(offer.offer_id);
    if (offerId && item.normalizedOfferId && offerId === item.normalizedOfferId) {
      return true;
    }
    const sku = toStringId(offer.sku);
    if (sku && item.sku && sku === item.sku) return true;
    const productId = toStringId(offer.product_id);
    return Boolean(productId && item.productId && productId === item.productId);
  });
}

function changedFields(fields: PreviewDiffField[]) {
  return fields.filter((field) => field.changed).map((field) => field.field);
}

function shouldExposeOfferOnStorefront(item: PreviewOzonFields) {
  return item.archived !== true && item.visible !== false;
}

function nextSizesFromOzonItem(current: unknown, item: PreviewOzonFields) {
  const currentSizes = sortSizes(stringArray(current));
  if (!item.size || !shouldExposeOfferOnStorefront(item)) return currentSizes;
  return sortSizes([...currentSizes, item.size]);
}

function buildMediaDiff(
  row: StorefrontRow,
  currentOffer: Record<string, unknown> | undefined,
  item: PreviewOzonFields,
  nextOffers: Array<Record<string, unknown>>,
): NonNullable<OzonPreviewItem["mediaDiff"]> {
  const currentOfferMedia = mediaFromOffer(currentOffer);
  const nextOfferPrimaryImage = item.media
    ? item.media.primaryImage ?? null
    : currentOfferMedia.primaryImage;
  const nextOfferImages = item.media ? item.media.images ?? [] : currentOfferMedia.images;
  const offerImagesDiff = arrayDiff(currentOfferMedia.images, nextOfferImages);

  const currentProductPrimaryImage = blankToNull(row.primary_image_url);
  const currentProductImageUrls = stringArray(row.image_urls);
  const nextProductImageUrls = imageUrlsFromOffers(nextOffers, row.image_urls);
  const nextProductPrimaryImage = nextProductImageUrls[0] ?? null;
  const currentMainImagePath = blankToNull(row.main_image_path);
  const nextProductMainImagePath = nextMainImagePath(
    row.main_image_path,
    nextProductPrimaryImage,
  );
  const productImageUrlsDiff = arrayDiff(
    currentProductImageUrls,
    nextProductImageUrls,
  );

  return {
    offer: {
      primaryImage: {
        current: currentOfferMedia.primaryImage,
        next: nextOfferPrimaryImage,
        changed: currentOfferMedia.primaryImage !== nextOfferPrimaryImage,
      },
      images: {
        current: currentOfferMedia.images,
        next: nextOfferImages,
        ...offerImagesDiff,
      },
    },
    product: {
      primaryImageUrl: {
        current: currentProductPrimaryImage,
        next: nextProductPrimaryImage,
        changed: currentProductPrimaryImage !== nextProductPrimaryImage,
      },
      mainImagePath: {
        current: currentMainImagePath,
        next: nextProductMainImagePath,
        changed: currentMainImagePath !== nextProductMainImagePath,
        preservedManualOverride: Boolean(currentMainImagePath),
      },
      imageUrls: {
        current: currentProductImageUrls,
        next: nextProductImageUrls,
        ...productImageUrlsDiff,
      },
    },
  };
}

function buildStorefrontDiff(
  row: StorefrontRow,
  item: PreviewOzonFields,
  options: {
    updatePrices: boolean;
    syncSizes: "add" | "off";
  },
): { diff: PreviewDiff; mediaDiff: NonNullable<OzonPreviewItem["mediaDiff"]> } {
  const currentProductIds = numberArray(row.ozon_product_ids);
  const currentSkus = numberArray(row.ozon_skus);
  const currentOfferIds = stringArray(row.ozon_offer_ids);
  const nextProductIds = addUniqueNumber([...currentProductIds], item.productId);
  const nextSkus = addUniqueNumber([...currentSkus], item.sku);
  const nextOfferIds = addUniqueOfferId([...currentOfferIds], item.offerId);
  const currentOffers = getOfferArray(row);
  const offerIndex = findMatchingOfferIndex(currentOffers, item);
  const offerPatch = offerPatchFromPreviewItem(item, undefined, {
    includePrices: options.updatePrices,
  });
  const nextOffers = mergeOffer(currentOffers, item, undefined, {
    includePrices: options.updatePrices,
  });
  const priceRange = options.updatePrices
    ? priceRangeFromOffers(nextOffers, row.price_min, row.price_max)
    : { min: row.price_min, max: row.price_max };
  const nextSizeChartJson =
    item.sizeChartJson !== undefined ? item.sizeChartJson : row.size_chart_json ?? null;
  const nextImageUrls = imageUrlsFromOffers(nextOffers, row.image_urls);
  const nextPrimaryImageUrl = nextImageUrls[0] ?? null;
  const nextProductMainImagePath = nextMainImagePath(
    row.main_image_path,
    nextPrimaryImageUrl,
  );
  const nextSizes = options.syncSizes === "add"
    ? nextSizesFromOzonItem(row.sizes, item)
    : sortSizes(stringArray(row.sizes));
  const mediaDiff = buildMediaDiff(
    row,
    offerIndex >= 0 ? currentOffers[offerIndex] : undefined,
    item,
    nextOffers,
  );
  const fields: PreviewDiffField[] = [
    diffArrayField("ozon_product_ids", currentProductIds, nextProductIds),
    diffArrayField("ozon_skus", currentSkus, nextSkus),
    diffArrayField("ozon_offer_ids", currentOfferIds, nextOfferIds),
    diffField("price_min", row.price_min, priceRange.min),
    diffField("price_max", row.price_max, priceRange.max),
    diffArrayField("sizes", sortSizes(stringArray(row.sizes)), nextSizes),
    diffField("size_chart_json", row.size_chart_json ?? null, nextSizeChartJson),
    diffField("primary_image_url", row.primary_image_url, nextPrimaryImageUrl),
    diffField("main_image_path", row.main_image_path, nextProductMainImagePath),
    diffArrayField("image_urls", stringArray(row.image_urls), nextImageUrls),
  ];

  if (offerIndex >= 0) {
    const currentOffer = currentOffers[offerIndex];
    for (const [field, nextValue] of Object.entries(offerPatch)) {
      fields.push(diffField(`offers.${field}`, currentOffer[field], nextValue));
    }
  } else {
    for (const [field, nextValue] of Object.entries(offerPatch)) {
      fields.push({
        field: `offers.${field}`,
        current: null,
        next: jsonValue(nextValue),
        changed: true,
      });
    }
  }

  const changed = changedFields(fields);
  return {
    diff: {
      target: "serverPostgres",
      table: "merch_storefront_products",
      operation:
        changed.length === 0
          ? "noop"
          : offerIndex >= 0
            ? "update_storefront_offer"
            : "create_storefront_offer",
      changed: changed.length > 0,
      changedFields: changed,
      fields,
    },
    mediaDiff,
  };
}

function buildMerchProductDiff(
  row: MerchProductRow,
  item: PreviewOzonFields,
): PreviewDiff {
  const fields =
    item.price === undefined
      ? [
          {
            field: "sale_price",
            current: jsonValue(row.sale_price),
            next: null,
            changed: false,
          },
        ]
      : [diffField("sale_price", row.sale_price, item.price)];
  const changed = changedFields(fields);
  return {
    target: "serverPostgres",
    table: "merch_products",
    operation: changed.length > 0 ? "update_merch_product_price" : "noop",
    changed: changed.length > 0,
    changedFields: changed,
    fields,
  };
}

function diffActionReason(diff: PreviewDiff) {
  if (!diff.changed) return "no_changes";
  if (diff.operation === "create_storefront_offer") return "offer_missing";
  if (diff.changedFields.length > 0) {
    return `changed:${diff.changedFields.join(",")}`;
  }
  return undefined;
}

function buildIndexes(
  storefrontRows: StorefrontRow[],
  merchRows: MerchProductRow[],
) {
  const bySku = new Map<string, StorefrontRow>();
  const byProductId = new Map<string, StorefrontRow>();
  const byOfferId = new Map<string, StorefrontRow>();
  const byDesignKey = new Map<string, StorefrontRow>();
  const merchBySku = new Map<string, MerchProductRow>();

  for (const row of storefrontRows) {
    byDesignKey.set(row.design_key.toLowerCase(), row);
    for (const sku of stringArray(row.ozon_skus)) {
      const key = normalizeKey(sku);
      if (key) bySku.set(key, row);
    }
    for (const productId of stringArray(row.ozon_product_ids)) {
      const key = normalizeKey(productId);
      if (key) byProductId.set(key, row);
    }
    for (const offerId of stringArray(row.ozon_offer_ids)) {
      const key = normalizeOfferId(offerId);
      if (key) byOfferId.set(key, row);
    }
    for (const offer of getOfferArray(row)) {
      const offerKey = normalizeOfferId(offer.offer_id);
      if (offerKey) byOfferId.set(offerKey, row);
      const skuKey = normalizeKey(offer.sku);
      if (skuKey) bySku.set(skuKey, row);
      const productIdKey = normalizeKey(offer.product_id);
      if (productIdKey) byProductId.set(productIdKey, row);
    }
  }

  for (const row of merchRows) {
    const sku = normalizeKey(row.sku);
    if (sku) merchBySku.set(sku, row);
    const ozonSku = normalizeKey(row.ozon_sku);
    if (ozonSku) merchBySku.set(ozonSku, row);
    for (const legacySku of stringArray(row.legacy_skus)) {
      const key = normalizeKey(legacySku);
      if (key) merchBySku.set(key, row);
    }
  }

  return { bySku, byProductId, byOfferId, byDesignKey, merchBySku };
}

function findStorefrontMatch(
  item: OzonPriceItem,
  indexes: ReturnType<typeof buildIndexes>,
) {
  const normalizedOfferId = normalizeOfferId(item.offer_id);
  if (normalizedOfferId) {
    const byOffer = indexes.byOfferId.get(normalizedOfferId);
    if (byOffer) return { row: byOffer, reason: "ozon_offer_id" };
  }

  const sku = normalizeKey(item.sku);
  if (sku) {
    const bySku = indexes.bySku.get(sku);
    if (bySku) return { row: bySku, reason: "ozon_sku" };
  }

  const productId = normalizeKey(item.product_id);
  if (productId) {
    const byProductId = indexes.byProductId.get(productId);
    if (byProductId) return { row: byProductId, reason: "ozon_product_id" };
  }

  for (const designKey of designKeyCandidatesFromOfferId(item.offer_id)) {
    const row = indexes.byDesignKey.get(designKey.toLowerCase());
    if (row) return { row, reason: "offer_id_design_key" };
  }

  return undefined;
}

function findMerchProductMatch(
  item: OzonPriceItem,
  indexes: ReturnType<typeof buildIndexes>,
) {
  const sku = normalizeKey(item.sku);
  if (sku) {
    const row = indexes.merchBySku.get(sku);
    if (row) return { row, reason: "merch_ozon_sku" };
  }
  const offerKey = normalizeKey(item.offer_id);
  if (offerKey) {
    const row = indexes.merchBySku.get(offerKey);
    if (row) return { row, reason: "merch_sku" };
  }
  return undefined;
}

function stripTrailingSizeFromName(value: string | undefined) {
  if (!value) return "";
  return value
    .replace(/\s+(?:[234]\s?XL|XXXL|XXL|XL|XS|S|M|L)\s*$/i, "")
    .trim();
}

function buildNewProductGroups(items: OzonPreviewItem[]): OzonProductGroup[] {
  const groups = new Map<string, OzonPreviewItem[]>();
  for (const item of items) {
    if (item.status !== "unmatched" || !item.inferredProduct) continue;
    const existing = groups.get(item.inferredProduct.designKey) ?? [];
    existing.push(item);
    groups.set(item.inferredProduct.designKey, existing);
  }

  const productGroups: OzonProductGroup[] = [];
  for (const [, groupItems] of groups) {
    const first = groupItems[0];
    const inferred = first?.inferredProduct;
    if (!first || !inferred) continue;

    const imageUrls = uniqueStrings(
      groupItems.flatMap((item) => [
        item.media?.primaryImage,
        item.media?.images,
      ]),
    );
    const prices = groupItems
      .map((item) => item.price)
      .filter((price): price is number => price !== undefined);
    const suggestedName = stripTrailingSizeFromName(first.name) ||
      `${inferred.productType} ${inferred.ozonVariant}`;
    const sizeChartJson = groupItems.find((item) => item.sizeChartJson !== undefined)
      ?.sizeChartJson;

    productGroups.push({
      ...inferred,
      slug: buildSeoProductSlug({
        suggestedName,
        decorationSlug: inferred.decorationSlug,
        colorSlug: inferred.colorSlug,
      }),
      itemIds: groupItems.map((item) => item.itemId),
      offerIds: groupItems
        .map((item) => item.offerId)
        .filter((item): item is string => item !== undefined),
      skus: groupItems
        .map((item) => item.sku)
        .filter((item): item is string => item !== undefined),
      productIds: groupItems
        .map((item) => item.productId)
        .filter((item): item is string => item !== undefined),
      sizes: sortSizes(
        groupItems
          .map((item) => item.size)
          .filter((item): item is string => item !== undefined),
      ),
      suggestedName,
      primaryImageUrl: imageUrls[0] ?? null,
      imageUrls,
      sizeChartJson,
      minOzonPrice: prices.length ? Math.min(...prices) : null,
      maxOzonPrice: prices.length ? Math.max(...prices) : null,
    });
  }

  return productGroups.sort((left, right) => left.slug.localeCompare(right.slug));
}

export function buildOzonPreview(
  ozonItems: OzonPriceItem[],
  storefrontRows: StorefrontRow[],
  merchRows: MerchProductRow[],
  targets: Targets,
  settings: Pick<OzonImportEnv, "supabaseWriteEnabled"> = {
    supabaseWriteEnabled: false,
  },
  options: { updatePrices?: boolean; syncSizes?: "add" | "off" } = {},
): PreviewBuildResult {
  const updatePrices = options.updatePrices === true;
  const syncSizes = options.syncSizes ?? "add";
  const indexes = buildIndexes(storefrontRows, merchRows);
  const items: OzonPreviewItem[] = [];
  let matchedStorefront = 0;
  let matchedMerchProducts = 0;
  let unmatched = 0;
  let actionableServerPostgres = 0;
  let actionableSupabase = 0;
  let noop = 0;

  for (const ozonItem of ozonItems) {
    const price = priceFromOzonItem(ozonItem);
    const oldPrice = oldPriceFromOzonItem(ozonItem);
    const minPrice = minPriceFromOzonItem(ozonItem);
    const normalizedOfferId = normalizeOfferId(ozonItem.offer_id);
    const size = inferSizeFromOzonItem(ozonItem);
    const inferredProduct = inferredProductFromOfferId(ozonItem.offer_id);
    const itemId = createHash("sha256")
      .update(
        JSON.stringify({
          offerId: ozonItem.offer_id || null,
          sku: ozonItem.sku || null,
          productId: ozonItem.product_id || null,
        }),
      )
      .digest("hex")
      .slice(0, 24);

    const storefrontMatch = findStorefrontMatch(ozonItem, indexes);
    const merchMatch = findMerchProductMatch(ozonItem, indexes);
    const plannedActions: OzonPreviewItem["plannedActions"] = [];
    const media = ozonItem.media_loaded ? mediaFromOzonItem(ozonItem) : undefined;
    const source: PreviewOzonFields = {
      offerId: offerIdForDisplay(ozonItem.offer_id),
      normalizedOfferId,
      productId: toStringId(ozonItem.product_id),
      sku: toStringId(ozonItem.sku),
      name: toStringId(ozonItem.name),
      size,
      price,
      oldPrice,
      minPrice,
      visible:
        typeof ozonItem.visible === "boolean" || ozonItem.visible === null
          ? ozonItem.visible
          : undefined,
      archived:
        typeof ozonItem.archived === "boolean" ? ozonItem.archived : undefined,
      sizeChartJson: ozonItem.size_chart_json,
      media: media
        ? {
            primaryImage: media.primaryImage ?? null,
            images: media.images,
            images360: media.images360,
            colorImage: media.colorImage ?? null,
          }
        : undefined,
    };
    const storefrontPreview = storefrontMatch
      ? buildStorefrontDiff(storefrontMatch.row, source, {
          updatePrices,
          syncSizes,
        })
      : undefined;
    const diff = storefrontPreview?.diff ??
      (merchMatch && updatePrices
        ? buildMerchProductDiff(merchMatch.row, source)
        : undefined);
    const mediaDiff = storefrontPreview?.mediaDiff;

    if (storefrontMatch) {
      matchedStorefront += 1;
      if (targets.serverPostgres) {
        if (diff?.changed && diff.operation !== "noop") {
          plannedActions.push({
            target: "serverPostgres",
            action: diff.operation,
            reason: diffActionReason(diff),
          });
          actionableServerPostgres += 1;
        } else {
          plannedActions.push({
            target: "serverPostgres",
            action: "skip",
            reason: "no_changes",
          });
        }
      }
      if (targets.supabase) {
        if (!diff?.changed || diff.operation === "noop") {
          plannedActions.push({
            target: "supabase",
            action: "skip",
            reason: "no_changes",
          });
        } else if (settings.supabaseWriteEnabled) {
          plannedActions.push({
            target: "supabase",
            action: diff.operation,
            reason: diffActionReason(diff),
          });
          actionableSupabase += 1;
        } else {
          plannedActions.push({
            target: "supabase",
            action: "skip",
            reason: "supabase_write_disabled",
          });
        }
      }
    } else if (merchMatch) {
      matchedMerchProducts += 1;
      if (targets.serverPostgres) {
        if (diff?.changed && diff.operation !== "noop") {
          plannedActions.push({
            target: "serverPostgres",
            action: diff.operation,
            reason: diffActionReason(diff),
          });
          actionableServerPostgres += 1;
        } else {
          plannedActions.push({
            target: "serverPostgres",
            action: "skip",
            reason: updatePrices
              ? price === undefined
                ? "missing_price"
                : "no_changes"
              : "price_updates_disabled",
          });
        }
      }
      if (targets.supabase) {
        if (!diff?.changed || diff.operation === "noop") {
          plannedActions.push({
            target: "supabase",
            action: "skip",
            reason: updatePrices
              ? price === undefined
                ? "missing_price"
                : "no_changes"
              : "price_updates_disabled",
          });
        } else if (settings.supabaseWriteEnabled) {
          plannedActions.push({
            target: "supabase",
            action: diff.operation,
            reason: diffActionReason(diff),
          });
          actionableSupabase += 1;
        } else {
          plannedActions.push({
            target: "supabase",
            action: "skip",
            reason: "supabase_write_disabled",
          });
        }
      }
    } else {
      unmatched += 1;
      plannedActions.push({
        target: "serverPostgres",
        action: "skip",
        reason: inferredProduct
          ? "new_product_requires_creation"
          : "unmatched_requires_mapping",
      });
      if (targets.supabase) {
        plannedActions.push({
          target: "supabase",
          action: "skip",
          reason: settings.supabaseWriteEnabled
            ? "unmatched_requires_mapping"
            : "supabase_write_disabled",
        });
      }
    }

    const hasImportAction = plannedActions.some((action) => action.action !== "skip");
    if ((storefrontMatch || merchMatch) && !hasImportAction) {
      noop += 1;
    }

    items.push({
      itemId,
      status: storefrontMatch || merchMatch ? (hasImportAction ? "matched" : "noop") : "unmatched",
      severity: storefrontMatch || merchMatch ? "info" : "warning",
      ...source,
      matchReason: storefrontMatch?.reason || merchMatch?.reason,
      inferredProduct: storefrontMatch || merchMatch ? undefined : inferredProduct,
      importOptions: {
        updatePrices,
        syncSizes,
      },
      targetProduct: storefrontMatch ? productKey(storefrontMatch.row) : undefined,
      targetMerchProduct: merchMatch ? merchProductKey(merchMatch.row) : undefined,
      plannedActions,
      diff,
      mediaDiff,
    });
  }

  const productGroups = buildNewProductGroups(items);
  const warnings: PreviewBuildResult["warnings"] = [];
  if (unmatched > 0) {
    warnings.push({
      code: "unmatched_requires_mapping",
      message:
        "Часть Ozon-позиций не сопоставлена с карточками сайта; они будут пропущены до настройки маппинга.",
      count: unmatched,
    });
  }
  if (productGroups.length > 0) {
    warnings.push({
      code: "new_products_require_creation",
      message:
        "Найдены новые Ozon-дизайны без карточек витрины. Создайте карточки через admin API, затем повторите preview/import для оставшихся изменений.",
      count: productGroups.length,
    });
  }
  if (targets.supabase && !settings.supabaseWriteEnabled) {
    warnings.push({
      code: "supabase_write_disabled",
      message:
        "Запись в Supabase отключена на сервере флагом OZON_IMPORT_WRITE_SUPABASE=false.",
    });
  }
  if (!updatePrices) {
    warnings.push({
      code: "price_updates_disabled",
      message:
        "Обновление цен отключено: цены сайта и offers.price не изменятся. Ozon-цены вернутся в preview и сохранятся как ozon_price-поля при импорте.",
    });
  }

  const summary = {
    totalOzonItems: ozonItems.length,
    matchedStorefront,
    matchedMerchProducts,
    unmatched,
    newProductGroups: productGroups.length,
    actionableServerPostgres,
    actionableSupabase,
    noop,
  };

  return {
    summary,
    canImport: actionableServerPostgres > 0 || actionableSupabase > 0,
    warnings,
    items,
    newProductGroups: productGroups,
  };
}

async function fetchOzonPriceItems(
  settings: OzonImportEnv,
  limit: number,
  includeArchived: boolean,
  fetchImpl: typeof fetch,
): Promise<OzonPriceItem[]> {
  if (!settings.configured || !settings.clientId || !settings.apiKey) {
    throw new HttpError(
      503,
      "ozon_not_configured",
      "Ozon import credentials are not configured",
    );
  }

  const items: OzonPriceItem[] = [];
  let cursor = "";
  const endpoint = new URL(OZON_PRICE_PATH, settings.apiBaseUrl).toString();

  while (items.length < limit) {
    const pageLimit = Math.min(1000, limit - items.length);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Client-Id": settings.clientId,
        "Api-Key": settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          visibility: includeArchived ? "ALL" : "ALL",
        },
        cursor,
        limit: pageLimit,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HttpError(502, "ozon_request_failed", "Ozon API request failed", {
        status: response.status,
        body: body.slice(0, 500),
      });
    }

    const payload = (await response.json()) as {
      items?: OzonPriceItem[];
      cursor?: string;
      result?: {
        items?: OzonPriceItem[];
        cursor?: string;
      };
    };
    const pageItems = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.result?.items)
        ? payload.result.items
        : [];
    items.push(...pageItems);

    const nextCursor = payload.cursor || payload.result?.cursor || "";
    if (!nextCursor || pageItems.length === 0) break;
    cursor = nextCursor;
  }

  const filteredItems = includeArchived
    ? items
    : items.filter((item) => item.archived !== true);
  return filteredItems.slice(0, limit);
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function fetchOzonProductInfoItems(
  settings: OzonImportEnv,
  priceItems: OzonPriceItem[],
  fetchImpl: typeof fetch,
) {
  const productIds = [
    ...new Set(
      priceItems
        .map((item) => toNumericId(item.product_id ?? item.id))
        .filter((item): item is number => item !== undefined),
    ),
  ];
  const byProductId = new Map<string, OzonPriceItem>();
  if (!productIds.length) return byProductId;

  const endpoint = new URL(
    OZON_PRODUCT_INFO_LIST_PATH,
    settings.apiBaseUrl,
  ).toString();

  for (const batch of chunkArray(productIds, 100)) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Client-Id": settings.clientId || "",
        "Api-Key": settings.apiKey || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_id: batch,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HttpError(
        502,
        "ozon_product_info_request_failed",
        "Ozon product info request failed",
        {
          status: response.status,
          body: body.slice(0, 500),
        },
      );
    }

    const payload = (await response.json()) as {
      items?: OzonPriceItem[];
      result?: {
        items?: OzonPriceItem[];
      };
    };
    const pageItems = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.result?.items)
        ? payload.result.items
        : [];
    for (const item of pageItems) {
      const productId = toStringId(item.id ?? item.product_id);
      if (productId) byProductId.set(productId, item);
    }
  }

  return byProductId;
}

async function fetchOzonSizeChartItems(
  settings: OzonImportEnv,
  priceItems: OzonPriceItem[],
  fetchImpl: typeof fetch,
) {
  const offerIds = uniqueStrings(
    priceItems
      .map((item) => item.offer_id)
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim())),
  );
  const byOfferId = new Map<string, unknown>();
  const byProductId = new Map<string, unknown>();
  if (!offerIds.length) return { byOfferId, byProductId };

  const endpoint = new URL(
    OZON_PRODUCT_INFO_ATTRIBUTES_PATH,
    settings.apiBaseUrl,
  ).toString();

  for (const batch of chunkArray(offerIds, 100)) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Client-Id": settings.clientId || "",
        "Api-Key": settings.apiKey || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          offer_id: batch,
          visibility: "ALL",
        },
        limit: batch.length,
        sort_dir: "ASC",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HttpError(
        502,
        "ozon_product_attributes_request_failed",
        "Ozon product attributes request failed",
        {
          status: response.status,
          body: body.slice(0, 500),
        },
      );
    }

    const payload = (await response.json()) as {
      result?: unknown[];
      items?: unknown[];
    };
    const pageItems = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.items)
        ? payload.items
        : [];

    for (const item of pageItems) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as {
        offer_id?: unknown;
        product_id?: unknown;
        id?: unknown;
      };
      const chartJson = extractOzonSizeChartJson(item);
      if (chartJson === undefined) continue;

      const offerId = normalizeOfferId(row.offer_id);
      if (offerId) byOfferId.set(offerId, chartJson);

      const productId = toStringId(row.product_id ?? row.id);
      if (productId) byProductId.set(productId, chartJson);
    }
  }

  return { byOfferId, byProductId };
}

async function enrichOzonItemsWithProductInfo(
  settings: OzonImportEnv,
  priceItems: OzonPriceItem[],
  fetchImpl: typeof fetch,
) {
  const [detailsByProductId, sizeCharts] = await Promise.all([
    fetchOzonProductInfoItems(settings, priceItems, fetchImpl),
    fetchOzonSizeChartItems(settings, priceItems, fetchImpl),
  ]);

  return priceItems.map((priceItem) => {
    const productId = toStringId(priceItem.product_id ?? priceItem.id);
    const details = productId ? detailsByProductId.get(productId) : undefined;
    const normalizedOfferId = normalizeOfferId(priceItem.offer_id);
    const chartJson = normalizedOfferId
      ? sizeCharts.byOfferId.get(normalizedOfferId)
      : undefined;
    const productChartJson = productId
      ? sizeCharts.byProductId.get(productId)
      : undefined;
    const sizeChartJson = chartJson ?? productChartJson;
    if (!details) {
      return sizeChartJson === undefined
        ? priceItem
        : {
            ...priceItem,
            size_chart_json: sizeChartJson,
          };
    }
    return {
      ...priceItem,
      sku: priceItem.sku ?? details.sku,
      name: priceItem.name ?? details.name,
      primary_image: details.primary_image,
      images: details.images,
      images360: details.images360,
      color_image: details.color_image,
      media_loaded: true,
      size_chart_json: sizeChartJson,
    };
  });
}

async function loadStorefrontRows(db: Db) {
  const result = await db.query<StorefrontRow>(
    `
      select
        id,
        design_key,
        name,
        slug,
        sizes,
        price_min,
        price_max,
        primary_image_url,
        main_image_path,
        image_urls,
        size_chart_json,
        ozon_product_ids,
        ozon_skus,
        ozon_offer_ids,
        offers
      from public.merch_storefront_products
      where is_active is true
    `,
  );
  return result.rows;
}

async function loadMerchProductRows(db: Db) {
  const result = await db.query<MerchProductRow>(
    `
      select
        id,
        sku,
        legacy_skus,
        ozon_sku,
        sale_price
      from public.merch_products
      where sku is not null
         or ozon_sku is not null
         or coalesce(array_length(legacy_skus, 1), 0) > 0
    `,
  );
  return result.rows;
}

async function savePreview(
  db: Db,
  requestPayload: unknown,
  preview: PreviewBuildResult,
) {
  const result = await db.query<{ id: string; created_at: Date }>(
    `
      insert into public.merch_admin_import_previews
        (import_type, request_payload, summary, items, can_import, warnings)
      values
        ('ozon_products', $1::jsonb, $2::jsonb, $3::jsonb, $4, $5::jsonb)
      returning id, created_at
    `,
    [
      JSON.stringify(requestPayload),
      JSON.stringify(preview.summary),
      JSON.stringify(preview.items),
      preview.canImport,
      JSON.stringify(preview.warnings),
    ],
  );

  return result.rows[0];
}

function safeJsonArray(value: unknown): OzonPreviewItem[] {
  return Array.isArray(value) ? (value as OzonPreviewItem[]) : [];
}

function selectPreviewItems(
  items: OzonPreviewItem[],
  filters: { itemIds?: string[]; offerIds?: string[] },
) {
  const itemIds = new Set(filters.itemIds ?? []);
  const offerIds = new Set(
    (filters.offerIds ?? [])
      .map(normalizeOfferId)
      .filter((item): item is string => item !== undefined),
  );
  if (!itemIds.size && !offerIds.size) return items;

  return items.filter((item) => {
    if (itemIds.has(item.itemId)) return true;
    const offerId = normalizeOfferId(item.offerId);
    return Boolean(offerId && offerIds.has(offerId));
  });
}

async function loadPreview(db: Db, previewId: string) {
  const result = await db.query<StoredPreview>(
    `
      select id, import_type, request_payload, summary, items, can_import, warnings, created_at
      from public.merch_admin_import_previews
      where id = $1
      limit 1
    `,
    [previewId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "preview_not_found", "Import preview not found");
  }
  if (row.import_type !== "ozon_products") {
    throw new HttpError(400, "wrong_preview_type", "Import preview has wrong type");
  }
  return row;
}

function mergeOffer(
  currentOffers: Array<Record<string, unknown>>,
  item: PreviewOzonFields,
  syncedAt?: string,
  options: {
    includePrices?: boolean;
    priceOverride?: number;
  } = {},
) {
  const nextOffers = currentOffers.map((offer) => ({ ...offer }));
  const index = findMatchingOfferIndex(nextOffers, item);
  const patch = offerPatchFromPreviewItem(item, syncedAt, options);

  if (index >= 0) {
    nextOffers[index] = {
      ...nextOffers[index],
      ...patch,
    };
  } else {
    nextOffers.push(patch);
  }

  return nextOffers;
}

function priceRangeFromOffers(
  offers: Array<Record<string, unknown>>,
  fallbackMin: unknown,
  fallbackMax: unknown,
) {
  const prices = offers
    .filter((offer) => offer.archived !== true)
    .map((offer) => toNumber(offer.price))
    .filter((price): price is number => price !== undefined && price > 0);
  if (!prices.length) {
    return {
      min: toNumber(fallbackMin) ?? null,
      max: toNumber(fallbackMax) ?? null,
    };
  }
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
  };
}

async function applyStorefrontUpdate(
  client: PoolClient,
  item: OzonPreviewItem,
  syncedAt: string,
): Promise<StorefrontUpdateResult | null> {
  if (!item.targetProduct?.id) return null;

  const result = await client.query<StorefrontRow>(
    `
      select
        id,
        design_key,
        name,
        slug,
        sizes,
        price_min,
        price_max,
        primary_image_url,
        main_image_path,
        image_urls,
        size_chart_json,
        ozon_product_ids,
        ozon_skus,
        ozon_offer_ids,
        offers
      from public.merch_storefront_products
      where id = $1
      for update
    `,
    [item.targetProduct.id],
  );
  const row = result.rows[0];
  if (!row) return null;

  const productIds = addUniqueNumber(numberArray(row.ozon_product_ids), item.productId);
  const skus = addUniqueNumber(numberArray(row.ozon_skus), item.sku);
  const offerIds = addUniqueOfferId(stringArray(row.ozon_offer_ids), item.offerId);
  const updatePrices = item.importOptions?.updatePrices !== false;
  const syncSizes = item.importOptions?.syncSizes ?? "add";
  const offers = mergeOffer(getOfferArray(row), item, syncedAt, {
    includePrices: updatePrices,
  });
  const priceRange = updatePrices
    ? priceRangeFromOffers(offers, row.price_min, row.price_max)
    : { min: row.price_min, max: row.price_max };
  const sizes = syncSizes === "add"
    ? nextSizesFromOzonItem(row.sizes, item)
    : sortSizes(stringArray(row.sizes));
  const imageUrls = imageUrlsFromOffers(offers, row.image_urls);
  const primaryImageUrl = imageUrls[0] ?? null;
  const mainImagePath = nextMainImagePath(row.main_image_path, primaryImageUrl);
  const sizeChartJson =
    item.sizeChartJson !== undefined ? item.sizeChartJson : row.size_chart_json ?? null;
  const patch = {
    ozon_product_ids: productIds,
    ozon_skus: skus,
    ozon_offer_ids: offerIds,
    offers,
    sizes,
    size_chart_json: sizeChartJson,
    price_min: priceRange.min,
    price_max: priceRange.max,
    primary_image_url: primaryImageUrl,
    main_image_path: mainImagePath,
    image_urls: imageUrls,
    updated_at: syncedAt,
  };

  await client.query(
    `
      update public.merch_storefront_products
      set
        ozon_product_ids = $2::bigint[],
        ozon_skus = $3::bigint[],
        ozon_offer_ids = $4::text[],
        offers = $5::jsonb,
        sizes = $6::text[],
        price_min = $7,
        price_max = $8,
        primary_image_url = $9,
        main_image_path = $10,
        image_urls = $11::text[],
        size_chart_json = $12::jsonb,
        updated_at = $13::timestamptz
      where id = $1
    `,
    [
      row.id,
      productIds,
      skus,
      offerIds,
      JSON.stringify(offers),
      sizes,
      priceRange.min,
      priceRange.max,
      primaryImageUrl,
      mainImagePath,
      imageUrls,
      JSON.stringify(sizeChartJson),
      syncedAt,
    ],
  );

  return {
    table: "merch_storefront_products",
    id: row.id,
    patch,
  };
}

async function applyMerchProductUpdate(
  client: PoolClient,
  item: OzonPreviewItem,
  syncedAt: string,
): Promise<MerchProductUpdateResult | null> {
  if (!item.targetMerchProduct?.id || item.price === undefined) return null;

  await client.query(
    `
      update public.merch_products
      set sale_price = $2, updated_at = $3::timestamptz
      where id = $1
    `,
    [item.targetMerchProduct.id, item.price, syncedAt],
  );

  return {
    table: "merch_products",
    id: item.targetMerchProduct.id,
    patch: {
      sale_price: item.price,
      updated_at: syncedAt,
    },
  };
}

function nullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requiredText(value: string | undefined, fallback: string | undefined, field: string) {
  const text = nullableText(value) ?? nullableText(fallback);
  if (!text) {
    throw new HttpError(400, "missing_product_field", `${field} is required`);
  }
  return text;
}

function selectedItemsForNewProduct(
  previewItems: OzonPreviewItem[],
  filters: { offerItemIds?: string[]; offerIds?: string[] },
) {
  const selected = selectPreviewItems(previewItems, {
    itemIds: filters.offerItemIds,
    offerIds: filters.offerIds,
  });
  if (!selected.length) {
    throw new HttpError(
      400,
      "empty_offer_selection",
      "No Ozon preview items selected for product creation",
    );
  }
  if (selected.some((item) => item.targetProduct || item.targetMerchProduct)) {
    throw new HttpError(
      400,
      "selection_contains_matched_items",
      "Product creation accepts only unmatched Ozon preview items",
    );
  }

  const designKeys = new Set(
    selected
      .map((item) => item.inferredProduct?.designKey)
      .filter((item): item is string => item !== undefined),
  );
  if (!designKeys.size) {
    throw new HttpError(
      400,
      "selection_without_inferred_product",
      "Selected Ozon items do not contain an inferred product group",
    );
  }
  if (designKeys.size > 1) {
    throw new HttpError(
      400,
      "mixed_product_selection",
      "Selected Ozon items belong to different inferred product groups",
    );
  }

  return selected;
}

function productGroupFromSelectedItems(items: OzonPreviewItem[]) {
  const groups = buildNewProductGroups(items.map((item) => ({
    ...item,
    status: "unmatched",
  })));
  return groups[0];
}

function validateRegularPrice(salePrice: number, regularPrice: number | null | undefined) {
  if (regularPrice !== undefined && regularPrice !== null && regularPrice <= salePrice) {
    throw new HttpError(
      400,
      "invalid_regular_price",
      "regularPrice must be greater than salePrice or null",
    );
  }
}

function offerForCreatedProduct(
  item: OzonPreviewItem,
  salePrice: number,
  syncedAt: string,
) {
  return offerPatchFromPreviewItem(item, syncedAt, {
    includePrices: false,
    priceOverride: salePrice,
  });
}

export async function handleAdminCreateOzonStorefrontProduct(
  request: FastifyRequest,
  _reply: FastifyReply,
  context: OzonImportContext,
) {
  const parsed = createStorefrontProductRequestSchema.parse(request.body || {});
  const preview = await loadPreview(context.db, parsed.previewId);
  const previewItems = safeJsonArray(preview.items);
  const selected = selectedItemsForNewProduct(previewItems, parsed);
  const group = productGroupFromSelectedItems(selected);
  const product = parsed.product;
  validateRegularPrice(product.salePrice, product.regularPrice);

  const designKey = requiredText(product.designKey, group?.designKey, "designKey");
  const slug = requiredText(product.slug, group?.slug, "slug");
  const ozonVariant = requiredText(
    product.ozonVariant,
    group?.ozonVariant ?? designKey.split("|")[0],
    "ozonVariant",
  );
  const sizes = product.sizes !== undefined
    ? sortSizes(product.sizes)
    : sortSizes(group?.sizes ?? []);
  if (!sizes.length) {
    throw new HttpError(400, "missing_sizes", "At least one storefront size is required");
  }

  const imageUrls = product.imageUrls !== undefined
    ? uniqueStrings(product.imageUrls)
    : uniqueStrings(group?.imageUrls ?? []);
  if (!imageUrls.length) {
    throw new HttpError(400, "missing_images", "At least one product image is required");
  }

  const syncedAt = new Date().toISOString();
  const offers = selected.map((item) =>
    offerForCreatedProduct(item, product.salePrice, syncedAt),
  );
  const sizeChartJson = product.sizeChartJson !== undefined
    ? product.sizeChartJson
    : selected.find((item) => item.sizeChartJson !== undefined)?.sizeChartJson ?? null;
  const productIds = numberArray(selected.map((item) => item.productId));
  const skus = numberArray(selected.map((item) => item.sku));
  const offerIds = selected
    .map((item) => item.offerId)
    .filter((item): item is string => item !== undefined);
  const tags = uniqueStrings([group?.tags, product.tags]);
  const badges = uniqueStrings([product.badges]);
  const sourcePayload = {
    source: "ozon_admin_import",
    previewId: parsed.previewId,
    itemIds: selected.map((item) => item.itemId),
    offerIds,
    createdAt: syncedAt,
  };

  const result = await context.db.query<{
    id: string;
    design_key: string;
    slug: string;
    name: string;
    sizes: string[];
    price_min: string | number | null;
    price_max: string | number | null;
    primary_image_url: string | null;
    image_urls: string[];
    size_chart_json: unknown;
    offers: unknown;
    is_active: boolean;
    sort_order: number;
    updated_at: Date | string;
  }>(
    `
      insert into public.merch_storefront_products (
        design_key,
        ozon_variant,
        name,
        slug,
        description,
        ozon_description,
        category,
        category_slug,
        product_type,
        product_type_slug,
        decoration_type,
        decoration_slug,
        color_name,
        color_slug,
        color_hex,
        franchise_type,
        title_name,
        title_slug,
        anime_title,
        anime_slug,
        character_name,
        character_slug,
        collection_name,
        collection_slug,
        design_name,
        design_slug,
        tags,
        sizes,
        price_min,
        price_max,
        currency,
        primary_image_url,
        main_image_path,
        image_urls,
        size_chart_json,
        ozon_product_ids,
        ozon_skus,
        ozon_offer_ids,
        offers,
        source_payload,
        is_active,
        sort_order,
        short_description,
        badges,
        compare_at_price,
        updated_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27::text[], $28::text[],
        $29, $30, 'RUB', $31, $32, $33::text[], $34::jsonb,
        $35::bigint[], $36::bigint[], $37::text[], $38::jsonb,
        $39::jsonb, $40, $41, $42, $43::text[], $44,
        $45::timestamptz
      )
      returning
        id,
        design_key,
        slug,
        name,
        sizes,
        price_min,
        price_max,
        primary_image_url,
        image_urls,
        size_chart_json,
        offers,
        is_active,
        sort_order,
        updated_at
    `,
    [
      designKey,
      ozonVariant,
      product.name.trim(),
      slug,
      nullableText(product.description),
      nullableText(product.ozonDescription ?? product.description),
      requiredText(product.category, group?.category, "category"),
      requiredText(product.categorySlug, group?.categorySlug, "categorySlug"),
      requiredText(product.productType, group?.productType, "productType"),
      requiredText(product.productTypeSlug, group?.productTypeSlug, "productTypeSlug"),
      requiredText(product.decorationType, group?.decorationType, "decorationType"),
      requiredText(product.decorationSlug, group?.decorationSlug, "decorationSlug"),
      nullableText(product.colorName) ?? group?.colorName ?? null,
      nullableText(product.colorSlug) ?? group?.colorSlug ?? null,
      nullableText(product.colorHex) ?? group?.colorHex ?? null,
      product.franchiseType?.trim() || "anime",
      nullableText(product.titleName),
      nullableText(product.titleSlug),
      nullableText(product.animeTitle ?? product.titleName),
      nullableText(product.animeSlug ?? product.titleSlug),
      nullableText(product.characterName),
      nullableText(product.characterSlug),
      nullableText(product.collectionName),
      nullableText(product.collectionSlug),
      nullableText(product.designName ?? product.collectionName),
      nullableText(product.designSlug ?? product.collectionSlug),
      tags,
      sizes,
      product.salePrice,
      product.salePrice,
      imageUrls[0],
      nullableText(product.mainImagePath) ?? imageUrls[0],
      imageUrls,
      JSON.stringify(sizeChartJson),
      productIds,
      skus,
      offerIds,
      JSON.stringify(offers),
      JSON.stringify(sourcePayload),
      product.isActive ?? true,
      product.sortOrder ?? 0,
      nullableText(product.shortDescription),
      badges,
      product.regularPrice ?? null,
      syncedAt,
    ],
  );

  const row = result.rows[0];
  await auditAdminEvent(
    context.config,
    request,
    "admin.ozon.create_storefront_product",
    "allowed",
    {
      previewId: parsed.previewId,
      productId: row.id,
      slug: row.slug,
      offerCount: offers.length,
    },
  );

  return {
    product: {
      id: row.id,
      designKey: row.design_key,
      slug: row.slug,
      name: row.name,
      sizes: stringArray(row.sizes),
      salePrice: toNumber(row.price_min) ?? null,
      priceMax: toNumber(row.price_max) ?? null,
      primaryImageUrl: row.primary_image_url,
      imageUrls: stringArray(row.image_urls),
      sizeChartJson: row.size_chart_json ?? null,
      offers: unknownArray(row.offers).filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      ),
      isActive: row.is_active,
      sortOrder: row.sort_order,
      updatedAt: row.updated_at,
    },
    linkedOzon: {
      itemIds: selected.map((item) => item.itemId),
      offerIds,
      skus,
      productIds,
    },
  };
}

export async function handleAdminLinkOzonStorefrontOffers(
  request: FastifyRequest,
  _reply: FastifyReply,
  context: OzonImportContext,
) {
  const parsed = linkStorefrontOffersRequestSchema.parse(request.body || {});
  const preview = await loadPreview(context.db, parsed.previewId);
  const selected = selectPreviewItems(safeJsonArray(preview.items), {
    itemIds: parsed.offerItemIds,
    offerIds: parsed.offerIds,
  });
  if (!selected.length) {
    throw new HttpError(
      400,
      "empty_offer_selection",
      "No Ozon preview items selected for offer linking",
    );
  }

  const syncedAt = new Date().toISOString();
  const updatePrices = parsed.updatePrices === true;
  const syncSizes = parsed.syncSizes ?? "add";
  const updates = await context.db.withTransaction(async (client) => {
    const applied: StorefrontUpdateResult[] = [];
    for (const item of selected) {
      const update = await applyStorefrontUpdate(
        client,
        {
          ...item,
          targetProduct: {
            id: parsed.productId,
            designKey: item.targetProduct?.designKey ?? "",
            slug: item.targetProduct?.slug ?? "",
            name: item.targetProduct?.name ?? "",
          },
          importOptions: {
            updatePrices,
            syncSizes,
          },
        },
        syncedAt,
      );
      if (update) applied.push(update);
    }
    return applied;
  });

  await auditAdminEvent(
    context.config,
    request,
    "admin.ozon.link_storefront_offers",
    "allowed",
    {
      previewId: parsed.previewId,
      productId: parsed.productId,
      offerCount: selected.length,
      applied: updates.length,
    },
  );

  return {
    productId: parsed.productId,
    linkedOzon: {
      itemIds: selected.map((item) => item.itemId),
      offerIds: selected
        .map((item) => item.offerId)
        .filter((item): item is string => item !== undefined),
      skus: selected
        .map((item) => item.sku)
        .filter((item): item is string => item !== undefined),
      productIds: selected
        .map((item) => item.productId)
        .filter((item): item is string => item !== undefined),
    },
    updatePrices,
    syncSizes,
    applied: updates.length,
    syncedAt,
  };
}

async function patchSupabase(
  settings: OzonImportEnv,
  patch: SupabasePatch,
  fetchImpl: typeof fetch,
) {
  if (!settings.supabaseUrl || !settings.supabaseServiceKey) {
    throw new HttpError(
      503,
      "supabase_not_configured",
      "Supabase service credentials are not configured",
    );
  }
  const url = new URL(
    `/rest/v1/${patch.table}?id=eq.${encodeURIComponent(String(patch.id))}`,
    settings.supabaseUrl,
  ).toString();
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: {
      apikey: settings.supabaseServiceKey,
      Authorization: `Bearer ${settings.supabaseServiceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch.patch),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpError(502, "supabase_write_failed", "Supabase write failed", {
      status: response.status,
      table: patch.table,
      body: body.slice(0, 500),
    });
  }
}

async function createJob(
  db: Db,
  previewId: string,
  requestPayload: unknown,
  idempotencyKey?: string,
) {
  const result = await db.query<{ id: string; existing: boolean }>(
    `
      with inserted as (
        insert into public.merch_admin_jobs
          (job_type, status, idempotency_key, preview_id, request_payload, started_at)
        values
          ('ozon_products_import', 'running', $1, $2, $3::jsonb, now())
        on conflict (job_type, idempotency_key)
          where idempotency_key is not null
        do nothing
        returning id, false as existing
      )
      select id, existing from inserted
      union all
      select id, true as existing
      from public.merch_admin_jobs
      where job_type = 'ozon_products_import'
        and idempotency_key = $1
        and $1 is not null
      limit 1
    `,
    [
      idempotencyKey || null,
      previewId,
      JSON.stringify(requestPayload),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(500, "job_create_failed", "Could not create import job");
  }
  return row;
}

async function finishJob(
  db: Db,
  jobId: string,
  status: "succeeded" | "failed",
  resultPayload: unknown,
  errors: unknown[],
  progressCurrent: number,
  progressTotal: number,
) {
  await db.query(
    `
      update public.merch_admin_jobs
      set
        status = $2,
        result_payload = $3::jsonb,
        errors = $4::jsonb,
        progress_current = $5,
        progress_total = $6,
        finished_at = now(),
        updated_at = now()
      where id = $1
    `,
    [
      jobId,
      status,
      JSON.stringify(resultPayload),
      JSON.stringify(errors),
      progressCurrent,
      progressTotal,
    ],
  );
}

async function getJob(db: Db, jobId: string) {
  const result = await db.query<JobRow>(
    `
      select
        id,
        job_type,
        status,
        preview_id,
        request_payload,
        result_payload,
        errors,
        progress_current,
        progress_total,
        created_at,
        started_at,
        finished_at,
        updated_at
      from public.merch_admin_jobs
      where id = $1
      limit 1
    `,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "job_not_found", "Import job not found");
  }
  return row;
}

function jobResponse(row: JobRow) {
  return {
    jobId: row.id,
    type: row.job_type,
    status: row.status,
    previewId: row.preview_id,
    progress: {
      current: row.progress_current,
      total: row.progress_total,
    },
    result: row.result_payload,
    errors: row.errors,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export async function handleOzonProductsImportPreview(
  request: FastifyRequest,
  _reply: FastifyReply,
  context: OzonImportContext,
) {
  const parsed = previewRequestSchema.parse(request.body || {});
  const targets = normalizeTargets(parsed.targets);
  const settings = await loadOzonImportEnv(context.config);
  const limit = Math.min(
    parsed.limit || context.config.OZON_IMPORT_MAX_ITEMS,
    context.config.OZON_IMPORT_MAX_ITEMS,
  );
  const fetchImpl = context.fetchImpl || fetch;

  const [ozonPriceItems, storefrontRows, merchRows] = await Promise.all([
    fetchOzonPriceItems(settings, limit, parsed.includeArchived === true, fetchImpl),
    loadStorefrontRows(context.db),
    loadMerchProductRows(context.db),
  ]);
  const ozonItems = await enrichOzonItemsWithProductInfo(
    settings,
    ozonPriceItems,
    fetchImpl,
  );
  const updatePrices = parsed.updatePrices === true;
  const syncSizes = parsed.syncSizes ?? "add";
  const preview = buildOzonPreview(
    ozonItems,
    storefrontRows,
    merchRows,
    targets,
    settings,
    { updatePrices, syncSizes },
  );
  const saved = await savePreview(
    context.db,
    {
      ...parsed,
      targets,
      limit,
      updatePrices,
      syncSizes,
    },
    preview,
  );

  await auditAdminEvent(
    context.config,
    request,
    "admin.ozon.import_preview",
    "allowed",
    {
      previewId: saved.id,
      totalOzonItems: preview.summary.totalOzonItems,
      matchedStorefront: preview.summary.matchedStorefront,
      unmatched: preview.summary.unmatched,
    },
  );

  return {
    previewId: saved.id,
    createdAt: saved.created_at,
    importType: "ozon_products",
    mode: {
      serverPostgres: targets.serverPostgres,
      supabaseRequested: targets.supabase,
      supabaseWriteEnabled: settings.supabaseWriteEnabled,
      ozonImportMode: settings.mode,
      updatePrices,
      syncSizes,
    },
    summary: preview.summary,
    canImport: preview.canImport,
    warnings: preview.warnings,
    items: preview.items,
    newProductGroups: preview.newProductGroups,
  };
}

export async function handleOzonProductsImport(
  request: FastifyRequest,
  _reply: FastifyReply,
  context: OzonImportContext,
) {
  const parsed = importRequestSchema.parse(request.body || {});
  const targets = normalizeTargets(parsed.targets);
  const preview = await loadPreview(context.db, parsed.previewId);
  const items = selectPreviewItems(safeJsonArray(preview.items), parsed);
  if (!items.length) {
    throw new HttpError(
      400,
      "empty_import_selection",
      "No preview items match import selection",
    );
  }
  if (!preview.can_import) {
    throw new HttpError(
      400,
      "preview_not_importable",
      "Preview does not contain importable actions",
    );
  }

  const idempotencyKeyHeader = request.headers["idempotency-key"];
  const idempotencyKey =
    typeof idempotencyKeyHeader === "string"
      ? idempotencyKeyHeader.trim()
      : undefined;
  const job = await createJob(context.db, preview.id, parsed, idempotencyKey);
  if (job.existing) {
    const row = await getJob(context.db, job.id);
    return jobResponse(row);
  }

  const settings = await loadOzonImportEnv(context.config);
  const fetchImpl = context.fetchImpl || fetch;
  const syncedAt = new Date().toISOString();
  const errors: unknown[] = [];
  const applied: AppliedUpdate[] = [];
  let skipped = 0;
  let supabasePatched = 0;
  let supabaseSkipped = 0;

  try {
    const transactionResult = await context.db.withTransaction(async (client) => {
      const updates: AppliedUpdate[] = [];
      for (const item of items) {
        const hasServerAction = item.plannedActions.some(
          (action) =>
            action.target === "serverPostgres" && action.action !== "skip",
        );
        if (!targets.serverPostgres || !hasServerAction) {
          skipped += 1;
          continue;
        }

        if (item.targetProduct?.id) {
          const update = await applyStorefrontUpdate(client, item, syncedAt);
          if (update) updates.push(update);
        } else if (item.targetMerchProduct?.id) {
          const update = await applyMerchProductUpdate(client, item, syncedAt);
          if (update) updates.push(update);
        } else {
          skipped += 1;
        }
      }
      return updates;
    });
    applied.push(...transactionResult);

    if (targets.supabase) {
      if (!settings.supabaseWriteEnabled) {
        supabaseSkipped = applied.length;
      } else {
        for (const update of applied) {
          await patchSupabase(
            settings,
            {
              table: update.table,
              id: update.id,
              patch: update.patch,
            },
            fetchImpl,
          );
          supabasePatched += 1;
        }
      }
    }

    const resultPayload = {
      appliedServerPostgres: applied.length,
      skipped,
      supabasePatched,
      supabaseSkipped,
      syncedAt,
    };
    await finishJob(
      context.db,
      job.id,
      "succeeded",
      resultPayload,
      errors,
      applied.length,
      items.length,
    );

    await auditAdminEvent(
      context.config,
      request,
      "admin.ozon.import",
      "allowed",
      {
        jobId: job.id,
        previewId: preview.id,
        appliedServerPostgres: applied.length,
        supabasePatched,
        supabaseSkipped,
      },
    );

    const row = await getJob(context.db, job.id);
    return jobResponse(row);
  } catch (error) {
    errors.push({
      message: error instanceof Error ? error.message : String(error),
    });
    await finishJob(
      context.db,
      job.id,
      "failed",
      {
        appliedServerPostgres: applied.length,
        skipped,
        supabasePatched,
        supabaseSkipped,
        syncedAt,
      },
      errors,
      applied.length,
      items.length,
    );
    throw error;
  }
}

export async function handleOzonImportJobStatus(
  request: FastifyRequest<{ Params: { jobId: string } }>,
  _reply: FastifyReply,
  context: OzonImportContext,
) {
  const row = await getJob(context.db, request.params.jobId);
  await auditAdminEvent(
    context.config,
    request,
    "admin.ozon.job_status",
    "allowed",
    {
      jobId: row.id,
      status: row.status,
    },
  );
  return jobResponse(row);
}

export function generateIdempotencyKey(payload: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
}

export function previewRequestFingerprint(payload: unknown) {
  return randomUUID() + ":" + generateIdempotencyKey(payload);
}
