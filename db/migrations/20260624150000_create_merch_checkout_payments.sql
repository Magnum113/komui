create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.merch_customer_orders (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null unique,
  order_number text not null unique,
  access_token_hash text not null,
  status text not null default 'created'
    check (status in (
      'created',
      'pending_payment',
      'authorized',
      'paid',
      'payment_failed',
      'payment_review',
      'canceled',
      'partially_refunded',
      'refunded'
    )),
  customer_first_name text not null,
  customer_last_name text not null,
  customer_phone text not null,
  marketing_consent boolean not null default false,
  legal_accepted_at timestamptz not null,
  delivery_provider text not null default 'cdek',
  delivery_point_code text not null,
  delivery_city text not null,
  delivery_address text not null,
  delivery_hours text,
  delivery_eta text,
  delivery_amount integer not null default 0 check (delivery_amount >= 0),
  currency text not null default 'RUB' check (currency = 'RUB'),
  subtotal_amount integer not null check (subtotal_amount >= 0),
  discount_amount integer not null default 0 check (discount_amount >= 0),
  total_amount integer not null check (total_amount > 0),
  promo_code text,
  source text not null default 'storefront',
  metadata jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_amount <= subtotal_amount),
  check (total_amount = subtotal_amount - discount_amount + delivery_amount)
);

create table if not exists public.merch_customer_order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.merch_customer_orders(id) on delete cascade,
  product_id uuid references public.merch_storefront_products(id) on delete set null,
  offer_id text,
  sku text,
  product_name text not null,
  size text not null,
  quantity integer not null check (quantity > 0 and quantity <= 10),
  unit_price_amount integer not null check (unit_price_amount >= 0),
  line_total_amount integer not null check (line_total_amount >= 0),
  image_url text,
  product_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (line_total_amount = unit_price_amount * quantity)
);

