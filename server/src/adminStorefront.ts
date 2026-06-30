import type { FastifyReply, FastifyRequest } from "fastify";
import type { QueryResultRow } from "pg";
import { z } from "zod";
import { auditAdminEvent } from "./audit";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { HttpError } from "./errors";

const ADMIN_PRODUCT_COLUMNS = `
  id,
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
  offers,
  is_active,
  sort_order,
  short_description,
  badges,
  compare_at_price,
  updated_at
`;

const priceSchema = z.coerce.number().positive().max(1_000_000);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  q: z.string().trim().max(120).optional(),
  active: z
    .enum(["all", "true", "false", "active", "inactive"])
    .default("all"),
});

const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).nullable().optional(),
    shortDescription: z.string().max(1_000).nullable().optional(),
    salePrice: priceSchema.optional(),
    regularPrice: priceSchema.nullable().optional(),
    sizes: z.array(z.string().trim().min(1).max(32)).min(1).max(30).optional(),
    imageUrls: z
      .array(z.string().trim().min(1).max(2_048))
      .min(1)
      .max(60)
      .optional(),
    mainImagePath: z.string().trim().min(1).max(2_048).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(1_000_000).optional(),
    syncOfferPrices: z.boolean().optional(),
  })
  .strict();

const productIdSchema = z.string().uuid();

type UpdatePayload = z.infer<typeof updateProductSchema>;

type AdminStorefrontContext = {
  config: AppConfig;
  db: Db;
};

type AdminOffer = {
  sku?: string | number;
  offerId?: string;
  name?: string;
  size?: string;
  price?: number;
  images?: string[];
  primaryImage?: string;
  archived?: boolean;
  visible?: boolean | null;
};

export type AdminStorefrontProductRow = QueryResultRow & {
  id: string;
  design_key: string;
  ozon_variant: string | null;
  name: string;
  slug: string;
  description: string | null;
  ozon_description: string | null;
  category: string;
  category_slug: string;
  product_type: string;
  product_type_slug: string;
  decoration_type: string;
  decoration_slug: string;
  color_name: string | null;
  color_slug: string | null;
  color_hex: string | null;
  franchise_type: string;
  title_name: string | null;
  title_slug: string | null;
  anime_title: string | null;
  anime_slug: string | null;
  character_name: string | null;
  character_slug: string | null;
  collection_name: string | null;
  collection_slug: string | null;
  design_name: string | null;
  design_slug: string | null;
  tags: unknown;
  sizes: unknown;
  price_min: string | number | null;
  price_max: string | number | null;
  currency: string;
  primary_image_url: string | null;
  main_image_path: string | null;
  image_urls: unknown;
  offers: unknown;
  is_active: boolean;
  sort_order: number;
  short_description: string | null;
  badges: unknown;
  compare_at_price: string | number | null;
  updated_at: Date | string | null;
};

export type AdminStorefrontProduct = {
  id: string;
  designKey: string;
  ozonVariant: string | null;
  name: string;
  slug: string;
  description: string | null;
  shortDescription: string | null;
  ozonDescription: string | null;
  category: string;
  categorySlug: string;
  productType: string;
  productTypeSlug: string;
  decorationType: string;
  decorationSlug: string;
  colorName: string | null;
  colorSlug: string | null;
  colorHex: string | null;
  franchiseType: string;
  titleName: string | null;
  titleSlug: string | null;
  animeTitle: string | null;
  animeSlug: string | null;
  characterName: string | null;
  characterSlug: string | null;
  collectionName: string | null;
  collectionSlug: string | null;
  designName: string | null;
  designSlug: string | null;
  tags: string[];
  sizes: string[];
  salePrice: number | null;
  priceMax: number | null;
  regularPrice: number | null;
  currency: string;
  primaryImageUrl: string | null;
  mainImagePath: string | null;
  imageUrls: string[];
  offers: AdminOffer[];
  isActive: boolean;
  sortOrder: number;
  badges: string[];
  updatedAt: string | null;
};

type UpdateValue = {
  field: string;
  column: string;
  value: unknown;
  cast?: "::jsonb" | "::text[]";
};

