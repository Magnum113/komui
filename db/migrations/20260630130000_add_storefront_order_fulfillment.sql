begin;

alter table public.merch_customer_orders
  add column if not exists fulfillment_status text not null default 'new',
  add column if not exists fulfillment_note text,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'merch_customer_orders_fulfillment_status_check'
      and conrelid = 'public.merch_customer_orders'::regclass
  ) then
    alter table public.merch_customer_orders
      add constraint merch_customer_orders_fulfillment_status_check
      check (fulfillment_status in (
        'new',
        'processing',
        'shipped',
        'delivered',
        'canceled',
        'returned'
      ));
  end if;
end
$$;

create index if not exists merch_customer_orders_fulfillment_created_idx
  on public.merch_customer_orders (fulfillment_status, created_at desc);

create index if not exists merch_customer_orders_paid_fulfillment_idx
  on public.merch_customer_orders (paid_at desc, fulfillment_status)
  where paid_at is not null;

comment on column public.merch_customer_orders.fulfillment_status is
  'Internal order processing status for admin workflow, separate from payment status.';
comment on column public.merch_customer_orders.fulfillment_note is
  'Internal admin note for order processing.';
comment on column public.merch_customer_orders.shipped_at is
  'Timestamp when admin marked the storefront order as shipped.';
comment on column public.merch_customer_orders.delivered_at is
  'Timestamp when admin marked the storefront order as delivered.';

commit;
