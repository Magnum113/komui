import type { Db } from "./db";
import { HttpError } from "./errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReviewCursor = {
  publishedAt: string;
  id: string;
};

type ReviewMediaRow = {
  id?: unknown;
  type?: unknown;
  url?: unknown;
  previewUrl?: unknown;
  mimeType?: unknown;
  width?: unknown;
  height?: unknown;
  durationMs?: unknown;
  sortOrder?: unknown;
};

type ReviewRow = {
  id: string;
  source: string;
  author_display_name: string;
  rating: number;
  review_text: string | null;
  published_at: string | Date;
  is_verified_purchase: boolean;
  media: unknown;
};

type ReviewSummaryRow = {
  review_count: string;
  average_rating: string | null;
  rating_1: string;
  rating_2: string;
  rating_3: string;
  rating_4: string;
  rating_5: string;
  reviews_with_media: string;
  reviews_with_text: string;
};

export type PublicReviewMedia = {
  id: string;
  type: "image" | "video";
  url: string;
  previewUrl: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sortOrder: number;
};

export type PublicReview = {
  id: string;
  source: "ozon" | "manual" | "komui";
  sourceLabel: string;
  author: string;
  rating: number;
  text: string | null;
  publishedAt: string;
  verifiedPurchase: boolean;
  media: PublicReviewMedia[];
};

export function normalizeReviewsLimit(value: unknown, fallback = 20, max = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

export function encodeReviewCursor(cursor: ReviewCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeReviewCursor(value: unknown): ReviewCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) {
    throw new HttpError(400, "invalid_cursor", "Review cursor is invalid");
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ReviewCursor>;
    const publishedAt = new Date(String(parsed.publishedAt ?? ""));
    const id = String(parsed.id ?? "");
    if (Number.isNaN(publishedAt.getTime()) || !UUID_RE.test(id)) throw new Error("invalid cursor");
    return { publishedAt: publishedAt.toISOString(), id };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Review cursor is invalid");
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeMedia(value: unknown): PublicReviewMedia[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as ReviewMediaRow;
    const id = typeof row.id === "string" ? row.id : "";
    const type = row.type === "image" || row.type === "video" ? row.type : null;
    const url = typeof row.url === "string" ? row.url : "";
    const mimeType = typeof row.mimeType === "string" ? row.mimeType : "";
    if (!id || !type || !url || !mimeType) return [];
    return [{
      id,
      type,
      url,
      previewUrl: typeof row.previewUrl === "string" && row.previewUrl ? row.previewUrl : null,
      mimeType,
      width: nullableNumber(row.width),
      height: nullableNumber(row.height),
      durationMs: nullableNumber(row.durationMs),
      sortOrder: nullableNumber(row.sortOrder) ?? 0,
    }];
  });
}

function sourceLabel(): string {
  return "Отзыв покупателя";
}

function publicAuthorName(value: string): string {
  const name = String(value || "").trim();
  return !name || /ozon|озон/i.test(name) ? "Покупатель" : name;
}

function sanitizeReview(row: ReviewRow): PublicReview {
  const source = row.source === "manual" || row.source === "komui" ? row.source : "ozon";
  const text = String(row.review_text ?? "").trim();
  return {
    id: row.id,
    source,
    sourceLabel: sourceLabel(),
    author: publicAuthorName(row.author_display_name),
    rating: Number(row.rating),
    text: text || null,
    publishedAt: new Date(row.published_at).toISOString(),
    verifiedPurchase: Boolean(row.is_verified_purchase),
    media: sanitizeMedia(row.media),
  };
}

export class ReviewsRepository {
  constructor(private readonly db: Db) {}

