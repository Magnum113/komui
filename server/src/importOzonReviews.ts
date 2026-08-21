import { createHash } from "node:crypto";
import { mkdir, chmod, copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

type CsvRecord = Record<string, string>;

type ProductRow = {
  id: string;
  slug: string;
  is_active: boolean;
  ozon_skus: unknown;
  ozon_offer_ids: unknown;
  offers: unknown;
};

type Mapping = {
  productId: string | null;
  status: "matched" | "unmapped" | "conflict";
  note: string | null;
};

type ImportedReview = {
  id: string;
  key: string;
  sourceSku: string;
  sourceOfferId: string;
  publishedAt: string;
  expectedPhotos: number;
  expectedVideos: number;
};

type MediaManifest = {
  version: number;
  items: Array<{
    orderNumber: string;
    sku: string | number;
    publishedAt: string;
    media: Array<{
      type: "image" | "video";
      file: string;
      previewFile?: string;
      sourceUrl?: string;
      sourcePreviewUrl?: string;
      sourceMediaKey?: string;
      width?: number;
      height?: number;
      durationMs?: number;
    }>;
  }>;
};

type CliArgs = {
  csvFiles: string[];
  mediaManifest: string;
  mediaRoot: string;
  archiveDir: string;
  dryRun: boolean;
};

const HEADER = {
  offerId: "Артикул",
  sku: "SKU",
  productName: "Название товара",
  orderNumber: "Номер заказа",
  deliveryStatus: "Статус получения",
  text: "Текст отзыва",
  publishedAt: "Дата публикации",
  reviewStatus: "Статус отзыва",
  rating: "Оценка",
  photos: "Количество фото",
  videos: "Количество видео",
  replies: "Количество ответов на отзыв",
} as const;

const REQUIRED_HEADERS = Object.values(HEADER);
const DEFAULT_MEDIA_ROOT = "/var/lib/komui/review-media-cache/public";
const DEFAULT_ARCHIVE_DIR = "/var/lib/komui/review-imports/private";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function positiveInteger(value: string, field: string, rowNumber: number): number {
  const parsed = Number.parseInt(clean(value) || "0", 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`CSV row ${rowNumber}: invalid ${field}`);
  }
  return parsed;
}

function parseRating(value: string, rowNumber: number): number {
  const rating = Number.parseInt(clean(value), 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error(`CSV row ${rowNumber}: rating must be between 1 and 5`);
  }
  return rating;
}

function normalizeTimestamp(value: string, rowNumber: number): string {
  const date = new Date(clean(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`CSV row ${rowNumber}: invalid publication timestamp`);
  }
  return date.toISOString();
}

export function parseSemicolonCsv(input: string): CsvRecord[] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ";" && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error("CSV has an unclosed quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows[0].map(clean);
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) throw new Error(`CSV header is missing: ${required}`);
  }

  return rows.slice(1).map((values, rowIndex) => {
    if (values.length > headers.length) {
      throw new Error(`CSV row ${rowIndex + 2}: too many columns`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    csvFiles: [],
    mediaManifest: "",
    mediaRoot: process.env.KOMUI_REVIEW_MEDIA_ROOT || DEFAULT_MEDIA_ROOT,
    archiveDir: process.env.KOMUI_REVIEW_IMPORT_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--csv") args.csvFiles.push(argv[++index] || "");
    else if (arg.startsWith("--csv=")) args.csvFiles.push(arg.slice(6));
    else if (arg === "--media-manifest") args.mediaManifest = argv[++index] || "";
    else if (arg.startsWith("--media-manifest=")) args.mediaManifest = arg.slice(17);
    else if (arg === "--media-root") args.mediaRoot = argv[++index] || args.mediaRoot;
    else if (arg.startsWith("--media-root=")) args.mediaRoot = arg.slice(13);
    else if (arg === "--archive-dir") args.archiveDir = argv[++index] || args.archiveDir;
    else if (arg.startsWith("--archive-dir=")) args.archiveDir = arg.slice(14);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  node dist/importOzonReviews.js --csv report.csv [--csv older.csv] [options]

Options:
  --media-manifest file.json  Optional media files matched to exported reviews.
  --media-root dir            Default: ${DEFAULT_MEDIA_ROOT}
  --archive-dir dir           Private source-report archive. Default: ${DEFAULT_ARCHIVE_DIR}
  --dry-run                   Validate and map without writing DB or files.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.csvFiles = args.csvFiles.filter(Boolean).map((file) => path.resolve(file));
  if (args.csvFiles.length === 0) throw new Error("At least one --csv file is required");
  args.mediaManifest = args.mediaManifest ? path.resolve(args.mediaManifest) : "";
  args.mediaRoot = path.resolve(args.mediaRoot);
  args.archiveDir = path.resolve(args.archiveDir);
  return args;
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(clean).filter(Boolean);
}

function offerValues(value: unknown, key: "sku" | "offer_id"): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry && typeof entry === "object" ? clean((entry as Record<string, unknown>)[key]) : ""))
    .filter(Boolean);
}

