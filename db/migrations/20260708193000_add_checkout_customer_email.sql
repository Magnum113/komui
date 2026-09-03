alter table if exists public.merch_customer_orders
  add column if not exists customer_email text;

create index if not exists merch_customer_orders_email_created_idx
  on public.merch_customer_orders (customer_email, created_at desc)
  where customer_email is not null;

comment on column public.merch_customer_orders.customer_email is
  'Customer email collected at checkout and passed to payment fiscal receipt provider.';

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
    customer_email,
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
    nullif(p_order ->> 'customer_email', ''),
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
