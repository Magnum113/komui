-- Unified email contacts and evidence-backed footer subscriptions.
-- This migration is used by the self-hosted PostgreSQL deployment. It does
-- not add or modify any Supabase Edge Function or legacy checkout RPC flow.

create table if not exists public.merch_email_contacts (
  id uuid primary key default gen_random_uuid(),
  email_normalized text not null unique
    check (
      email_normalized = lower(btrim(email_normalized))
      and email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    ),
  display_name text check (display_name is null or length(display_name) between 1 and 160),
  marketing_status text not null default 'not_subscribed'
    check (marketing_status in (
      'not_subscribed',
      'pending',
      'subscribed',
      'unsubscribed',
      'bounced',
      'complained',
      'suppressed'
    )),
  marketing_consent_at timestamptz,
  marketing_consent_version text,
  marketing_consent_source text
    check (
      marketing_consent_source is null
      or marketing_consent_source in ('checkout', 'footer', 'admin', 'legacy_import')
    ),
  confirmation_token_hash text unique
    check (confirmation_token_hash is null or confirmation_token_hash ~ '^[0-9a-f]{64}$'),
  confirmation_expires_at timestamptz,
  confirmation_sent_at timestamptz,
  first_paid_order_at timestamptz,
  last_paid_order_at timestamptz,
  paid_orders_count integer not null default 0 check (paid_orders_count >= 0),
  paid_orders_amount bigint not null default 0 check (paid_orders_amount >= 0),
  last_email_sent_at timestamptz,
  unsubscribed_at timestamptz,
  suppression_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    marketing_status <> 'subscribed'
    or (
      marketing_consent_at is not null
      and marketing_consent_version is not null
      and marketing_consent_source is not null
    )
  ),
  check (
    (confirmation_token_hash is null and confirmation_expires_at is null)
    or (confirmation_token_hash is not null and confirmation_expires_at is not null)
  )
);

create index if not exists merch_email_contacts_status_idx
  on public.merch_email_contacts (marketing_status, updated_at desc);
create index if not exists merch_email_contacts_confirmation_expiry_idx
  on public.merch_email_contacts (confirmation_expires_at)
  where confirmation_token_hash is not null;

drop trigger if exists merch_email_contacts_set_updated_at
  on public.merch_email_contacts;
create trigger merch_email_contacts_set_updated_at
before update on public.merch_email_contacts
for each row execute function private.merch_set_updated_at();

comment on table public.merch_email_contacts is
  'One normalized KOMUI email contact with current marketing state and aggregate paid-order facts.';
comment on column public.merch_email_contacts.confirmation_token_hash is
  'SHA-256 of the current one-time footer confirmation token; the raw token is never stored here.';