function addMapping(map: Map<string, Set<string>>, key: string, productId: string): void {
  if (!key) return;
  const values = map.get(key) ?? new Set<string>();
  values.add(productId);
  map.set(key, values);
}

export function buildProductMaps(products: ProductRow[]) {
  const skuMap = new Map<string, Set<string>>();
  const offerMap = new Map<string, Set<string>>();
  const activeProductIds = new Set(products.filter((product) => product.is_active).map((product) => product.id));

  for (const product of products) {
    for (const sku of [...stringValues(product.ozon_skus), ...offerValues(product.offers, "sku")]) {
      addMapping(skuMap, sku, product.id);
    }
    for (const offer of [...stringValues(product.ozon_offer_ids), ...offerValues(product.offers, "offer_id")]) {
      addMapping(offerMap, offer, product.id);
    }
  }
  return { skuMap, offerMap, activeProductIds };
}

export function resolveProduct(
  sku: string,
  offerId: string,
  maps: ReturnType<typeof buildProductMaps>,
): Mapping {
  const skuIds = maps.skuMap.get(sku) ?? new Set<string>();
  const offerIds = maps.offerMap.get(offerId) ?? new Set<string>();
  const combined = new Set([...skuIds, ...offerIds]);

  if (combined.size === 1) {
    return { productId: [...combined][0], status: "matched", note: null };
  }
  if (combined.size > 1) {
    const activeIds = [...combined].filter((productId) => maps.activeProductIds.has(productId));
    if (activeIds.length === 1) {
      return {
        productId: activeIds[0],
        status: "matched",
        note: "Resolved duplicate Ozon mapping to the only active storefront product",
      };
    }
  }
  if (combined.size === 0) {
    return { productId: null, status: "unmapped", note: `No product for SKU ${sku} / offer ${offerId}` };
  }
  return {
    productId: null,
    status: "conflict",
    note: `SKU ${sku} / offer ${offerId} map to ${combined.size} products`,
  };
}

function reviewKey(orderNumber: string, sku: string, publishedAt: string): string {
  return `seller-csv:${sha256(`${orderNumber}\n${sku}\n${publishedAt}`)}`;
}

function reviewContentFingerprint(sku: string, publishedAt: string, rating: number, text: string): string {
  return sha256(`${sku}\n${publishedAt}\n${rating}\n${text.trim()}`);
}

function sourcePayload(row: CsvRecord) {
  return {
    offerId: clean(row[HEADER.offerId]),
    sku: clean(row[HEADER.sku]),
    productName: clean(row[HEADER.productName]),
    deliveryStatus: clean(row[HEADER.deliveryStatus]),
    reviewStatus: clean(row[HEADER.reviewStatus]),
    photosCount: clean(row[HEADER.photos]),
    videosCount: clean(row[HEADER.videos]),
    repliesCount: clean(row[HEADER.replies]),
    exportFormat: "ozon-seller-reviews-csv-v1",
  };
}

