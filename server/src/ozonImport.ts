import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { auditAdminEvent } from "./audit";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { HttpError } from "./errors";

const OZON_PRICE_PATH = "/v5/product/info/prices";
const OZON_DEFAULT_BASE_URL = "https://api-seller.ozon.ru";

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
    targets: targetSchema.optional(),
  })
  .default({});

const importRequestSchema = z.object({
  previewId: z.string().uuid(),
  confirm: z.literal(true),
  targets: targetSchema.optional(),
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
};

type StorefrontRow = {
  id: string;
  design_key: string;
  name: string;
  slug: string;
  price_min: string | number | null;
  price_max: string | number | null;
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
  price?: number;
  oldPrice?: number;
  minPrice?: number;
  visible?: boolean | null;
  archived?: boolean;
  matchReason?: string;
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
    action: "update_storefront_offer" | "update_merch_product_price" | "skip";
    reason?: string;
  }>;
};

type PreviewBuildResult = {
  summary: {
    totalOzonItems: number;
    matchedStorefront: number;
    matchedMerchProducts: number;
    unmatched: number;
    actionableServerPostgres: number;
    actionableSupabase: number;
    noop: number;
  };
  canImport: boolean;
  warnings: Array<{ code: string; message: string; count?: number }>;
  items: OzonPreviewItem[];
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

export function designKeyCandidatesFromOfferId(value: unknown): string[] {
  const normalized = normalizeOfferId(value);
  if (!normalized) return [];

  const candidates = new Set<string>();
  const modern = /^D(\d+)-([A-Z]+)-([A-Z]+)-([A-Z]+)(?:-|$)/.exec(
    normalized,
  );
  if (modern) {
    const [, designNumber, productCode, decorationCode, colorCode] = modern;
    const product = PRODUCT_CODE_TO_SLUG[productCode];
    const decoration = DECORATION_CODE_TO_SLUG[decorationCode];
    const color = COLOR_CODE_TO_SLUG[colorCode];
    if (product && decoration && color) {
      candidates.add(`var${Number(designNumber)}|${decoration}|${product}|${color}`);
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
      candidates.add(`${design}|${decoration}|${product}|${color}`);
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

function addUniqueString(values: string[], value: unknown) {
  const text = toStringId(value);
  if (text && !values.includes(text)) values.push(text);
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

export function buildOzonPreview(
  ozonItems: OzonPriceItem[],
  storefrontRows: StorefrontRow[],
  merchRows: MerchProductRow[],
  targets: Targets,
  settings: Pick<OzonImportEnv, "supabaseWriteEnabled"> = {
    supabaseWriteEnabled: false,
  },
): PreviewBuildResult {
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

    if (storefrontMatch) {
      matchedStorefront += 1;
      if (targets.serverPostgres) {
        plannedActions.push({
          target: "serverPostgres",
          action: "update_storefront_offer",
        });
        actionableServerPostgres += 1;
      }
      if (targets.supabase) {
        if (settings.supabaseWriteEnabled) {
          plannedActions.push({
            target: "supabase",
            action: "update_storefront_offer",
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
        plannedActions.push({
          target: "serverPostgres",
          action: "update_merch_product_price",
        });
        actionableServerPostgres += 1;
      }
      if (targets.supabase) {
        if (settings.supabaseWriteEnabled) {
          plannedActions.push({
            target: "supabase",
            action: "update_merch_product_price",
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
        reason: "unmatched_requires_mapping",
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

    if (!plannedActions.some((action) => action.action !== "skip")) {
      noop += 1;
    }

    items.push({
      itemId,
      status: storefrontMatch || merchMatch ? "matched" : "unmatched",
      severity: storefrontMatch || merchMatch ? "info" : "warning",
      offerId: offerIdForDisplay(ozonItem.offer_id),
      normalizedOfferId,
      productId: toStringId(ozonItem.product_id),
      sku: toStringId(ozonItem.sku),
      name: toStringId(ozonItem.name),
      price,
      oldPrice,
      minPrice,
      visible:
        typeof ozonItem.visible === "boolean" || ozonItem.visible === null
          ? ozonItem.visible
          : undefined,
      archived:
        typeof ozonItem.archived === "boolean" ? ozonItem.archived : undefined,
      matchReason: storefrontMatch?.reason || merchMatch?.reason,
      targetProduct: storefrontMatch ? productKey(storefrontMatch.row) : undefined,
      targetMerchProduct: merchMatch ? merchProductKey(merchMatch.row) : undefined,
      plannedActions,
    });
  }

  const warnings: PreviewBuildResult["warnings"] = [];
  if (unmatched > 0) {
    warnings.push({
      code: "unmatched_requires_mapping",
      message:
        "Часть Ozon-позиций не сопоставлена с карточками сайта; они будут пропущены до настройки маппинга.",
      count: unmatched,
    });
  }
  if (targets.supabase && !settings.supabaseWriteEnabled) {
    warnings.push({
      code: "supabase_write_disabled",
      message:
        "Запись в Supabase отключена на сервере флагом OZON_IMPORT_WRITE_SUPABASE=false.",
    });
  }

  const summary = {
    totalOzonItems: ozonItems.length,
    matchedStorefront,
    matchedMerchProducts,
    unmatched,
    actionableServerPostgres,
    actionableSupabase,
    noop,
  };

  return {
    summary,
    canImport: actionableServerPostgres > 0 || actionableSupabase > 0,
    warnings,
    items,
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

  return items.slice(0, limit);
}

async function loadStorefrontRows(db: Db) {
  const result = await db.query<StorefrontRow>(
    `
      select
        id,
        design_key,
        name,
        slug,
        price_min,
        price_max,
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
  item: OzonPreviewItem,
  syncedAt: string,
) {
  const nextOffers = currentOffers.map((offer) => ({ ...offer }));
  const index = nextOffers.findIndex((offer) => {
    const offerId = normalizeOfferId(offer.offer_id);
    if (offerId && item.normalizedOfferId && offerId === item.normalizedOfferId) {
      return true;
    }
    const sku = toStringId(offer.sku);
    if (sku && item.sku && sku === item.sku) return true;
    const productId = toStringId(offer.product_id);
    return Boolean(productId && item.productId && productId === item.productId);
  });

  const patch: Record<string, unknown> = {
    offer_id: item.offerId,
    product_id: toNumericId(item.productId) ?? item.productId,
    sku: toNumericId(item.sku) ?? item.sku,
    name: item.name,
    price: item.price,
    old_price: item.oldPrice,
    min_price: item.minPrice,
    visible: item.visible,
    archived: item.archived,
    last_ozon_sync_at: syncedAt,
  };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete patch[key];
  }

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
        price_min,
        price_max,
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
  const offerIds = addUniqueString(stringArray(row.ozon_offer_ids), item.offerId);
  const offers = mergeOffer(getOfferArray(row), item, syncedAt);
  const priceRange = priceRangeFromOffers(offers, row.price_min, row.price_max);
  const patch = {
    ozon_product_ids: productIds,
    ozon_skus: skus,
    ozon_offer_ids: offerIds,
    offers,
    price_min: priceRange.min,
    price_max: priceRange.max,
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
        price_min = $6,
        price_max = $7,
        updated_at = $8::timestamptz
      where id = $1
    `,
    [
      row.id,
      productIds,
      skus,
      offerIds,
      JSON.stringify(offers),
      priceRange.min,
      priceRange.max,
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

  const [ozonItems, storefrontRows, merchRows] = await Promise.all([
    fetchOzonPriceItems(settings, limit, parsed.includeArchived === true, fetchImpl),
    loadStorefrontRows(context.db),
    loadMerchProductRows(context.db),
  ]);
  const preview = buildOzonPreview(
    ozonItems,
    storefrontRows,
    merchRows,
    targets,
    settings,
  );
  const saved = await savePreview(
    context.db,
    {
      ...parsed,
      targets,
      limit,
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
    },
    summary: preview.summary,
    canImport: preview.canImport,
    warnings: preview.warnings,
    items: preview.items,
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
  const items = safeJsonArray(preview.items);
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
