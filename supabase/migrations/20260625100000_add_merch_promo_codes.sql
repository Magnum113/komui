create table if not exists public.merch_promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  code_normalized text not null,
  name text not null,
  is_active boolean not null default true,
  discount_type text not null
    check (discount_type in ('percent', 'fixed_amount', 'free_delivery')),
  discount_value integer not null default 0 check (discount_value >= 0),
  max_discount_amount integer check (max_discount_amount is null or max_discount_amount >= 0),
  min_subtotal_amount integer not null default 0 check (min_subtotal_amount >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  global_usage_limit integer check (global_usage_limit is null or global_usage_limit > 0),
  per_phone_limit integer check (per_phone_limit is null or per_phone_limit > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (discount_type = 'percent' and discount_value > 0 and discount_value <= 10000)
    or (discount_type = 'fixed_amount' and discount_value > 0)
    or (discount_type = 'free_delivery')
  )
);

create unique index if not exists merch_promo_codes_code_normalized_idx
  on public.merch_promo_codes (code_normalized);

create index if not exists merch_promo_codes_active_window_idx
  on public.merch_promo_codes (is_active, starts_at, ends_at);

create table if not exists public.merch_promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.merch_promo_codes(id) on delete restrict,
  order_id uuid not null references public.merch_customer_orders(id) on delete cascade,
  order_number text not null,
  client_request_id uuid not null,
  customer_phone_hash text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'redeemed', 'released', 'expired', 'canceled')),
  subtotal_amount integer not null check (subtotal_amount >= 0),
  delivery_amount integer not null default 0 check (delivery_amount >= 0),
  delivery_discount_amount integer not null default 0 check (delivery_discount_amount >= 0),
  discount_amount integer not null default 0 check (discount_amount >= 0),
  reserved_until timestamptz,
  redeemed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_amount <= subtotal_amount),
  check (delivery_discount_amount <= delivery_amount)
);

create unique index if not exists merch_promo_redemptions_order_idx
  on public.merch_promo_redemptions (order_id);

create unique index if not exists merch_promo_redemptions_request_promo_idx
  on public.merch_promo_redemptions (client_request_id, promo_code_id);

create index if not exists merch_promo_redemptions_promo_status_idx
  on public.merch_promo_redemptions (promo_code_id, status, created_at desc);

create index if not exists merch_promo_redemptions_phone_idx
  on public.merch_promo_redemptions (promo_code_id, customer_phone_hash, status);

alter table public.merch_promo_codes enable row level security;
alter table public.merch_promo_redemptions enable row level security;

revoke all on public.merch_promo_codes from public, anon, authenticated;
revoke all on public.merch_promo_redemptions from public, anon, authenticated;

grant select, insert, update, delete on public.merch_promo_codes to service_role;
grant select, insert, update, delete on public.merch_promo_redemptions to service_role;

drop policy if exists "No direct storefront access to promo codes"
  on public.merch_promo_codes;
create policy "No direct storefront access to promo codes"
  on public.merch_promo_codes
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "No direct storefront access to promo redemptions"
  on public.merch_promo_redemptions;
create policy "No direct storefront access to promo redemptions"
  on public.merch_promo_redemptions
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop trigger if exists merch_promo_codes_set_updated_at on public.merch_promo_codes;
create trigger merch_promo_codes_set_updated_at
before update on public.merch_promo_codes
for each row execute function private.merch_set_updated_at();

drop trigger if exists merch_promo_redemptions_set_updated_at on public.merch_promo_redemptions;
create trigger merch_promo_redemptions_set_updated_at
before update on public.merch_promo_redemptions
for each row execute function private.merch_set_updated_at();

insert into public.merch_promo_codes (
  code,
  code_normalized,
  name,
  is_active,
  discount_type,
  discount_value,
  starts_at,
  ends_at,
  metadata
)
values (
  'KOMUI10',
  'KOMUI10',
  'KOMUI 10% до сентября',
  true,
  'percent',
  1000,
  now(),
  '2026-09-01 00:00:00+03'::timestamptz,
  jsonb_build_object('seed', true, 'note', 'Initial storefront promo')
)
on conflict (code_normalized) do update
set
  code = excluded.code,
  name = excluded.name,
  is_active = excluded.is_active,
  discount_type = excluded.discount_type,
  discount_value = excluded.discount_value,
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  global_usage_limit = null,
  per_phone_limit = null,
  updated_at = now();
