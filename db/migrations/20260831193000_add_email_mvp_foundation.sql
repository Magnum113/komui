-- Email MVP phase 2: durable consent evidence, outbox and suppressions.
-- Apply before deploying the matching backend. The insert trigger keeps the
-- migration compatible with an older checkout during a rolling deployment.

alter table public.merch_customer_orders
  add column if not exists marketing_consent_at timestamptz,
  add column if not exists marketing_consent_version text,
  add column if not exists marketing_consent_source text;

update public.merch_customer_orders
set
  marketing_consent_at = coalesce(marketing_consent_at, created_at),
  marketing_consent_version = coalesce(
    nullif(marketing_consent_version, ''),
    'legacy-unknown'
  ),
  marketing_consent_source = coalesce(
    nullif(marketing_consent_source, ''),
    'legacy_checkout'
  )
where marketing_consent is true;

update public.merch_customer_orders
set
  marketing_consent_at = null,
  marketing_consent_version = null,
  marketing_consent_source = null
where marketing_consent is false;

create or replace function private.merch_fill_marketing_consent_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.marketing_consent is true then
    new.marketing_consent_at := coalesce(new.marketing_consent_at, now());
    new.marketing_consent_version := coalesce(
      nullif(new.marketing_consent_version, ''),
      'legacy-unknown'
    );
    new.marketing_consent_source := coalesce(
      nullif(new.marketing_consent_source, ''),
      'legacy_checkout'
    );
  else
    new.marketing_consent_at := null;
    new.marketing_consent_version := null;
    new.marketing_consent_source := null;
  end if;
  return new;
end;
$$;

drop trigger if exists merch_customer_orders_fill_marketing_consent_evidence
  on public.merch_customer_orders;
create trigger merch_customer_orders_fill_marketing_consent_evidence
before insert on public.merch_customer_orders
for each row execute function private.merch_fill_marketing_consent_evidence();

alter table public.merch_customer_orders
  drop constraint if exists merch_customer_orders_marketing_consent_evidence_check;
alter table public.merch_customer_orders
  add constraint merch_customer_orders_marketing_consent_evidence_check
  check (
    (
      marketing_consent is false
      and marketing_consent_at is null
      and marketing_consent_version is null
      and marketing_consent_source is null
    )
    or
    (
      marketing_consent is true
      and marketing_consent_at is not null
      and marketing_consent_version is not null
      and length(marketing_consent_version) between 1 and 80
      and marketing_consent_source in ('checkout', 'legacy_checkout')
    )
  ) not valid;
alter table public.merch_customer_orders
  validate constraint merch_customer_orders_marketing_consent_evidence_check;

comment on column public.merch_customer_orders.marketing_consent_at is
  'Checkout timestamp at which optional email marketing consent was recorded; legacy rows use order creation time.';
comment on column public.merch_customer_orders.marketing_consent_version is
  'Version identifier of the marketing consent text shown at checkout.';
comment on column public.merch_customer_orders.marketing_consent_source is
  'Evidence source: checkout for the current flow, legacy_checkout for migrated or old-client rows.';

