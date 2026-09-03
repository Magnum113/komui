create table if not exists public.merch_cdek_shipments (
  id bigint generated always as identity primary key,
  order_id uuid not null unique
    references public.merch_customer_orders(id) on delete cascade,
  status text not null default 'pending'
    check (status in (
      'pending',
      'creating',
      'accepted',
      'created',
      'invalid',
      'failed',
      'deleted',
      'unknown'
    )),
  cdek_uuid text unique,
  cdek_number text,
  request_uuid text,
  tariff_code integer not null check (tariff_code > 0),
  tariff_name text,
  shipment_point text not null,
  delivery_point text not null,
  delivery_city text,
  delivery_address text,
  package_snapshot jsonb not null default '[]'::jsonb
    check (jsonb_typeof(package_snapshot) = 'array'),
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz
);

create table if not exists public.merch_cdek_events (
  id bigint generated always as identity primary key,
  shipment_id bigint references public.merch_cdek_shipments(id) on delete set null,
  order_id uuid references public.merch_customer_orders(id) on delete set null,
  cdek_uuid text,
  cdek_number text,
  event_type text,
  status_code text,
  status_name text,
  event_hash text not null unique,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists merch_cdek_shipments_status_created_idx
  on public.merch_cdek_shipments (status, created_at desc);

create index if not exists merch_cdek_shipments_cdek_number_idx
  on public.merch_cdek_shipments (cdek_number)
  where cdek_number is not null;

create index if not exists merch_cdek_events_order_received_idx
  on public.merch_cdek_events (order_id, received_at desc);

create index if not exists merch_cdek_events_shipment_received_idx
  on public.merch_cdek_events (shipment_id, received_at desc);

alter table public.merch_cdek_shipments enable row level security;
alter table public.merch_cdek_events enable row level security;

revoke all on public.merch_cdek_shipments from public, anon, authenticated;
revoke all on public.merch_cdek_events from public, anon, authenticated;

grant select, insert, update, delete on public.merch_cdek_shipments to service_role;
grant select, insert, update, delete on public.merch_cdek_events to service_role;
grant usage, select on sequence public.merch_cdek_shipments_id_seq to service_role;
grant usage, select on sequence public.merch_cdek_events_id_seq to service_role;

drop trigger if exists merch_cdek_shipments_set_updated_at on public.merch_cdek_shipments;
create trigger merch_cdek_shipments_set_updated_at
before update on public.merch_cdek_shipments
for each row execute function private.merch_set_updated_at();

create policy "No direct storefront access to CDEK shipments"
  on public.merch_cdek_shipments
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "No direct storefront access to CDEK events"
  on public.merch_cdek_events
  for all
  to anon, authenticated
  using (false)
  with check (false);
