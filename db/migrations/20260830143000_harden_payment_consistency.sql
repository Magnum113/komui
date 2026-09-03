-- Close the three payment/fulfillment consistency gaps identified in the
-- 2026-08-30 audit. Deploy this migration before starting the backend version
-- that runs the T-Bank reconciliation and CDEK effect workers.

alter table public.merch_customer_orders
  drop constraint if exists merch_customer_orders_status_check;

alter table public.merch_customer_orders
  add constraint merch_customer_orders_status_check
  check (status in (
    'created',
    'pending_payment',
    'payment_unknown',
    'authorized',
    'paid',
    'payment_failed',
    'payment_review',
    'canceled',
    'partially_refunded',
    'refunded'
  )) not valid;

alter table public.merch_customer_orders
  validate constraint merch_customer_orders_status_check;

alter table public.merch_payment_attempts
  add column if not exists reconciliation_attempts integer not null default 0
    check (reconciliation_attempts >= 0),
  add column if not exists reconciliation_next_at timestamptz;

create index if not exists merch_payment_attempts_init_reconcile_idx
  on public.merch_payment_attempts (
    provider_status,
    reconciliation_next_at,
    updated_at,
    id
  )
  where provider = 'tbank'
    and (
      provider_status in ('INITIATING', 'INIT_UNKNOWN', 'RECONCILING_INIT')
      or (
        payment_url is null
        and provider_status in (
          'NEW',
          'FORM_SHOWED',
          'AUTHORIZING',
          '3DS_CHECKING',
          '3DS_CHECKED',
          'AUTH_FAIL',
          'CONFIRMING',
          'REVERSING',
          'REFUNDING'
        )
      )
    );

alter table public.merch_cdek_shipments
  drop constraint if exists merch_cdek_shipments_status_check;

alter table public.merch_cdek_shipments
  add constraint merch_cdek_shipments_status_check
  check (status in (
    'pending',
    'creating',
    'accepted',
    'created',
    'invalid',
    'failed',
    'deleting',
    'deleted',
    'unknown'
  )) not valid;

alter table public.merch_cdek_shipments
  validate constraint merch_cdek_shipments_status_check;

create table if not exists public.merch_order_effects (
  id bigint generated always as identity primary key,
  order_id uuid not null
    references public.merch_customer_orders(id) on delete cascade,
  effect_type text not null
    check (effect_type in ('cdek_create', 'cdek_cancel')),
  dedupe_key text not null unique,
  status text not null default 'pending'
    check (status in (
      'pending',
      'processing',
      'retry',
      'completed',
      'needs_review',
      'canceled'
    )),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists merch_order_effects_due_idx
  on public.merch_order_effects (available_at, id)
  where status in ('pending', 'retry', 'processing');

create index if not exists merch_order_effects_order_idx
  on public.merch_order_effects (order_id, created_at desc);

alter table public.merch_order_effects enable row level security;

-- The managed Supabase database has anon/authenticated/service_role, while the
-- self-hosted databases intentionally use komui_app and do not create those
-- Supabase roles. Keep one migration portable across both environments: a
-- reference to a missing role makes GRANT/REVOKE/CREATE POLICY fail outright.
revoke all on public.merch_order_effects from public;

do $role_grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.merch_order_effects from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.merch_order_effects from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.merch_order_effects to service_role';
    execute 'grant usage, select on sequence public.merch_order_effects_id_seq to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute 'grant select, insert, update on public.merch_order_effects to komui_app';
    execute 'grant usage, select on sequence public.merch_order_effects_id_seq to komui_app';
  end if;
end
$role_grants$;

drop trigger if exists merch_order_effects_set_updated_at
  on public.merch_order_effects;
create trigger merch_order_effects_set_updated_at
before update on public.merch_order_effects
for each row execute function private.merch_set_updated_at();

drop policy if exists "No direct storefront access to order effects"
  on public.merch_order_effects;
drop policy if exists "No direct anon access to order effects"
  on public.merch_order_effects;
drop policy if exists "No direct authenticated access to order effects"
  on public.merch_order_effects;
drop policy if exists "Backend access to order effects"
  on public.merch_order_effects;
drop policy if exists "Service role access to order effects"
  on public.merch_order_effects;

do $role_policies$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute $policy$
      create policy "No direct anon access to order effects"
        on public.merch_order_effects for all to anon
        using (false) with check (false)
    $policy$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute $policy$
      create policy "No direct authenticated access to order effects"
        on public.merch_order_effects for all to authenticated
        using (false) with check (false)
    $policy$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute $policy$
      create policy "Backend access to order effects"
        on public.merch_order_effects for all to komui_app
        using (true) with check (true)
    $policy$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute $policy$
      create policy "Service role access to order effects"
        on public.merch_order_effects for all to service_role
        using (true) with check (true)
    $policy$;
  end if;
end
$role_policies$;

-- A replayed webhook cannot repair fulfillment for events that were already
-- committed by the old implementation. Seed idempotent cancellation intents
-- for historical full refunds/reversals that still have a CDEK record.
insert into public.merch_order_effects (
  order_id,
  effect_type,
  dedupe_key,
  status,
  payload,
  available_at
)
select
  orders.id,
  'cdek_cancel',
  'cdek_cancel:' || orders.id::text,
  'pending',
  jsonb_build_object(
    'source', '20260830143000_historical_refund_backfill',
    'order_status', orders.status
  ),
  now()
from public.merch_customer_orders as orders
join public.merch_cdek_shipments as shipments
  on shipments.order_id = orders.id
where shipments.status <> 'deleted'
  and (
    orders.status = 'refunded'
    or (
      orders.status = 'payment_failed'
      and exists (
        select 1
        from public.merch_payment_attempts as attempts
        where attempts.order_id = orders.id
          and attempts.provider = 'tbank'
          and attempts.provider_status = 'REVERSED'
      )
    )
  )
on conflict (dedupe_key) do nothing;

comment on column public.merch_customer_orders.status is
  'Payment lifecycle. payment_unknown blocks a new order until an ambiguous provider Init is reconciled.';
comment on column public.merch_payment_attempts.reconciliation_attempts is
  'Number of claimed attempts to reconcile an ambiguous T-Bank Init result.';
comment on column public.merch_payment_attempts.reconciliation_next_at is
  'Earliest time at which an ambiguous T-Bank Init may be claimed again.';
comment on table public.merch_order_effects is
  'Durable idempotent fulfillment intents committed with payment transitions and processed outside webhooks.';
