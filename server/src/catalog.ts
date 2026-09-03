import type { Db } from "./db";
import {
  resolvePublicMediaUrl,
  resolvePublicMediaUrls,
} from "./mediaManifest";
import {
  normalizeTshirtProductCopy,
  productFabricFactsFor,
} from "./productFabricFacts";

const PUBLIC_PRODUCT_COLUMNS = `
  p.id,
  p.design_key,
  p.ozon_variant,
  p.name,
  p.slug,
  p.description,
  p.ozon_description,
  p.category,
  p.category_slug,
  p.product_type,
  p.product_type_slug,
  p.decoration_type,
  p.decoration_slug,
  p.color_name,
  p.color_slug,
  p.color_hex,
  p.franchise_type,
  p.title_name,
  p.title_slug,
  p.anime_title,
  p.anime_slug,
  p.character_name,
  p.character_slug,
  p.collection_name,
  p.collection_slug,
  p.design_name,
  p.design_slug,
  p.tags,
  p.sizes,
  p.price_min,
  p.price_max,
  p.currency,
  p.primary_image_url,
  p.main_image_path,
  p.image_urls,
  p.size_chart_json,
  p.offers,
  p.is_active,
  p.sort_order,
  p.short_description,
  p.badges,
  p.compare_at_price,
  case
    when p.variant_group_key is not null
      and p.hoodie_fit_slug is not null
      and p.hoodie_fleece_slug is not null
    then jsonb_build_object(
      'group_key', p.variant_group_key,
      'fit', p.hoodie_fit_slug,
      'warmth', p.hoodie_fleece_slug
    )
    else null
  end as storefront_variant,
  coalesce(
    p.source_payload #> '{checkout,legacy_ambiguous_sizes}',
    '[]'::jsonb
  ) as requires_offer_id_sizes,
  coalesce(
    (
      select jsonb_agg(r.old_slug order by r.created_at asc, r.old_slug asc)
      from public.merch_storefront_product_slug_redirects r
      where r.product_id = p.id
    ),
    '[]'::jsonb
  ) as slug_redirects,
  (
    select jsonb_build_object(
      'count', count(*)::integer,
      'averageRating', round(avg(rv.rating)::numeric, 2),
      'withMedia', count(*) filter (where exists (
        select 1
        from public.merch_storefront_review_media rm
        where rm.review_id = rv.id
          and rm.processing_status = 'ready'
          and rm.moderation_status = 'approved'
          and not rm.is_suppressed
          and nullif(rm.public_url, '') is not null
      ))::integer,
      'ratingCounts', jsonb_build_object(
        '1', count(*) filter (where rv.rating = 1)::integer,
        '2', count(*) filter (where rv.rating = 2)::integer,
        '3', count(*) filter (where rv.rating = 3)::integer,
        '4', count(*) filter (where rv.rating = 4)::integer,
        '5', count(*) filter (where rv.rating = 5)::integer
      )
    )
    from public.merch_storefront_reviews rv
    where rv.storefront_product_id = p.id
      and rv.is_published
      and rv.moderation_status = 'approved'
      and rv.mapping_status = 'matched'
  ) as review_summary
`;