  async listPublicProductReviews(
    productId: string,
    limit: number,
    cursor: ReviewCursor | null,
    mediaOnly = false,
    textOnly = false,
  ) {
    const [summaryResult, reviewsResult] = await Promise.all([
      this.db.query<ReviewSummaryRow>(
        `
          select
            count(*)::text as review_count,
            round(avg(r.rating)::numeric, 2)::text as average_rating,
            count(*) filter (where r.rating = 1)::text as rating_1,
            count(*) filter (where r.rating = 2)::text as rating_2,
            count(*) filter (where r.rating = 3)::text as rating_3,
            count(*) filter (where r.rating = 4)::text as rating_4,
            count(*) filter (where r.rating = 5)::text as rating_5,
            count(*) filter (where exists (
              select 1
              from public.merch_storefront_review_media m
              where m.review_id = r.id
                and m.processing_status = 'ready'
                and m.moderation_status = 'approved'
                and not m.is_suppressed
                and nullif(m.public_url, '') is not null
            ))::text as reviews_with_media,
            count(*) filter (
              where nullif(btrim(r.review_text), '') is not null
            )::text as reviews_with_text
          from public.merch_storefront_reviews r
          where r.storefront_product_id = $1
            and r.is_published
            and r.moderation_status = 'approved'
            and r.mapping_status = 'matched'
        `,
        [productId],
      ),
      this.db.query<ReviewRow>(
        `
          select
            r.id,
            r.source,
            r.author_display_name,
            r.rating,
            r.review_text,
            r.published_at,
            r.is_verified_purchase,
            coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'id', m.id,
                    'type', m.media_type,
                    'url', m.public_url,
                    'previewUrl', case
                      when m.media_type = 'image' then coalesce(m.preview_public_url, m.public_url)
                      else m.preview_public_url
                    end,
                    'mimeType', m.mime_type,
                    'width', m.width,
                    'height', m.height,
                    'durationMs', m.duration_ms,
                    'sortOrder', m.sort_order
                  ) order by m.sort_order asc, m.id asc
                )
                from public.merch_storefront_review_media m
                where m.review_id = r.id
                  and m.processing_status = 'ready'
                  and m.moderation_status = 'approved'
                  and not m.is_suppressed
                  and nullif(m.public_url, '') is not null
              ),
              '[]'::jsonb
            ) as media
          from public.merch_storefront_reviews r
          where r.storefront_product_id = $1
            and r.is_published
            and r.moderation_status = 'approved'
            and r.mapping_status = 'matched'
            and (
              not $5::boolean
              or exists (
                select 1
                from public.merch_storefront_review_media filtered_media
                where filtered_media.review_id = r.id
                  and filtered_media.processing_status = 'ready'
                  and filtered_media.moderation_status = 'approved'
                  and not filtered_media.is_suppressed
                  and nullif(filtered_media.public_url, '') is not null
              )
            )
            and (
              not $6::boolean
              or nullif(btrim(r.review_text), '') is not null
            )
            and (
              $2::timestamptz is null
              or (r.published_at, r.id) < ($2::timestamptz, $3::uuid)
            )
          order by r.published_at desc, r.id desc
          limit $4
        `,
        [productId, cursor?.publishedAt ?? null, cursor?.id ?? null, limit + 1, mediaOnly, textOnly],
      ),
    ]);

    const hasMore = reviewsResult.rows.length > limit;
    const rows = reviewsResult.rows.slice(0, limit);
    const last = rows.at(-1);
    const summary = summaryResult.rows[0];

    return {
      summary: {
        count: Number(summary?.review_count ?? 0),
        averageRating: nullableNumber(summary?.average_rating),
        withMedia: Number(summary?.reviews_with_media ?? 0),
        withText: Number(summary?.reviews_with_text ?? 0),
        ratingCounts: {
          1: Number(summary?.rating_1 ?? 0),
          2: Number(summary?.rating_2 ?? 0),
          3: Number(summary?.rating_3 ?? 0),
          4: Number(summary?.rating_4 ?? 0),
          5: Number(summary?.rating_5 ?? 0),
        },
      },
      items: rows.map(sanitizeReview),
      nextCursor: hasMore && last
        ? encodeReviewCursor({
            publishedAt: new Date(last.published_at).toISOString(),
            id: last.id,
          })
        : null,
    };
  }
}