export type StorefrontProductUpdatePlan = {
  updates: UpdateValue[];
  changedFields: string[];
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function offerArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isoDate(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

function uniqueOrdered(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function normalizeSizes(values: string[]) {
  const sizes = uniqueOrdered(
    values
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  if (!sizes.length) {
    throw new HttpError(400, "invalid_sizes", "At least one size is required");
  }
  return sizes;
}

function normalizeImageUrls(values: string[]) {
  const imageUrls = uniqueOrdered(values.map((value) => value.trim()).filter(Boolean));
  if (!imageUrls.length) {
    throw new HttpError(400, "invalid_images", "At least one image is required");
  }
  return imageUrls;
}

function sameStringArray(current: string[], next: string[]) {
  return current.length === next.length && current.every((item, index) => item === next[index]);
}

function sameNullableNumber(current: unknown, next: number | null) {
  const currentNumber = nullableNumber(current);
  if (currentNumber === null || next === null) return currentNumber === next;
  return Math.abs(currentNumber - next) < 0.0001;
}

function sameJson(current: unknown, next: unknown) {
  return JSON.stringify(current) === JSON.stringify(next);
}

function addUpdate(
  updates: UpdateValue[],
  field: string,
  column: string,
  current: unknown,
  next: unknown,
  cast?: UpdateValue["cast"],
) {
  const changed = Array.isArray(current) && Array.isArray(next)
    ? !sameStringArray(stringArray(current), stringArray(next))
    : current !== next;
  if (!changed) return;
  updates.push({ field, column, value: next, cast });
}

function addNumberUpdate(
  updates: UpdateValue[],
  field: string,
  column: string,
  current: unknown,
  next: number | null,
) {
  if (sameNullableNumber(current, next)) return;
  updates.push({ field, column, value: next });
}

function sanitizedOffer(value: Record<string, unknown>): AdminOffer {
  const result: AdminOffer = {};
  if (typeof value.sku === "string" || typeof value.sku === "number") {
    result.sku = value.sku;
  }
  if (typeof value.offer_id === "string") result.offerId = value.offer_id;
  if (typeof value.name === "string") result.name = value.name;
  if (typeof value.size === "string") result.size = value.size;
  if (typeof value.price === "number") result.price = value.price;
  if (typeof value.price === "string" && Number.isFinite(Number(value.price))) {
    result.price = Number(value.price);
  }
  if (Array.isArray(value.images)) {
    result.images = value.images.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (typeof value.primary_image === "string") {
    result.primaryImage = value.primary_image;
  }
  if (typeof value.archived === "boolean") result.archived = value.archived;
  if (typeof value.visible === "boolean" || value.visible === null) {
    result.visible = value.visible;
  }
  return result;
}

function syncOfferPrices(
  offers: Array<Record<string, unknown>>,
  salePrice: number,
) {
  return offers.map((offer) =>
    offer.archived === true ? offer : { ...offer, price: salePrice },
  );
}

function syncOfferVisibilityForSizes(
  offers: Array<Record<string, unknown>>,
  sizes: string[],
) {
  const availableSizes = new Set(sizes.map((size) => size.toUpperCase()));
  return offers.map((offer) => {
    if (typeof offer.size !== "string" || !offer.size.trim()) return offer;
    const available = availableSizes.has(offer.size.trim().toUpperCase());
    if (available && offer.visible === false) return { ...offer, visible: true };
    if (!available && offer.visible !== false) return { ...offer, visible: false };
    return offer;
  });
}

function parseActiveFilter(active: z.infer<typeof listQuerySchema>["active"]) {
  if (active === "true" || active === "active") return true;
  if (active === "false" || active === "inactive") return false;
  return null;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (item) => `\\${item}`);
}

function productIdFromRequest(request: FastifyRequest) {
  const params = request.params as { productId?: unknown };
  return productIdSchema.parse(params.productId);
}

export function toAdminStorefrontProduct(
  row: AdminStorefrontProductRow,
): AdminStorefrontProduct {
  return {
    id: row.id,
    designKey: row.design_key,
    ozonVariant: row.ozon_variant,
    name: row.name,
    slug: row.slug,
    description: row.description,
    shortDescription: row.short_description,
    ozonDescription: row.ozon_description,
    category: row.category,
    categorySlug: row.category_slug,
    productType: row.product_type,
    productTypeSlug: row.product_type_slug,
    decorationType: row.decoration_type,
    decorationSlug: row.decoration_slug,
    colorName: row.color_name,
    colorSlug: row.color_slug,
    colorHex: row.color_hex,
    franchiseType: row.franchise_type,
    titleName: row.title_name,
    titleSlug: row.title_slug,
    animeTitle: row.anime_title,
    animeSlug: row.anime_slug,
    characterName: row.character_name,
    characterSlug: row.character_slug,
    collectionName: row.collection_name,
    collectionSlug: row.collection_slug,
    designName: row.design_name,
    designSlug: row.design_slug,
    tags: stringArray(row.tags),
    sizes: stringArray(row.sizes),
    salePrice: nullableNumber(row.price_min),
    priceMax: nullableNumber(row.price_max),
    regularPrice: nullableNumber(row.compare_at_price),
    currency: row.currency,
    primaryImageUrl: row.primary_image_url,
    mainImagePath: row.main_image_path,
    imageUrls: stringArray(row.image_urls),
    offers: offerArray(row.offers).map(sanitizedOffer),
    isActive: row.is_active,
    sortOrder: row.sort_order,
    badges: stringArray(row.badges),
    updatedAt: isoDate(row.updated_at),
  };
}

export function planStorefrontProductUpdate(
  row: AdminStorefrontProductRow,
  rawPayload: unknown,
): StorefrontProductUpdatePlan {
  const payload = updateProductSchema.parse(rawPayload);
  const editableKeys = Object.keys(payload).filter(
    (key) => key !== "syncOfferPrices",
  );
  if (!editableKeys.length) {
    throw new HttpError(400, "empty_update", "No editable fields provided");
  }

  const updates: UpdateValue[] = [];
  let nextOffers = offerArray(row.offers);
  let offersTouched = false;

  if (payload.name !== undefined) {
    addUpdate(updates, "name", "name", row.name, payload.name);
  }

  const description = nullableText(payload.description);
  if (description !== undefined) {
    addUpdate(
      updates,
      "description",
      "description",
      row.description,
      description,
    );
  }

  const shortDescription = nullableText(payload.shortDescription);
  if (shortDescription !== undefined) {
    addUpdate(
      updates,
      "shortDescription",
      "short_description",
      row.short_description,
      shortDescription,
    );
  }

  const salePrice =
    payload.salePrice !== undefined ? payload.salePrice : nullableNumber(row.price_min);
  if (
    payload.regularPrice !== undefined &&
    payload.regularPrice !== null &&
    salePrice !== null &&
    payload.regularPrice <= salePrice
  ) {
    throw new HttpError(
      400,
      "invalid_regular_price",
      "regularPrice must be greater than salePrice or null",
    );
  }

  if (payload.salePrice !== undefined) {
    addNumberUpdate(updates, "salePrice", "price_min", row.price_min, payload.salePrice);
    addNumberUpdate(updates, "priceMax", "price_max", row.price_max, payload.salePrice);
    if (payload.syncOfferPrices !== false) {
      nextOffers = syncOfferPrices(nextOffers, payload.salePrice);
      offersTouched = true;
    }
  }

  if (payload.regularPrice !== undefined) {
    addNumberUpdate(
      updates,
      "regularPrice",
      "compare_at_price",
      row.compare_at_price,
      payload.regularPrice,
    );
  }

  if (payload.sizes !== undefined) {
    const sizes = normalizeSizes(payload.sizes);
    addUpdate(updates, "sizes", "sizes", stringArray(row.sizes), sizes, "::text[]");
    nextOffers = syncOfferVisibilityForSizes(nextOffers, sizes);
    offersTouched = true;
  }

  if (payload.imageUrls !== undefined) {
    const imageUrls = normalizeImageUrls(payload.imageUrls);
    const firstImage = imageUrls[0] ?? null;
    addUpdate(
      updates,
      "imageUrls",
      "image_urls",
      stringArray(row.image_urls),
      imageUrls,
      "::text[]",
    );
    addUpdate(
      updates,
      "primaryImageUrl",
      "primary_image_url",
      row.primary_image_url,
      firstImage,
    );
    const mainImagePath =
      payload.mainImagePath !== undefined
        ? nullableText(payload.mainImagePath)
        : firstImage;
    addUpdate(
      updates,
      "mainImagePath",
      "main_image_path",
      row.main_image_path,
      mainImagePath,
    );
  } else if (payload.mainImagePath !== undefined) {
    addUpdate(
      updates,
      "mainImagePath",
      "main_image_path",
      row.main_image_path,
      nullableText(payload.mainImagePath),
    );
  }

  if (payload.isActive !== undefined) {
    addUpdate(
      updates,
      "isActive",
      "is_active",
      row.is_active,
      payload.isActive,
    );
  }

  if (payload.sortOrder !== undefined) {
    addUpdate(
      updates,
      "sortOrder",
      "sort_order",
      row.sort_order,
      payload.sortOrder,
    );
  }

  if (offersTouched && !sameJson(offerArray(row.offers), nextOffers)) {
    updates.push({
      field: "offers",
      column: "offers",
      value: nextOffers,
      cast: "::jsonb",
    });
  }

  return {
    updates,
    changedFields: updates.map((update) => update.field),
  };
}

async function loadProductForUpdate(db: Db, productId: string) {
  const result = await db.query<AdminStorefrontProductRow>(
    `
      select ${ADMIN_PRODUCT_COLUMNS}
      from public.merch_storefront_products
      where id = $1
      limit 1
    `,
    [productId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "product_not_found", "Storefront product not found");
  }
  return row;
}

export async function handleAdminListStorefrontProducts(
  request: FastifyRequest,
  _reply: FastifyReply,
  { db }: AdminStorefrontContext,
) {
  const query = listQuerySchema.parse(request.query);
  const activeFilter = parseActiveFilter(query.active);
  const search = query.q ? `%${escapeLike(query.q)}%` : null;
  const params = [activeFilter, search, query.limit, query.offset];
  const whereSql = `
    where ($1::boolean is null or is_active = $1)
      and (
        $2::text is null
        or name ilike $2 escape '\\'
        or slug ilike $2 escape '\\'
        or design_key ilike $2 escape '\\'
        or coalesce(collection_name, '') ilike $2 escape '\\'
        or coalesce(title_name, '') ilike $2 escape '\\'
        or coalesce(character_name, '') ilike $2 escape '\\'
      )
  `;

  const [rowsResult, countResult] = await Promise.all([
    db.query<AdminStorefrontProductRow>(
      `
        select ${ADMIN_PRODUCT_COLUMNS}
        from public.merch_storefront_products
        ${whereSql}
        order by sort_order asc, name asc, id asc
        limit $3
        offset $4
      `,
      params,
    ),
    db.query<{ total: string }>(
      `
        select count(*)::text as total
        from public.merch_storefront_products
        ${whereSql}
      `,
      [activeFilter, search],
    ),
  ]);

  return {
    products: rowsResult.rows.map(toAdminStorefrontProduct),
    pagination: {
      limit: query.limit,
      offset: query.offset,
      total: Number(countResult.rows[0]?.total ?? 0),
    },
  };
}

export async function handleAdminGetStorefrontProduct(
  request: FastifyRequest,
  _reply: FastifyReply,
  { db }: AdminStorefrontContext,
) {
  const productId = productIdFromRequest(request);
  const row = await loadProductForUpdate(db, productId);
  return { product: toAdminStorefrontProduct(row) };
}

export async function handleAdminUpdateStorefrontProduct(
  request: FastifyRequest,
  _reply: FastifyReply,
  { config, db }: AdminStorefrontContext,
) {
  const productId = productIdFromRequest(request);
  const result = await db.withTransaction(async (client) => {
    const currentResult = await client.query<AdminStorefrontProductRow>(
      `
        select ${ADMIN_PRODUCT_COLUMNS}
        from public.merch_storefront_products
        where id = $1
        for update
      `,
      [productId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new HttpError(404, "product_not_found", "Storefront product not found");
    }

    const plan = planStorefrontProductUpdate(current, request.body);
    if (!plan.updates.length) {
      return {
        product: toAdminStorefrontProduct(current),
        changedFields: [],
      };
    }

    const values: unknown[] = [productId];
    const assignments = plan.updates.map((update) => {
      values.push(update.cast === "::jsonb" ? JSON.stringify(update.value) : update.value);
      return `${update.column} = $${values.length}${update.cast ?? ""}`;
    });

    const updatedResult = await client.query<AdminStorefrontProductRow>(
      `
        update public.merch_storefront_products
        set
          ${assignments.join(",\n          ")},
          updated_at = now()
        where id = $1
        returning ${ADMIN_PRODUCT_COLUMNS}
      `,
      values,
    );
    const updated = updatedResult.rows[0];
    if (!updated) {
      throw new HttpError(404, "product_not_found", "Storefront product not found");
    }

    return {
      product: toAdminStorefrontProduct(updated),
      changedFields: plan.changedFields,
    };
  });

  await auditAdminEvent(
    config,
    request,
    "admin.storefront_product.update",
    "allowed",
    {
      productId,
      changedFields: result.changedFields,
    },
  ).catch(() => undefined);

  return result;
}