async function loadProducts(client: PoolClient): Promise<ProductRow[]> {
  const result = await client.query<ProductRow>(`
    select id, slug, is_active, ozon_skus, ozon_offer_ids, offers
    from public.merch_storefront_products
  `);
  return result.rows;
}

async function insertRun(
  client: PoolClient,
  filename: string,
  checksum: string,
  rows: CsvRecord[],
): Promise<string> {
  const timestamps = rows
    .map((row, index) => normalizeTimestamp(row[HEADER.publishedAt], index + 2))
    .sort();
  const periodFrom = timestamps[0]?.slice(0, 10) ?? null;
  const periodTo = timestamps.at(-1)?.slice(0, 10) ?? null;
  const result = await client.query<{ id: string }>(`
    insert into public.merch_review_sync_runs (
      source, import_kind, source_period_from, source_period_to,
      source_filename, source_checksum_sha256, rows_seen
    ) values ('ozon', 'seller_csv', $1, $2, $3, $4, $5)
    returning id
  `, [periodFrom, periodTo, path.basename(filename), checksum, rows.length]);
  return result.rows[0].id;
}

async function upsertReview(
  client: PoolClient,
  runId: string,
  row: CsvRecord,
  rowNumber: number,
  maps: ReturnType<typeof buildProductMaps>,
): Promise<{ review: ImportedReview | null; inserted: boolean; skippedCancelled: boolean; warning?: string }> {
  const deliveryStatus = clean(row[HEADER.deliveryStatus]);
  const orderNumber = clean(row[HEADER.orderNumber]);
  const sku = clean(row[HEADER.sku]);
  const offerId = clean(row[HEADER.offerId]);
  const publishedAt = normalizeTimestamp(row[HEADER.publishedAt], rowNumber);
  const key = reviewKey(orderNumber, sku, publishedAt);

  if (/^отмен/iu.test(deliveryStatus)) {
    await client.query(`
      update public.merch_storefront_reviews
      set is_published = false,
          moderation_status = 'hidden',
          source_delivery_status = $1,
          updated_at = now(),
          last_synced_at = now()
      where source = 'ozon' and source_review_key = $2
    `, [deliveryStatus, key]);
    return { review: null, inserted: false, skippedCancelled: true };
  }

  if (!orderNumber || !sku || !offerId) {
    throw new Error(`CSV row ${rowNumber}: order number, SKU and offer id are required`);
  }

  const rating = parseRating(row[HEADER.rating], rowNumber);
  const text = clean(row[HEADER.text]);
  const photos = positiveInteger(row[HEADER.photos], "photo count", rowNumber);
  const videos = positiveInteger(row[HEADER.videos], "video count", rowNumber);
  const replies = positiveInteger(row[HEADER.replies], "reply count", rowNumber);
  const mapping = resolveProduct(sku, offerId, maps);
  const publish = mapping.status === "matched";
  const result = await client.query<{ id: string; inserted: boolean }>(`
    insert into public.merch_storefront_reviews (
      storefront_product_id, import_run_id, source, source_review_key,
      source_order_reference_hash, source_sku, source_offer_id,
      source_product_name, source_product_url, source_delivery_status,
      source_review_status, author_display_name, rating, review_text,
      published_at, is_verified_purchase, photos_count, videos_count,
      replies_count, mapping_status, mapping_note, moderation_status,
      is_published, raw_payload, content_fingerprint_sha256, last_synced_at
    ) values (
      $1, $2, 'ozon', $3, $4, $5::bigint, $6, $7, $8, $9, $10,
      'Покупатель', $11, nullif($12, ''), $13::timestamptz, $14,
      $15, $16, $17, $18, $19, 'approved', $20, $21::jsonb, $22, now()
    )
    on conflict (source, source_review_key) do update set
      storefront_product_id = excluded.storefront_product_id,
      import_run_id = excluded.import_run_id,
      source_sku = excluded.source_sku,
      source_offer_id = excluded.source_offer_id,
      source_product_name = excluded.source_product_name,
      source_product_url = excluded.source_product_url,
      source_delivery_status = excluded.source_delivery_status,
      source_review_status = excluded.source_review_status,
      rating = excluded.rating,
      review_text = excluded.review_text,
      published_at = excluded.published_at,
      is_verified_purchase = excluded.is_verified_purchase,
      photos_count = excluded.photos_count,
      videos_count = excluded.videos_count,
      replies_count = excluded.replies_count,
      mapping_status = excluded.mapping_status,
      mapping_note = excluded.mapping_note,
      is_published = case
        when public.merch_storefront_reviews.moderation_status in ('hidden', 'rejected') then false
        when public.merch_storefront_reviews.mapping_status <> 'matched'
          and excluded.mapping_status = 'matched' then true
        else public.merch_storefront_reviews.is_published
      end,
      raw_payload = excluded.raw_payload,
      content_fingerprint_sha256 = excluded.content_fingerprint_sha256,
      last_synced_at = now(),
      updated_at = now()
    returning id, (xmax = 0) as inserted
  `, [
    mapping.productId,
    runId,
    key,
    sha256(orderNumber),
    sku,
    offerId,
    clean(row[HEADER.productName]),
    `https://www.ozon.ru/product/${encodeURIComponent(sku)}/`,
    deliveryStatus,
    clean(row[HEADER.reviewStatus]),
    rating,
    text,
    publishedAt,
    /получен/iu.test(deliveryStatus),
    photos,
    videos,
    replies,
    mapping.status,
    mapping.note,
    publish,
    JSON.stringify(sourcePayload(row)),
    reviewContentFingerprint(sku, publishedAt, rating, text),
  ]);

  return {
    review: {
      id: result.rows[0].id,
      key,
      sourceSku: sku,
      sourceOfferId: offerId,
      publishedAt,
      expectedPhotos: photos,
      expectedVideos: videos,
    },
    inserted: result.rows[0].inserted,
    skippedCancelled: false,
    warning: mapping.status === "matched" ? undefined : mapping.note ?? mapping.status,
  };
}

