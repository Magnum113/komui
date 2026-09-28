begin;
alter table public.merch_order_effects drop constraint if exists merch_order_effects_effect_type_check;
alter table public.merch_order_effects add constraint merch_order_effects_effect_type_check check (effect_type in ('cdek_create','cdek_cancel','ozon_create','ozon_approve','ozon_cancel'));
create table if not exists public.merch_ozon_delivery_orders (
 order_id uuid primary key references public.merch_customer_orders(id),
 idempotency_key uuid not null unique,
 external_order_number text,
 request_payload jsonb not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.merch_ozon_delivery_shipments (
 id bigint generated always as identity primary key,
 order_id uuid not null references public.merch_customer_orders(id),
 posting_number text not null unique,
 external_order_number text not null,
 status text not null default 'created',
 status_at timestamptz,
 raw jsonb not null default '{}'::jsonb,
 return_data jsonb,
 return_status_at timestamptz,
 error_message text,
 synced_at timestamptz,
 next_sync_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists merch_ozon_delivery_shipments_order_idx on public.merch_ozon_delivery_shipments(order_id);
create index if not exists merch_ozon_delivery_shipments_sync_idx on public.merch_ozon_delivery_shipments(next_sync_at) where status not in ('delivered','canceled');
create table if not exists public.merch_ozon_delivery_events (
 id bigint generated always as identity primary key,
 order_id uuid not null references public.merch_customer_orders(id),
 posting_number text not null,
 status text not null,
 status_at timestamptz not null,
 received_at timestamptz not null default now(),
 unique(posting_number,status,status_at)
);
create table if not exists public.merch_ozon_delivery_points (
 point_id bigint primary key,
 shipment_method_id bigint not null,
 payload jsonb not null,
 refreshed_at timestamptz not null default now()
);
create table if not exists public.merch_ozon_delivery_cache (
 shipment_method_id bigint primary key,
 cursor text,
 return_cursor text,
 refreshing boolean not null default true,
 completed_at timestamptz,
 updated_at timestamptz not null default now()
);
-- Application-only tables; there is no storefront/browser database access.
do $grants$
declare t text; r text;
begin
 foreach t in array array['merch_ozon_delivery_orders','merch_ozon_delivery_shipments','merch_ozon_delivery_events','merch_ozon_delivery_points','merch_ozon_delivery_cache'] loop
  execute format('revoke all on public.%I from public',t);
  foreach r in array array['anon','authenticated'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on public.%I from %I',t,r); end if;
  end loop;
  foreach r in array array['komui_app','service_role'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('grant select, insert, update, delete on public.%I to %I',t,r); end if;
  end loop;
 end loop;
 foreach r in array array['komui_app','service_role'] loop
  if exists(select 1 from pg_roles where rolname=r) then
   execute format('grant usage, select on sequence public.merch_ozon_delivery_shipments_id_seq, public.merch_ozon_delivery_events_id_seq to %I',r);
  end if;
 end loop;
end $grants$;
-- Enqueue in the same database transaction as *every* bank/webhook/reconciliation
-- transition; these jobs remain durable when the provider worker is disabled.
create or replace function public.komui_enqueue_ozon_financial_effect() returns trigger language plpgsql as $$
declare effect text;
begin
 if new.delivery_provider <> 'ozon' or new.status is not distinct from old.status then return new; end if;
 if new.status='paid' then effect:='ozon_create';
 elsif new.status in ('refunded','payment_failed') or (new.status='payment_review' and old.status in ('paid','partially_refunded')) then effect:='ozon_cancel';
 else return new; end if;
 insert into public.merch_order_effects(order_id,effect_type,dedupe_key,payload)
 values(new.id,effect,effect||':'||new.id::text||':all',jsonb_build_object('reason','financial_transition','from',old.status,'to',new.status))
 on conflict(dedupe_key) do update set
 status=case when merch_order_effects.status='processing' then 'processing' else 'pending' end,
 payload=excluded.payload, available_at=now(),updated_at=now(),
 attempts=case when merch_order_effects.status='processing' then merch_order_effects.attempts else 0 end;
 return new;
end $$;
drop trigger if exists komui_ozon_financial_effect on public.merch_customer_orders;
create trigger komui_ozon_financial_effect after update of status on public.merch_customer_orders for each row execute function public.komui_enqueue_ozon_financial_effect();
commit;
