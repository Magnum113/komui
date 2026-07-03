alter table if exists public.merch_storefront_products
  add column if not exists size_chart_json jsonb;

comment on column public.merch_storefront_products.size_chart_json is
  'Ozon size chart JSON from product attribute 13164. Rendered as storefront size table.';
