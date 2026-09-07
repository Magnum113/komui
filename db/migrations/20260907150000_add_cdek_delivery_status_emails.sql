-- CDEK delivery status synchronization and transactional status emails.
--
-- The provider status is intentionally separate from `status`: the latter
-- describes creation/cancellation of the CDEK order, while delivery_status_*
-- describes the physical movement of the parcel.

alter table public.merch_cdek_shipments
  add column if not exists delivery_status_code text,
  add column if not exists delivery_status_name text,
  add column if not exists delivery_status_at timestamptz,
  add column if not exists delivery_status_city text,
  add column if not exists delivery_status_synced_at timestamptz,
  add column if not exists delivery_status_terminal boolean not null default false,
  add column if not exists delivery_status_sync_attempts integer not null default 0,
  add column if not exists delivery_status_sync_error text,
  add column if not exists delivery_status_next_sync_at timestamptz not null default now(),
  add column if not exists planned_delivery_date date,
  add column if not exists keep_free_until timestamptz,
  add column if not exists delivery_mode integer;

alter table public.merch_cdek_shipments
  drop constraint if exists merch_cdek_shipments_delivery_status_sync_attempts_check;
alter table public.merch_cdek_shipments
  add constraint merch_cdek_shipments_delivery_status_sync_attempts_check
  check (delivery_status_sync_attempts >= 0) not valid;
alter table public.merch_cdek_shipments
  validate constraint merch_cdek_shipments_delivery_status_sync_attempts_check;

alter table public.merch_cdek_shipments
  drop constraint if exists merch_cdek_shipments_delivery_mode_check;
alter table public.merch_cdek_shipments
  add constraint merch_cdek_shipments_delivery_mode_check
  check (delivery_mode is null or delivery_mode > 0)
  not valid;
alter table public.merch_cdek_shipments
  validate constraint merch_cdek_shipments_delivery_mode_check;

alter table public.merch_cdek_events
  add column if not exists status_at timestamptz,
  add column if not exists reason_code text,
  add column if not exists status_city text,
  add column if not exists status_deleted boolean not null default false;

create index if not exists merch_cdek_shipments_delivery_sync_due_idx
  on public.merch_cdek_shipments (delivery_status_next_sync_at, id)
  where cdek_uuid is not null
    and delivery_status_terminal is false
    and status not in ('deleting', 'deleted', 'failed', 'invalid');

create index if not exists merch_cdek_events_status_at_idx
  on public.merch_cdek_events (shipment_id, status_at desc)
  where status_at is not null;

comment on column public.merch_cdek_shipments.delivery_status_code is
  'Latest active physical delivery status code returned by CDEK API.';
comment on column public.merch_cdek_shipments.delivery_status_synced_at is
  'Last successful CDEK delivery-status API synchronization.';
comment on column public.merch_cdek_shipments.delivery_status_next_sync_at is
  'Earliest time at which the delivery-status worker may poll this shipment again.';
comment on column public.merch_cdek_shipments.delivery_status_terminal is
  'True after a terminal CDEK delivery status; terminal shipments are not polled.';
comment on column public.merch_cdek_events.status_at is
  'Provider timestamp of the CDEK delivery status, distinct from local received_at.';

do $role_grants$
begin
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute 'grant select, insert, update on public.merch_cdek_shipments to komui_app';
    execute 'grant select, insert on public.merch_cdek_events to komui_app';
    execute 'grant usage, select on sequence public.merch_cdek_shipments_id_seq to komui_app';
    execute 'grant usage, select on sequence public.merch_cdek_events_id_seq to komui_app';
  end if;
end
$role_grants$;

drop policy if exists "Backend access to CDEK shipments"
  on public.merch_cdek_shipments;
drop policy if exists "Backend access to CDEK events"
  on public.merch_cdek_events;

do $role_policies$
begin
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    execute $policy$
      create policy "Backend access to CDEK shipments"
        on public.merch_cdek_shipments for all to komui_app
        using (true) with check (true)
    $policy$;
    execute $policy$
      create policy "Backend access to CDEK events"
        on public.merch_cdek_events for all to komui_app
        using (true) with check (true)
    $policy$;
  end if;
end
$role_policies$;