create table if not exists public.merch_payment_attempts (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.merch_customer_orders(id) on delete cascade,
  provider text not null default 'tbank' check (provider = 'tbank'),
  terminal_key text not null,
  external_payment_id text,
  provider_status text not null default 'INITIATING',
  amount integer not null check (amount > 0),
  payment_url text,
  error_code text,
  error_message text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists public.merch_payment_events (
  id bigint generated always as identity primary key,
  payment_attempt_id bigint references public.merch_payment_attempts(id) on delete set null,
  order_id uuid references public.merch_customer_orders(id) on delete set null,
  provider text not null default 'tbank' check (provider = 'tbank'),
  external_payment_id text,
  provider_status text,
  event_hash text not null unique,
  signature_valid boolean not null,
  amount integer,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists merch_customer_orders_status_created_idx
  on public.merch_customer_orders (status, created_at desc);

create index if not exists merch_customer_orders_phone_created_idx
  on public.merch_customer_orders (customer_phone, created_at desc);

create index if not exists merch_customer_order_items_order_idx
  on public.merch_customer_order_items (order_id);

create index if not exists merch_payment_attempts_order_created_idx
  on public.merch_payment_attempts (order_id, created_at desc);

create unique index if not exists merch_payment_attempts_external_id_idx
  on public.merch_payment_attempts (provider, external_payment_id)
  where external_payment_id is not null;

create index if not exists merch_payment_events_order_received_idx
  on public.merch_payment_events (order_id, received_at desc);

alter table public.merch_customer_orders enable row level security;
alter table public.merch_customer_order_items enable row level security;
alter table public.merch_payment_attempts enable row level security;
alter table public.merch_payment_events enable row level security;

revoke all on public.merch_customer_orders from public, anon, authenticated;
revoke all on public.merch_customer_order_items from public, anon, authenticated;
revoke all on public.merch_payment_attempts from public, anon, authenticated;
revoke all on public.merch_payment_events from public, anon, authenticated;

grant select, insert, update, delete on public.merch_customer_orders to service_role;
grant select, insert, update, delete on public.merch_customer_order_items to service_role;
grant select, insert, update, delete on public.merch_payment_attempts to service_role;
grant select, insert, update, delete on public.merch_payment_events to service_role;
grant usage, select on sequence public.merch_customer_order_items_id_seq to service_role;
grant usage, select on sequence public.merch_payment_attempts_id_seq to service_role;
grant usage, select on sequence public.merch_payment_events_id_seq to service_role;

create or replace function private.merch_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists merch_customer_orders_set_updated_at on public.merch_customer_orders;
create trigger merch_customer_orders_set_updated_at
before update on public.merch_customer_orders
for each row execute function private.merch_set_updated_at();

drop trigger if exists merch_payment_attempts_set_updated_at on public.merch_payment_attempts;
create trigger merch_payment_attempts_set_updated_at
before update on public.merch_payment_attempts
for each row execute function private.merch_set_updated_at();

create or replace function public.merch_create_checkout_order(
  p_order jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce((p_order ->> 'id')::uuid, gen_random_uuid());
begin
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid order items';
  end if;

  insert into public.merch_customer_orders (
    id,
    client_request_id,
    order_number,
    access_token_hash,
    status,
    customer_first_name,
    customer_last_name,
    customer_phone,
    marketing_consent,
    legal_accepted_at,
    delivery_provider,
    delivery_point_code,
    delivery_city,
    delivery_address,
    delivery_hours,
    delivery_eta,
    delivery_amount,
    currency,
    subtotal_amount,
    discount_amount,
    total_amount,
    promo_code,
    source,
    metadata
  )
  values (
    v_order_id,
    (p_order ->> 'client_request_id')::uuid,
    p_order ->> 'order_number',
    p_order ->> 'access_token_hash',
    coalesce(p_order ->> 'status', 'created'),
    p_order ->> 'customer_first_name',
    p_order ->> 'customer_last_name',
    p_order ->> 'customer_phone',
    coalesce((p_order ->> 'marketing_consent')::boolean, false),
    (p_order ->> 'legal_accepted_at')::timestamptz,
    coalesce(p_order ->> 'delivery_provider', 'cdek'),
    p_order ->> 'delivery_point_code',
    p_order ->> 'delivery_city',
    p_order ->> 'delivery_address',
    p_order ->> 'delivery_hours',
    p_order ->> 'delivery_eta',
    (p_order ->> 'delivery_amount')::integer,
    coalesce(p_order ->> 'currency', 'RUB'),
    (p_order ->> 'subtotal_amount')::integer,
    coalesce((p_order ->> 'discount_amount')::integer, 0),
    (p_order ->> 'total_amount')::integer,
    nullif(p_order ->> 'promo_code', ''),
    coalesce(p_order ->> 'source', 'storefront'),
    coalesce(p_order -> 'metadata', '{}'::jsonb)
  );

  insert into public.merch_customer_order_items (
    order_id,
    product_id,
    offer_id,
    sku,
    product_name,
    size,
    quantity,
    unit_price_amount,
    line_total_amount,
    image_url,
    product_snapshot
  )
  select
    v_order_id,
    (item ->> 'product_id')::uuid,
    nullif(item ->> 'offer_id', ''),
    nullif(item ->> 'sku', ''),
    item ->> 'product_name',
    item ->> 'size',
    (item ->> 'quantity')::integer,
    (item ->> 'unit_price_amount')::integer,
    (item ->> 'line_total_amount')::integer,
    nullif(item ->> 'image_url', ''),
    coalesce(item -> 'product_snapshot', '{}'::jsonb)
  from jsonb_array_elements(p_items) as item;

  return v_order_id;
end;
$$;

revoke all on function public.merch_create_checkout_order(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.merch_create_checkout_order(jsonb, jsonb)
  to service_role;

comment on table public.merch_customer_orders is
  'Storefront orders. Personal and payment data are available only to service_role.';
comment on table public.merch_payment_attempts is
  'T-Bank payment initialization attempts. Tokens and terminal passwords must never be stored here.';
comment on table public.merch_payment_events is
  'Verified T-Bank webhook events used as the source of truth for payment status.';