const YANDEX_FEED_PRODUCT_COLUMNS = `
  p.id,
  p.name,
  p.slug,
  p.category,
  p.category_slug,
  p.product_type,
  p.decoration_type,
  p.color_name,
  p.title_name,
  p.title_slug,
  p.collection_name,
  p.collection_slug,
  p.design_name,
  p.sizes,
  p.price_min,
  p.currency,
  p.primary_image_url,
  p.main_image_path,
  p.image_urls,
  p.is_active,
  p.sort_order,
  p.compare_at_price
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
  fabric_composition?: string;
  fabric_density_gsm?: number;
  storefront_variant?: PublicStorefrontVariant;
  requires_offer_id_sizes: string[];
  slug_redirects?: string[];
  review_summary: PublicReviewSummary;
};

export type PublicStorefrontVariant = {
  group_key: string;
  fit: "regular" | "cropped";
  warmth: "fleece" | "no-fleece";
};

export type PublicReviewSummary = {
  count: number;
  averageRating: number | null;
  withMedia: number;
  ratingCounts: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
};

export type YandexFeedProduct = {
  id: string;
  name: string;
  slug: string;
  category: string;
  category_slug: string;
  product_type: string;
  decoration_type: string;
  color_name?: string | null;
  title_name?: string | null;
  title_slug?: string | null;
  collection_name?: string | null;
  collection_slug?: string | null;
  design_name?: string | null;
  sizes: string[];
  price_min?: string | number | null;
  currency: string;
  primary_image_url?: string | null;
  main_image_path?: string | null;
  image_urls: string[];
  is_active: boolean;
  sort_order: number;
  compare_at_price?: string | number | null;
};

type ProductRow = Omit<
  PublicProduct,
  "offers" | "storefront_variant" | "requires_offer_id_sizes" | "review_summary"
> & {
  offers: unknown;
  storefront_variant?: unknown;
  requires_offer_id_sizes?: unknown;
  slug_redirects?: unknown;
  review_summary?: unknown;
};

type YandexFeedProductRow = Omit<
  YandexFeedProduct,
  "sizes" | "image_urls"
> & {
  sizes: unknown;
  image_urls: unknown;
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

function sanitizeStorefrontVariant(value: unknown): PublicStorefrontVariant | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const groupKey = typeof candidate.group_key === "string"
    ? candidate.group_key.trim()
    : "";
  const fit = candidate.fit;
  const warmth = candidate.warmth;

  if (
    !groupKey ||
    groupKey.length > 200 ||
    (fit !== "regular" && fit !== "cropped") ||
    (warmth !== "fleece" && warmth !== "no-fleece")
  ) {
    return undefined;
  }

  return { group_key: groupKey, fit, warmth };
}

function sanitizeRequiredOfferIdSizes(value: unknown, productSizes: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const availableSizes = Array.isArray(productSizes)
    ? productSizes
        .filter((size): size is string => typeof size === "string")
        .map((size) => size.trim().toUpperCase())
        .filter(Boolean)
    : [];
  const requestedSizes = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") continue;
    const size = item.trim().toUpperCase();
    if (size && size.length <= 32) requestedSizes.add(size);
  }
  return [...new Set(availableSizes)].filter((size) => requestedSizes.has(size));
}

export function sanitizeProduct(row: ProductRow): PublicProduct {
  const offers = Array.isArray(row.offers)
    ? row.offers
        .map(sanitizeOffer)
        .filter((item): item is PublicOffer => item !== null)
    : [];
  const slugRedirects = Array.isArray(row.slug_redirects)
    ? row.slug_redirects.filter((item): item is string => typeof item === "string")
    : [];
  const rawReviewSummary = row.review_summary && typeof row.review_summary === "object"
    ? row.review_summary as Record<string, unknown>
    : {};
  const reviewCount = Math.max(0, Number(rawReviewSummary.count) || 0);
  const reviewAverage = Number(rawReviewSummary.averageRating);
  const reviewsWithMedia = Math.max(0, Number(rawReviewSummary.withMedia) || 0);
  const rawRatingCounts = rawReviewSummary.ratingCounts
    && typeof rawReviewSummary.ratingCounts === "object"
    && !Array.isArray(rawReviewSummary.ratingCounts)
    ? rawReviewSummary.ratingCounts as Record<string, unknown>
    : {};
  const ratingCounts = {
    1: Math.max(0, Number(rawRatingCounts["1"]) || 0),
    2: Math.max(0, Number(rawRatingCounts["2"]) || 0),
    3: Math.max(0, Number(rawRatingCounts["3"]) || 0),
    4: Math.max(0, Number(rawRatingCounts["4"]) || 0),
    5: Math.max(0, Number(rawRatingCounts["5"]) || 0),
  };
  const storefrontVariant = sanitizeStorefrontVariant(row.storefront_variant);
  const requiresOfferIdSizes = sanitizeRequiredOfferIdSizes(
    row.requires_offer_id_sizes,
    row.sizes,
  );

  const product: PublicProduct = {
    ...row,
    offers,
    storefront_variant: storefrontVariant,
    requires_offer_id_sizes: requiresOfferIdSizes,
    slug_redirects: slugRedirects,
    review_summary: {
      count: reviewCount,
      averageRating: Number.isFinite(reviewAverage) && reviewCount > 0
        ? Math.max(1, Math.min(5, reviewAverage))
        : null,
      withMedia: Math.min(reviewCount, reviewsWithMedia),
      ratingCounts,
    },
  };
  const productRecord = product as PublicProduct & Record<string, unknown>;
  delete productRecord.source_payload;
  delete productRecord.variant_group_key;
  delete productRecord.hoodie_fit_slug;
  delete productRecord.hoodie_fleece_slug;
  const fabricFacts = productFabricFactsFor(product);

  return {
    ...product,
    ...(fabricFacts
      ? {
          fabric_composition: fabricFacts.composition,
          fabric_density_gsm: fabricFacts.densityGsm,
        }
      : {}),
    description: normalizeTshirtProductCopy(product, product.description),
    ozon_description: normalizeTshirtProductCopy(product, product.ozon_description),
    short_description: normalizeTshirtProductCopy(product, product.short_description),
    primary_image_url: resolvePublicMediaUrl(product.primary_image_url) as
      | string
      | null
      | undefined,
    main_image_path: resolvePublicMediaUrl(product.main_image_path) as
      | string
      | null
      | undefined,
    image_urls: resolvePublicMediaUrls(product.image_urls),
    offers: product.offers.map((offer) => ({
      ...offer,
      primary_image: resolvePublicMediaUrl(offer.primary_image) as
        | string
        | undefined,
      images: offer.images ? resolvePublicMediaUrls(offer.images) : undefined,
    })),
  };
}

export function sanitizeYandexFeedProduct(
  row: YandexFeedProductRow,
): YandexFeedProduct {
  return {
    ...row,
    sizes: Array.isArray(row.sizes)
      ? row.sizes.filter((item): item is string => typeof item === "string")
      : [],
    primary_image_url: resolvePublicMediaUrl(row.primary_image_url) as
      | string
      | null
      | undefined,
    main_image_path: resolvePublicMediaUrl(row.main_image_path) as
      | string
      | null
      | undefined,
    image_urls: resolvePublicMediaUrls(row.image_urls),
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
        from public.merch_storefront_products p
        where p.is_active is true
        order by p.sort_order asc, p.id asc
        limit $1
      `,
      [limit],
    );

    return result.rows.map(sanitizeProduct);
  }

  async listActiveProductsForYandexFeed(): Promise<YandexFeedProduct[]> {
    const result = await this.db.query<YandexFeedProductRow>(
      `
        select ${YANDEX_FEED_PRODUCT_COLUMNS}
        from public.merch_storefront_products p
        where p.is_active is true
        order by p.sort_order asc, p.id asc
      `,
    );

    return result.rows.map(sanitizeYandexFeedProduct);
  }

  async findActiveProductBySlug(slug: string): Promise<PublicProduct | null> {
    const result = await this.db.query<ProductRow>(
      `
        select ${PUBLIC_PRODUCT_COLUMNS}
        from public.merch_storefront_products p
        where p.is_active is true
          and (
            p.slug = $1
            or exists (
              select 1
              from public.merch_storefront_product_slug_redirects r
              where r.product_id = p.id
                and r.old_slug = $1
            )
          )
        order by case when p.slug = $1 then 0 else 1 end
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
