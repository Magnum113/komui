import type { Db } from "./db";

const PUBLIC_PRODUCT_COLUMNS = `
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
  size_chart_json,
  offers,
  is_active,
  sort_order,
  short_description,
  badges,
  compare_at_price
`;

export type PublicOffer = {
  sku?: string | number;
  offer_id?: string;
  name?: string;
  size?: string;
  price?: number;
  images?: string[];
  primary_image?: string;
  archived?: boolean;
  visible?: boolean | null;
};

export type PublicProduct = {
  id: string;
  design_key: string;
  ozon_variant?: string;
  name: string;
  slug: string;
  description?: string | null;
  ozon_description?: string | null;
  category: string;
  category_slug: string;
  product_type: string;
  product_type_slug: string;
  decoration_type: string;
  decoration_slug: string;
  color_name?: string | null;
  color_slug?: string | null;
  color_hex?: string | null;
  franchise_type: string;
  title_name?: string | null;
  title_slug?: string | null;
  anime_title?: string | null;
  anime_slug?: string | null;
  character_name?: string | null;
  character_slug?: string | null;
  collection_name?: string | null;
  collection_slug?: string | null;
  design_name?: string | null;
  design_slug?: string | null;
  tags: string[];
  sizes: string[];
  price_min?: string | number | null;
  price_max?: string | number | null;
  currency: string;
  primary_image_url?: string | null;
  main_image_path?: string | null;
  image_urls: string[];
  size_chart_json?: unknown;
  offers: PublicOffer[];
  is_active: boolean;
  sort_order: number;
  short_description?: string | null;
  badges: string[];
  compare_at_price?: string | number | null;
};

type ProductRow = PublicProduct & {
  offers: unknown;
};

export function sanitizeOffer(value: unknown): PublicOffer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const offer = value as Record<string, unknown>;

  const sanitized: PublicOffer = {
    sku:
      typeof offer.sku === "string" || typeof offer.sku === "number"
        ? offer.sku
        : undefined,
    offer_id: typeof offer.offer_id === "string" ? offer.offer_id : undefined,
    name: typeof offer.name === "string" ? offer.name : undefined,
    size: typeof offer.size === "string" ? offer.size : undefined,
    price: typeof offer.price === "number" ? offer.price : undefined,
    images: Array.isArray(offer.images)
      ? offer.images.filter((item): item is string => typeof item === "string")
      : undefined,
    primary_image:
      typeof offer.primary_image === "string" ? offer.primary_image : undefined,
    archived: typeof offer.archived === "boolean" ? offer.archived : undefined,
    visible:
      typeof offer.visible === "boolean" || offer.visible === null
        ? offer.visible
        : undefined,
  };

  for (const key of Object.keys(sanitized) as Array<keyof PublicOffer>) {
    if (sanitized[key] === undefined) {
      delete sanitized[key];
    }
  }

  return sanitized;
}

export function sanitizeProduct(row: ProductRow): PublicProduct {
  const offers = Array.isArray(row.offers)
    ? row.offers
        .map(sanitizeOffer)
        .filter((item): item is PublicOffer => item !== null)
    : [];

  return {
    ...row,
    offers,
  };
}

export function normalizeLimit(value: unknown, fallback = 200, max = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

export class CatalogRepository {
  constructor(private readonly db: Db) {}

  async listActiveProducts(limit: number): Promise<PublicProduct[]> {
    const result = await this.db.query<ProductRow>(
      `
        select ${PUBLIC_PRODUCT_COLUMNS}
        from public.merch_storefront_products
        where is_active is true
        order by sort_order asc, id asc
        limit $1
      `,
      [limit],
    );

    return result.rows.map(sanitizeProduct);
  }

  async findActiveProductBySlug(slug: string): Promise<PublicProduct | null> {
    const result = await this.db.query<ProductRow>(
      `
        select ${PUBLIC_PRODUCT_COLUMNS}
        from public.merch_storefront_products
        where is_active is true
          and slug = $1
        limit 1
      `,
      [slug],
    );

    return result.rows[0] ? sanitizeProduct(result.rows[0]) : null;
  }

  async stats() {
    const result = await this.db.query<{
      active_products: string;
      products_with_offers: string;
    }>(
      `
        select
          count(*)::text as active_products,
          count(*) filter (where jsonb_array_length(offers) > 0)::text as products_with_offers
        from public.merch_storefront_products
        where is_active is true
      `,
    );

    return {
      activeProducts: Number(result.rows[0]?.active_products ?? 0),
      productsWithOffers: Number(result.rows[0]?.products_with_offers ?? 0),
    };
  }
}