create table if not exists public.merch_email_outbox (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.merch_customer_orders(id) on delete set null,
  event_type text not null
    check (event_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  message_class text not null
    check (message_class in ('transactional', 'marketing')),
  recipient_email text not null
    check (
      recipient_email = lower(btrim(recipient_email))
      and recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    ),
  template_key text not null
    check (template_key ~ '^[a-z][a-z0-9_-]{1,79}$'),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  scheduled_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in (
      'pending',
      'processing',
      'retry',
      'sent',
      'failed',
      'cancelled'
    )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  failed_at timestamptz,
  idempotency_key text not null unique
    check (length(idempotency_key) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists merch_email_outbox_due_idx
  on public.merch_email_outbox (
    coalesce(next_attempt_at, scheduled_at),
    created_at,
    id
  )
  where status in ('pending', 'retry', 'processing');

create index if not exists merch_email_outbox_order_idx
  on public.merch_email_outbox (order_id, created_at desc)
  where order_id is not null;

drop trigger if exists merch_email_outbox_set_updated_at
  on public.merch_email_outbox;
create trigger merch_email_outbox_set_updated_at
before update on public.merch_email_outbox
for each row execute function private.merch_set_updated_at();

comment on table public.merch_email_outbox is
  'Durable idempotent email jobs. Payment and fulfillment transactions enqueue work; a separate worker sends it.';
comment on column public.merch_email_outbox.idempotency_key is
  'Stable unique event key such as order-paid:<order-id>, preventing duplicate messages.';

create table if not exists public.merch_email_suppressions (
  email_normalized text primary key
    check (
      email_normalized = lower(btrim(email_normalized))
      and email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    ),
  reason text not null
    check (reason in ('unsubscribed', 'hard_bounce', 'spam_complaint', 'manual')),
  source text not null check (length(btrim(source)) between 1 and 80),
  provider_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists merch_email_suppressions_set_updated_at
  on public.merch_email_suppressions;
create trigger merch_email_suppressions_set_updated_at
before update on public.merch_email_suppressions
for each row execute function private.merch_set_updated_at();

comment on table public.merch_email_suppressions is
  'Normalized addresses blocked after unsubscribe, hard bounce, complaint or a manual decision.';

alter table public.merch_email_outbox enable row level security;
alter table public.merch_email_suppressions enable row level security;

revoke all on public.merch_email_outbox from public;
revoke all on public.merch_email_suppressions from public;

drop policy if exists "No direct anon access to email outbox"
  on public.merch_email_outbox;
drop policy if exists "No direct anon access to email suppressions"
  on public.merch_email_suppressions;
drop policy if exists "No direct authenticated access to email outbox"
  on public.merch_email_outbox;
drop policy if exists "No direct authenticated access to email suppressions"
  on public.merch_email_suppressions;
drop policy if exists "Service role access to email outbox"
  on public.merch_email_outbox;
drop policy if exists "Service role access to email suppressions"
  on public.merch_email_suppressions;
drop policy if exists "Backend access to email outbox"
  on public.merch_email_outbox;
drop policy if exists "Backend access to email suppressions"
  on public.merch_email_suppressions;

do $role_grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.merch_email_outbox from anon';
    execute 'revoke all on public.merch_email_suppressions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.merch_email_outbox from authenticated';
    execute 'revoke all on public.merch_email_suppressions from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.merch_email_outbox to service_role';
    execute 'grant select, insert, update, delete on public.merch_email_suppressions to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute 'grant select, insert, update on public.merch_email_outbox to komui_app';
    execute 'grant select, insert, update on public.merch_email_suppressions to komui_app';
  end if;
end
$role_grants$;

do $role_policies$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute $policy$
      create policy "No direct anon access to email outbox"
        on public.merch_email_outbox for all to anon
        using (false) with check (false)
    $policy$;
    execute $policy$
      create policy "No direct anon access to email suppressions"
        on public.merch_email_suppressions for all to anon
        using (false) with check (false)
    $policy$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute $policy$
      create policy "No direct authenticated access to email outbox"
        on public.merch_email_outbox for all to authenticated
        using (false) with check (false)
    $policy$;
    execute $policy$
      create policy "No direct authenticated access to email suppressions"
        on public.merch_email_suppressions for all to authenticated
        using (false) with check (false)
    $policy$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute $policy$
      create policy "Service role access to email outbox"
        on public.merch_email_outbox for all to service_role
        using (true) with check (true)
    $policy$;
    execute $policy$
      create policy "Service role access to email suppressions"
        on public.merch_email_suppressions for all to service_role
        using (true) with check (true)
    $policy$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute $policy$
      create policy "Backend access to email outbox"
        on public.merch_email_outbox for all to komui_app
        using (true) with check (true)
    $policy$;
    execute $policy$
      create policy "Backend access to email suppressions"
        on public.merch_email_suppressions for all to komui_app
        using (true) with check (true)
    $policy$;
  end if;
end
$role_policies$;
