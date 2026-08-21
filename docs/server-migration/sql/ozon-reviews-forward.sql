-- Ozon reviews storage for the KOMUI storefront.
--
-- The Ozon Seller CSV export currently has no stable review id. The importer
-- therefore derives source_review_key from the order reference, SKU and exact
-- publication timestamp. The raw order number is never stored in these tables.
-- source_review_id remains nullable so the same model can later be enriched by
-- Ozon Review API v2 without a schema change.

begin;

create table if not exists public.merch_review_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'ozon'
    check (source in ('ozon', 'manual', 'komui')),
  import_kind text not null
    check (import_kind in ('seller_csv', 'seller_ui', 'seller_api', 'manual')),
  source_period_from date,
  source_period_to date,
  source_filename text,
  source_checksum_sha256 text,
  status text not null default 'running'
    check (status in ('running', 'completed', 'completed_with_warnings', 'failed')),
  rows_seen integer not null default 0 check (rows_seen >= 0),
  rows_imported integer not null default 0 check (rows_imported >= 0),
  rows_updated integer not null default 0 check (rows_updated >= 0),
  rows_skipped_cancelled integer not null default 0 check (rows_skipped_cancelled >= 0),
  rows_unmapped integer not null default 0 check (rows_unmapped >= 0),
  media_seen integer not null default 0 check (media_seen >= 0),
  media_imported integer not null default 0 check (media_imported >= 0),
  errors jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists merch_review_sync_runs_started_idx
  on public.merch_review_sync_runs(started_at desc);

create table if not exists public.merch_storefront_reviews (
  id uuid primary key default gen_random_uuid(),
  storefront_product_id uuid
    references public.merch_storefront_products(id)
    on delete set null,
  import_run_id uuid
    references public.merch_review_sync_runs(id)
    on delete set null,
  source text not null default 'ozon'
    check (source in ('ozon', 'manual', 'komui')),
  source_review_key text not null,
  source_review_id text,
  source_order_reference_hash text,
  source_sku bigint,
  source_offer_id text,
  source_product_name text,
  source_product_url text,
  source_delivery_status text,
  source_review_status text,
  author_display_name text not null default 'Покупатель Ozon',
  rating smallint not null check (rating between 1 and 5),
  review_text text,
  published_at timestamptz not null,
  is_verified_purchase boolean not null default false,
  photos_count integer not null default 0 check (photos_count >= 0),
  videos_count integer not null default 0 check (videos_count >= 0),
  replies_count integer not null default 0 check (replies_count >= 0),
  likes_count integer not null default 0 check (likes_count >= 0),
  dislikes_count integer not null default 0 check (dislikes_count >= 0),
  mapping_status text not null default 'unmapped'
    check (mapping_status in ('matched', 'unmapped', 'conflict')),
  mapping_note text,
  moderation_status text not null default 'approved'
    check (moderation_status in ('pending', 'approved', 'hidden', 'rejected')),
  is_published boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  content_fingerprint_sha256 text not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_review_key)
);

create unique index if not exists merch_storefront_reviews_source_id_uidx
  on public.merch_storefront_reviews(source, source_review_id)
  where source_review_id is not null;

create index if not exists merch_storefront_reviews_public_product_idx
  on public.merch_storefront_reviews(storefront_product_id, published_at desc)
  where is_published and moderation_status = 'approved' and mapping_status = 'matched';

create index if not exists merch_storefront_reviews_product_rating_idx
  on public.merch_storefront_reviews(storefront_product_id, rating, published_at desc);

create index if not exists merch_storefront_reviews_source_sku_idx
  on public.merch_storefront_reviews(source, source_sku, published_at desc);

create index if not exists merch_storefront_reviews_fingerprint_idx
  on public.merch_storefront_reviews(source, content_fingerprint_sha256);

create table if not exists public.merch_storefront_review_media (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null
    references public.merch_storefront_reviews(id)
    on delete cascade,
  source_media_key text not null,
  media_type text not null check (media_type in ('image', 'video')),
  source_url text,
  source_preview_url text,
  storage_path text not null,
  public_url text not null,
  preview_storage_path text,
  preview_public_url text,
  mime_type text not null,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  file_size_bytes bigint not null check (file_size_bytes >= 0),
  sha256 text not null,
  sort_order integer not null default 0 check (sort_order >= 0),
  processing_status text not null default 'ready'
    check (processing_status in ('pending', 'ready', 'failed')),
  moderation_status text not null default 'approved'
    check (moderation_status in ('pending', 'approved', 'hidden', 'rejected')),
  is_suppressed boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, source_media_key)
);

create index if not exists merch_storefront_review_media_public_idx
  on public.merch_storefront_review_media(review_id, sort_order)
  where processing_status = 'ready'
    and moderation_status = 'approved'
    and not is_suppressed;

comment on table public.merch_storefront_reviews is
  'Normalized storefront reviews imported from Ozon Seller or entered manually.';

comment on column public.merch_storefront_reviews.source_order_reference_hash is
  'SHA-256 of the Ozon order reference. The raw order number is intentionally not stored.';

comment on column public.merch_storefront_review_media.is_suppressed is
  'Manual suppression flag preserved by future imports so removed media is not re-added to the site.';

grant select, insert, update on public.merch_review_sync_runs to komui_app;
grant select, insert, update on public.merch_storefront_reviews to komui_app;
grant select, insert, update on public.merch_storefront_review_media to komui_app;

commit;