function detectMedia(buffer: Buffer): { type: "image" | "video"; mime: string; extension: string } {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { type: "image", mime: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { type: "image", mime: "image/png", extension: "png" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { type: "image", mime: "image/webp", extension: "webp" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    return { type: "video", mime: "video/mp4", extension: "mp4" };
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) {
    return { type: "video", mime: "video/webm", extension: "webm" };
  }
  throw new Error("Unsupported media file; expected JPEG, PNG, WebP, MP4 or WebM");
}

async function importMedia(
  client: PoolClient,
  manifestPath: string,
  mediaRoot: string,
  reviews: Map<string, ImportedReview>,
): Promise<{ seen: number; imported: number; warnings: string[] }> {
  if (!manifestPath) return { seen: 0, imported: 0, warnings: [] };
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MediaManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.items)) {
    throw new Error("Media manifest must have version=1 and an items array");
  }

  const warnings: string[] = [];
  let seen = 0;
  let imported = 0;
  const manifestDir = path.dirname(manifestPath);

  for (const item of manifest.items) {
    const publishedAt = normalizeTimestamp(item.publishedAt, 0);
    const key = reviewKey(clean(item.orderNumber), clean(item.sku), publishedAt);
    const review = reviews.get(key);
    if (!review) {
      warnings.push(`Media manifest has no imported review for SKU ${clean(item.sku)} at ${publishedAt}`);
      continue;
    }

    let imageCount = 0;
    let videoCount = 0;
    for (let index = 0; index < item.media.length; index += 1) {
      const media = item.media[index];
      seen += 1;
      const sourcePath = path.resolve(manifestDir, media.file);
      const fileStat = await stat(sourcePath);
      const maxBytes = media.type === "image" ? 30 * 1024 * 1024 : 250 * 1024 * 1024;
      if (!fileStat.isFile() || fileStat.size > maxBytes) {
        throw new Error(`Invalid or oversized review media file: ${sourcePath}`);
      }
      const bytes = await readFile(sourcePath);
      const detected = detectMedia(bytes);
      if (detected.type !== media.type) {
        throw new Error(`Media type mismatch for ${sourcePath}: manifest=${media.type}, file=${detected.type}`);
      }
      if (media.type === "image") imageCount += 1;
      else videoCount += 1;

      const checksum = sha256(bytes);
      const relativeDir = path.posix.join("reviews", checksum.slice(0, 2), checksum);
      const relativePath = path.posix.join(relativeDir, `original.${detected.extension}`);
      const destination = path.join(mediaRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      try {
        await stat(destination);
      } catch {
        await copyFile(sourcePath, destination);
        await chmod(destination, 0o644);
      }

      let previewStoragePath: string | null = null;
      let previewPublicUrl: string | null = null;
      if (media.previewFile) {
        const previewSourcePath = path.resolve(manifestDir, media.previewFile);
        const previewStat = await stat(previewSourcePath);
        if (!previewStat.isFile() || previewStat.size > 30 * 1024 * 1024) {
          throw new Error(`Invalid or oversized review media preview: ${previewSourcePath}`);
        }
        const previewBytes = await readFile(previewSourcePath);
        const previewDetected = detectMedia(previewBytes);
        if (previewDetected.type !== "image") {
          throw new Error(`Review media preview must be an image: ${previewSourcePath}`);
        }
        previewStoragePath = path.posix.join(relativeDir, `preview.${previewDetected.extension}`);
        const previewDestination = path.join(mediaRoot, previewStoragePath);
        await mkdir(path.dirname(previewDestination), { recursive: true, mode: 0o755 });
        try {
          await stat(previewDestination);
        } catch {
          await copyFile(previewSourcePath, previewDestination);
          await chmod(previewDestination, 0o644);
        }
        previewPublicUrl = `/media/reviews/${previewStoragePath.slice("reviews/".length)}`;
      }

      const sourceMediaKey = clean(media.sourceMediaKey)
        || sha256(`${media.sourceUrl || ""}\n${media.type}\n${index}\n${checksum}`);
      const result = await client.query(`
        insert into public.merch_storefront_review_media (
          review_id, source_media_key, media_type, source_url,
          source_preview_url, storage_path, public_url, mime_type,
          preview_storage_path, preview_public_url, width, height, duration_ms,
          file_size_bytes, sha256, sort_order, processing_status, moderation_status
        ) values (
          $1, $2, $3, nullif($4, ''), nullif($5, ''), $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, 'ready', 'approved'
        )
        on conflict (review_id, source_media_key) do update set
          source_url = excluded.source_url,
          source_preview_url = excluded.source_preview_url,
          storage_path = excluded.storage_path,
          public_url = excluded.public_url,
          mime_type = excluded.mime_type,
          preview_storage_path = excluded.preview_storage_path,
          preview_public_url = excluded.preview_public_url,
          width = excluded.width,
          height = excluded.height,
          duration_ms = excluded.duration_ms,
          file_size_bytes = excluded.file_size_bytes,
          sha256 = excluded.sha256,
          sort_order = excluded.sort_order,
          processing_status = 'ready',
          updated_at = now()
        returning (xmax = 0) as inserted
      `, [
        review.id,
        sourceMediaKey,
        media.type,
        clean(media.sourceUrl),
        clean(media.sourcePreviewUrl),
        relativePath,
        `/media/reviews/${relativePath.slice("reviews/".length)}`,
        detected.mime,
        previewStoragePath,
        previewPublicUrl,
        media.width ?? null,
        media.height ?? null,
        media.durationMs ?? null,
        bytes.length,
        checksum,
        index,
      ]);
      if (result.rows[0]?.inserted) imported += 1;
    }

    if (imageCount !== review.expectedPhotos || videoCount !== review.expectedVideos) {
      warnings.push(
        `Media count mismatch for SKU ${review.sourceSku} at ${review.publishedAt}: `
        + `expected ${review.expectedPhotos}/${review.expectedVideos}, got ${imageCount}/${videoCount}`,
      );
    }
  }
  return { seen, imported, warnings };
}

async function archiveSource(file: string, archiveDir: string, checksum: string): Promise<string> {
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  await chmod(archiveDir, 0o700);
  const destination = path.join(archiveDir, `${checksum.slice(0, 16)}-${path.basename(file)}`);
  try {
    await stat(destination);
  } catch {
    await copyFile(file, destination);
    await chmod(destination, 0o600);
  }
  return destination;
}

async function importCsvFile(
  pool: Pool,
  file: string,
  args: CliArgs,
): Promise<Record<string, unknown>> {
  const bytes = await readFile(file);
  const checksum = sha256(bytes);
  const rows = parseSemicolonCsv(bytes.toString("utf8"));
  const client = await pool.connect();
  let runId = "dry-run";

  try {
    await client.query("begin");
    const products = await loadProducts(client);
    const maps = buildProductMaps(products);
    if (!args.dryRun) runId = await insertRun(client, file, checksum, rows);

    let imported = 0;
    let updated = 0;
    let skippedCancelled = 0;
    let unmapped = 0;
    const warnings: string[] = [];
    const reviews = new Map<string, ImportedReview>();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (args.dryRun) {
        const deliveryStatus = clean(row[HEADER.deliveryStatus]);
        if (/^отмен/iu.test(deliveryStatus)) {
          skippedCancelled += 1;
          continue;
        }
        const mapping = resolveProduct(clean(row[HEADER.sku]), clean(row[HEADER.offerId]), maps);
        if (mapping.status !== "matched") {
          unmapped += 1;
          warnings.push(mapping.note ?? mapping.status);
        }
        parseRating(row[HEADER.rating], index + 2);
        normalizeTimestamp(row[HEADER.publishedAt], index + 2);
        continue;
      }

      const result = await upsertReview(client, runId, row, index + 2, maps);
      if (result.skippedCancelled) {
        skippedCancelled += 1;
        continue;
      }
      if (result.review) reviews.set(result.review.key, result.review);
      if (result.inserted) imported += 1;
      else updated += 1;
      if (result.warning) {
        unmapped += 1;
        warnings.push(`Row ${index + 2}: ${result.warning}`);
      }
    }

    const media = args.dryRun
      ? { seen: 0, imported: 0, warnings: [] as string[] }
      : await importMedia(client, args.mediaManifest, args.mediaRoot, reviews);
    warnings.push(...media.warnings);

    if (!args.dryRun) {
      await client.query(`
        update public.merch_review_sync_runs
        set status = $2,
            rows_imported = $3,
            rows_updated = $4,
            rows_skipped_cancelled = $5,
            rows_unmapped = $6,
            media_seen = $7,
            media_imported = $8,
            errors = $9::jsonb,
            finished_at = now()
        where id = $1
      `, [
        runId,
        warnings.length > 0 ? "completed_with_warnings" : "completed",
        imported,
        updated,
        skippedCancelled,
        unmapped,
        media.seen,
        media.imported,
        JSON.stringify(warnings),
      ]);
    }
    await client.query(args.dryRun ? "rollback" : "commit");

    const archivePath = args.dryRun ? null : await archiveSource(file, args.archiveDir, checksum);
    return {
      file: path.basename(file),
      runId,
      rowsSeen: rows.length,
      imported,
      updated,
      skippedCancelled,
      unmapped,
      mediaSeen: media.seen,
      mediaImported: media.imported,
      warnings,
      archivePath,
      dryRun: args.dryRun,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (!args.dryRun && runId !== "dry-run") {
      await pool.query(`
        update public.merch_review_sync_runs
        set status = 'failed', errors = $2::jsonb, finished_at = now()
        where id = $1
      `, [runId, JSON.stringify([error instanceof Error ? error.message : String(error)])]).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: "komui-ozon-review-import",
  });
  try {
    const reports = [];
    for (const file of args.csvFiles) reports.push(await importCsvFile(pool, file, args));
    console.log(JSON.stringify({ ok: true, reports }, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
