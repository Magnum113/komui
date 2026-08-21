import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../src/db";
import { HttpError } from "../src/errors";
import {
  decodeReviewCursor,
  encodeReviewCursor,
  normalizeReviewsLimit,
  ReviewsRepository,
} from "../src/reviews";

test("review cursor round-trips and malformed values are rejected", () => {
  const cursor = {
    publishedAt: "2026-08-15T14:58:24.000Z",
    id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
  };

  assert.deepEqual(decodeReviewCursor(encodeReviewCursor(cursor)), cursor);
  assert.equal(decodeReviewCursor(undefined), null);
  assert.throws(
    () => decodeReviewCursor("not-a-cursor"),
    (error) => error instanceof HttpError && error.code === "invalid_cursor",
  );
  assert.equal(normalizeReviewsLimit(undefined), 20);
  assert.equal(normalizeReviewsLimit("0"), 1);
  assert.equal(normalizeReviewsLimit("500"), 50);
});

test("ReviewsRepository returns only public review and media fields", async () => {
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("round(avg(r.rating)")) {
        return {
          rows: [{
            review_count: "1",
            average_rating: "5.00",
            rating_1: "0",
            rating_2: "0",
            rating_3: "0",
            rating_4: "0",
            rating_5: "1",
            reviews_with_media: "1",
          }],
        };
      }
      return {
        rows: [{
          id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
          source: "ozon",
          author_display_name: "Покупатель Ozon",
          rating: 5,
          review_text: "Отличная футболка",
          published_at: "2026-08-15T14:58:24.000Z",
          is_verified_purchase: true,
          source_order_reference_hash: "must-not-leak",
          media: [{
            id: "ce42ea07-05c8-4da8-891d-4c3be4a1d06c",
            type: "image",
            url: "/media/reviews/ab/hash/original.webp",
            previewUrl: "/media/reviews/ab/hash/original.webp",
            mimeType: "image/webp",
            width: 900,
            height: 1200,
            durationMs: null,
            sortOrder: 0,
            sourceUrl: "must-not-leak",
            storagePath: "must-not-leak",
          }],
        }],
      };
    },
  } as unknown as Db;

  const result = await new ReviewsRepository(db).listPublicProductReviews(
    "6218f78d-65ac-4832-a23d-b29f9ef91b32",
    20,
    null,
  );

  assert.equal(result.summary.count, 1);
  assert.equal(result.summary.averageRating, 5);
  assert.equal(result.summary.withMedia, 1);
  assert.equal(result.items[0]?.sourceLabel, "Отзыв с Ozon");
  assert.equal(result.items[0]?.media[0]?.url, "/media/reviews/ab/hash/original.webp");
  assert.equal("sourceUrl" in (result.items[0]?.media[0] ?? {}), false);
  assert.equal("source_order_reference_hash" in (result.items[0] ?? {}), false);
  assert.equal(result.nextCursor, null);
  assert.equal(queries.every((sql) => sql.includes("r.is_published")), true);
  assert.equal(queries.every((sql) => sql.includes("r.moderation_status = 'approved'")), true);
});