create table if not exists public.merch_email_consent_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (length(event_key) between 8 and 200),
  contact_id uuid not null references public.merch_email_contacts(id) on delete cascade,
  order_id uuid references public.merch_customer_orders(id) on delete set null,
  action text not null check (action in ('requested', 'granted', 'confirmed', 'revoked')),
  channel text not null default 'email' check (channel = 'email'),
  source text not null
    check (source in ('checkout', 'footer', 'admin', 'unsubscribe', 'provider', 'legacy_import')),
  occurred_at timestamptz not null default now(),
  consent_text_version text not null check (length(consent_text_version) between 1 and 100),
  privacy_policy_version text not null check (length(privacy_policy_version) between 1 and 100),
  request_ip_hash text check (request_ip_hash is null or request_ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  confirmation_token_hash text
    check (confirmation_token_hash is null or confirmation_token_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists merch_email_consent_events_contact_idx
  on public.merch_email_consent_events (contact_id, occurred_at desc);
create index if not exists merch_email_consent_events_order_idx
  on public.merch_email_consent_events (order_id, occurred_at desc)
  where order_id is not null;
create index if not exists merch_email_consent_events_confirmation_idx
  on public.merch_email_consent_events (confirmation_token_hash)
  where action = 'confirmed' and confirmation_token_hash is not null;

comment on table public.merch_email_consent_events is
  'Append-only evidence of requested, granted, confirmed and revoked email consent.';

alter table public.merch_email_outbox
  add column if not exists contact_id uuid
    references public.merch_email_contacts(id) on delete set null;

create index if not exists merch_email_outbox_contact_idx
  on public.merch_email_outbox (contact_id, created_at desc)
  where contact_id is not null;

-- Backfill one contact per order email. Existing suppressions remain stronger
-- than historical marketing consent.
with normalized_orders as (
  select
    lower(btrim(customer_email)) as email_normalized,
    nullif(btrim(concat_ws(' ', customer_first_name, customer_last_name)), '') as display_name,
    marketing_consent,
    coalesce(marketing_consent_at, created_at) as consent_at,
    coalesce(nullif(marketing_consent_version, ''), 'legacy-unknown') as consent_version,
    coalesce(nullif(marketing_consent_source, ''), 'legacy_checkout') as consent_source,
    paid_at,
    total_amount,
    created_at
  from public.merch_customer_orders
  where customer_email is not null
    and btrim(customer_email) <> ''
), latest as (
  select distinct on (email_normalized)
    email_normalized,
    display_name
  from normalized_orders
  order by email_normalized, created_at desc
), consent as (
  select distinct on (email_normalized)
    email_normalized,
    consent_at,
    consent_version,
    consent_source
  from normalized_orders
  where marketing_consent is true
  order by email_normalized, consent_at desc
), paid as (
  select
    email_normalized,
    min(paid_at) as first_paid_order_at,
    max(paid_at) as last_paid_order_at,
    count(*) filter (where paid_at is not null)::integer as paid_orders_count,
    coalesce(sum(total_amount) filter (where paid_at is not null), 0)::bigint as paid_orders_amount
  from normalized_orders
  group by email_normalized
)
insert into public.merch_email_contacts (
  email_normalized,
  display_name,
  marketing_status,
  marketing_consent_at,
  marketing_consent_version,
  marketing_consent_source,
  first_paid_order_at,
  last_paid_order_at,
  paid_orders_count,
  paid_orders_amount,
  unsubscribed_at,
  suppression_reason
)
select
  latest.email_normalized,
  latest.display_name,
  case suppressions.reason
    when 'unsubscribed' then 'unsubscribed'
    when 'hard_bounce' then 'bounced'
    when 'spam_complaint' then 'complained'
    when 'manual' then 'suppressed'
    else case when consent.email_normalized is not null then 'subscribed' else 'not_subscribed' end
  end,
  consent.consent_at,
  consent.consent_version,
  case consent.consent_source
    when 'checkout' then 'checkout'
    else 'legacy_import'
  end,
  paid.first_paid_order_at,
  paid.last_paid_order_at,
  paid.paid_orders_count,
  paid.paid_orders_amount,
  case when suppressions.reason = 'unsubscribed' then suppressions.updated_at else null end,
  suppressions.reason
from latest
left join consent using (email_normalized)
left join paid using (email_normalized)
left join public.merch_email_suppressions suppressions using (email_normalized)
on conflict (email_normalized) do nothing;

insert into public.merch_email_consent_events (
  event_key,
  contact_id,
  order_id,
  action,
  source,
  occurred_at,
  consent_text_version,
  privacy_policy_version,
  metadata
)
select
  'legacy-checkout-granted:' || orders.id::text,
  contacts.id,
  orders.id,
  'granted',
  case when orders.marketing_consent_source = 'checkout' then 'checkout' else 'legacy_import' end,
  coalesce(orders.marketing_consent_at, orders.created_at),
  coalesce(nullif(orders.marketing_consent_version, ''), 'legacy-unknown'),
  'legacy-unknown',
  jsonb_build_object('backfilled', true)
from public.merch_customer_orders orders
join public.merch_email_contacts contacts
  on contacts.email_normalized = lower(btrim(orders.customer_email))
where orders.marketing_consent is true
on conflict (event_key) do nothing;

update public.merch_email_outbox outbox
set contact_id = contacts.id
from public.merch_email_contacts contacts
where outbox.contact_id is null
  and contacts.email_normalized = lower(btrim(outbox.recipient_email));

create or replace function private.merch_sync_email_contact_suppression()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.merch_email_contacts
  set
    marketing_status = case new.reason
      when 'unsubscribed' then 'unsubscribed'
      when 'hard_bounce' then 'bounced'
      when 'spam_complaint' then 'complained'
      else 'suppressed'
    end,
    unsubscribed_at = case when new.reason = 'unsubscribed' then now() else unsubscribed_at end,
    suppression_reason = new.reason,
    confirmation_token_hash = null,
    confirmation_expires_at = null
  where email_normalized = new.email_normalized;
  return new;
end;
$$;

drop trigger if exists merch_email_suppressions_sync_contact
  on public.merch_email_suppressions;
create trigger merch_email_suppressions_sync_contact
after insert or update of reason on public.merch_email_suppressions
for each row execute function private.merch_sync_email_contact_suppression();

create or replace function private.merch_refresh_email_contact_order_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_email text;
begin
  target_email := lower(btrim(new.customer_email));
  update public.merch_email_contacts contacts
  set
    first_paid_order_at = stats.first_paid_order_at,
    last_paid_order_at = stats.last_paid_order_at,
    paid_orders_count = stats.paid_orders_count,
    paid_orders_amount = stats.paid_orders_amount
  from (
    select
      min(paid_at) as first_paid_order_at,
      max(paid_at) as last_paid_order_at,
      count(*) filter (where paid_at is not null)::integer as paid_orders_count,
      coalesce(sum(total_amount) filter (where paid_at is not null), 0)::bigint as paid_orders_amount
    from public.merch_customer_orders
    where lower(btrim(customer_email)) = target_email
  ) stats
  where contacts.email_normalized = target_email;
  return new;
end;
$$;

drop trigger if exists merch_customer_orders_refresh_email_contact_stats
  on public.merch_customer_orders;
create trigger merch_customer_orders_refresh_email_contact_stats
after insert or update of paid_at, total_amount, customer_email
on public.merch_customer_orders
for each row execute function private.merch_refresh_email_contact_order_stats();

create or replace function private.merch_email_outbox_sync_contact_sent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' and new.contact_id is not null then
    update public.merch_email_contacts
    set last_email_sent_at = coalesce(new.sent_at, now())
    where id = new.contact_id;
  end if;
  return new;
end;
$$;

drop trigger if exists merch_email_outbox_sync_contact_sent
  on public.merch_email_outbox;
create trigger merch_email_outbox_sync_contact_sent
after update of status on public.merch_email_outbox
for each row execute function private.merch_email_outbox_sync_contact_sent();

alter table public.merch_email_contacts enable row level security;
alter table public.merch_email_consent_events enable row level security;

revoke all on public.merch_email_contacts from public;
revoke all on public.merch_email_consent_events from public;

drop policy if exists "No direct anon access to email contacts" on public.merch_email_contacts;
drop policy if exists "No direct anon access to email consent events" on public.merch_email_consent_events;
drop policy if exists "No direct authenticated access to email contacts" on public.merch_email_contacts;
drop policy if exists "No direct authenticated access to email consent events" on public.merch_email_consent_events;
drop policy if exists "Service role access to email contacts" on public.merch_email_contacts;
drop policy if exists "Service role access to email consent events" on public.merch_email_consent_events;
drop policy if exists "Backend access to email contacts" on public.merch_email_contacts;
drop policy if exists "Backend insert access to email consent events" on public.merch_email_consent_events;
drop policy if exists "Backend read access to email consent events" on public.merch_email_consent_events;

do $role_grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.merch_email_contacts from anon';
    execute 'revoke all on public.merch_email_consent_events from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.merch_email_contacts from authenticated';
    execute 'revoke all on public.merch_email_consent_events from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.merch_email_contacts to service_role';
    execute 'grant select, insert, update, delete on public.merch_email_consent_events to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute 'grant select, insert, update on public.merch_email_contacts to komui_app';
    execute 'grant select, insert on public.merch_email_consent_events to komui_app';
  end if;
end
$role_grants$;

do $role_policies$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy "No direct anon access to email contacts" on public.merch_email_contacts for all to anon using (false) with check (false)';
    execute 'create policy "No direct anon access to email consent events" on public.merch_email_consent_events for all to anon using (false) with check (false)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'create policy "No direct authenticated access to email contacts" on public.merch_email_contacts for all to authenticated using (false) with check (false)';
    execute 'create policy "No direct authenticated access to email consent events" on public.merch_email_consent_events for all to authenticated using (false) with check (false)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'create policy "Service role access to email contacts" on public.merch_email_contacts for all to service_role using (true) with check (true)';
    execute 'create policy "Service role access to email consent events" on public.merch_email_consent_events for all to service_role using (true) with check (true)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute 'create policy "Backend access to email contacts" on public.merch_email_contacts for all to komui_app using (true) with check (true)';
    execute 'create policy "Backend insert access to email consent events" on public.merch_email_consent_events for insert to komui_app with check (true)';
    execute 'create policy "Backend read access to email consent events" on public.merch_email_consent_events for select to komui_app using (true)';
  end if;
end
$role_policies$;
