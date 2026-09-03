begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.merch_storefront_products
  add column if not exists variant_group_key text,
  add column if not exists hoodie_fit_slug text,
  add column if not exists hoodie_fleece_slug text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.merch_storefront_products'::regclass
      and conname = 'merch_storefront_products_hoodie_variant_check'
  ) then
    alter table public.merch_storefront_products
      add constraint merch_storefront_products_hoodie_variant_check
      check (
        (
          variant_group_key is null
          and hoodie_fit_slug is null
          and hoodie_fleece_slug is null
          and (
            product_type_slug is distinct from 'hoodie'
            or is_active is not true
          )
        )
        or
        (
          variant_group_key is not null
          and product_type_slug = 'hoodie'
          and hoodie_fit_slug in ('regular', 'cropped')
          and hoodie_fleece_slug in ('fleece', 'no-fleece')
        )
      ) not valid;
  end if;
end
$$;

create or replace function private.merch_storefront_offers_have_unique_selectable_sizes(
  candidate_offers jsonb
)
returns boolean
language sql
immutable
parallel safe
strict
set search_path = pg_catalog
as $$
  select case
    when pg_catalog.jsonb_typeof(candidate_offers) <> 'array' then false
    else not exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_offers) as item(offer)
      where item.offer -> 'archived' is distinct from 'true'::jsonb
        and item.offer -> 'visible' is distinct from 'false'::jsonb
        and (
          pg_catalog.jsonb_typeof(item.offer) <> 'object'
          or coalesce(pg_catalog.jsonb_typeof(item.offer -> 'offer_id'), 'null') <> 'string'
          or coalesce(pg_catalog.jsonb_typeof(item.offer -> 'size'), 'null') <> 'string'
          or nullif(pg_catalog.btrim(item.offer ->> 'offer_id'), '') is null
          or nullif(pg_catalog.btrim(item.offer ->> 'size'), '') is null
        )
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_offers) as item(offer)
      where item.offer -> 'archived' is distinct from 'true'::jsonb
        and item.offer -> 'visible' is distinct from 'false'::jsonb
      group by pg_catalog.upper(pg_catalog.btrim(item.offer ->> 'size'))
      having pg_catalog.count(*) > 1
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_offers) as item(offer)
      where item.offer -> 'archived' is distinct from 'true'::jsonb
        and item.offer -> 'visible' is distinct from 'false'::jsonb
      group by pg_catalog.btrim(item.offer ->> 'offer_id')
      having pg_catalog.count(*) > 1
    )
  end;
$$;

comment on function private.merch_storefront_offers_have_unique_selectable_sizes(jsonb)
  is 'Pure row-level invariant: every checkout-selectable storefront offer has an ID and a unique normalized size.';

revoke all on function private.merch_storefront_offers_have_unique_selectable_sizes(jsonb)
  from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'komui_app') then
    grant execute on function private.merch_storefront_offers_have_unique_selectable_sizes(jsonb)
      to komui_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function private.merch_storefront_offers_have_unique_selectable_sizes(jsonb)
      to service_role;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.merch_storefront_products'::regclass
      and conname = 'merch_storefront_products_unique_selectable_offer_size_check'
  ) then
    alter table public.merch_storefront_products
      add constraint merch_storefront_products_unique_selectable_offer_size_check
      check (private.merch_storefront_offers_have_unique_selectable_sizes(offers))
      not valid;
  end if;
end
$$;

do $$
declare
  gta_offer_ids text[];
  gravity_offer_ids text[];
begin
  perform 1
  from public.merch_storefront_products
  where id in (
    '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
    '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid
  )
  for update;

  if (select count(*) from public.merch_storefront_products where id in (
    '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
    '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid
  )) <> 2 then
    raise exception 'hoodie split aborted: source products are missing';
  end if;

  if exists (
    select 1
    from public.merch_storefront_products
    where id in (
      '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
      'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
    )
  ) then
    raise exception 'hoodie split aborted: target UUID collision or migration already applied';
  end if;

  if exists (
    select 1
    from public.merch_customer_order_items
    where product_id in (
      '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
      '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid
    )
  ) then
    raise exception 'hoodie split aborted: source products have order history';
  end if;

  select pg_catalog.array_agg(item.offer_id order by item.offer_id)
  into gta_offer_ids
  from (
    select offer ->> 'offer_id' as offer_id
    from public.merch_storefront_products product
    cross join lateral pg_catalog.jsonb_array_elements(product.offers) as item(offer)
    where product.id = '8d6fe381-f203-4861-8108-60d3251dae18'::uuid
  ) as item;

  if gta_offer_ids is distinct from array[
    'D18-HDY-EMB-BLK-CRP-NF-L',
    'D18-HDY-EMB-BLK-CRP-NF-M',
    'D18-HDY-EMB-BLK-CRP-NF-S',
    'D18-HDY-EMB-BLK-REG-NF-2XL',
    'D18-HDY-EMB-BLK-REG-NF-L',
    'D18-HDY-EMB-BLK-REG-NF-M',
    'D18-HDY-EMB-BLK-REG-NF-S',
    'D18-HDY-EMB-BLK-REG-NF-XL'
  ]::text[] then
    raise exception 'hoodie split aborted: unexpected GTA offer set: %', gta_offer_ids;
  end if;

  select pg_catalog.array_agg(item.offer_id order by item.offer_id)
  into gravity_offer_ids
  from (
    select offer ->> 'offer_id' as offer_id
    from public.merch_storefront_products product
    cross join lateral pg_catalog.jsonb_array_elements(product.offers) as item(offer)
    where product.id = '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid
  ) as item;

  if gravity_offer_ids is distinct from array[
    'D8-HDY-EMB-WHT-REG-FLC-S',
    'D8-HDY-EMB-WHT-REG-NF-2XL',
    'D8-HDY-EMB-WHT-REG-NF-L',
    'D8-HDY-EMB-WHT-REG-NF-M',
    'D8-HDY-EMB-WHT-REG-NF-S',
    'D8-HDY-EMB-WHT-REG-NF-XL'
  ]::text[] then
    raise exception 'hoodie split aborted: unexpected Gravity offer set: %', gravity_offer_ids;
  end if;
end
$$;

create or replace function private.merch_storefront_image_urls_from_offers(
  candidate_offers jsonb
)
returns text[]
language sql
immutable
parallel safe
strict
set search_path = pg_catalog
as $$
  with candidates as (
    select
      nullif(offer.item ->> 'primary_image', '') as image_url,
      offer.ordinality * 1000 as position
    from pg_catalog.jsonb_array_elements(candidate_offers)
      with ordinality as offer(item, ordinality)

    union all

    select
      nullif(image.url, '') as image_url,
      offer.ordinality * 1000 + image.ordinality as position
    from pg_catalog.jsonb_array_elements(candidate_offers)
      with ordinality as offer(item, ordinality)
    cross join lateral pg_catalog.jsonb_array_elements_text(
      case
        when pg_catalog.jsonb_typeof(offer.item -> 'images') = 'array'
          then offer.item -> 'images'
        else '[]'::jsonb
      end
    ) with ordinality as image(url, ordinality)
  ), unique_images as (
    select image_url, pg_catalog.min(position) as position
    from candidates
    where image_url is not null
      and image_url <> 'https://ir.ozone.ru/s3/multimedia-1-4/12069341824.jpg'
    group by image_url
  )
  select coalesce(
    pg_catalog.array_agg(image_url order by position, image_url),
    '{}'::text[]
  )
  from unique_images;
$$;

with source as (
  select product.*,
    (
      select coalesce(
        pg_catalog.jsonb_agg(item.offer order by item.ordinality),
        '[]'::jsonb
      )
      from pg_catalog.jsonb_array_elements(product.offers)
        with ordinality as item(offer, ordinality)
      where item.offer ->> 'offer_id' = any(array[
        'D18-HDY-EMB-BLK-CRP-NF-S',
        'D18-HDY-EMB-BLK-CRP-NF-M',
        'D18-HDY-EMB-BLK-CRP-NF-L'
      ]::text[])
    ) as selected_offers
  from public.merch_storefront_products as product
  where product.id = '8d6fe381-f203-4861-8108-60d3251dae18'::uuid
)
insert into public.merch_storefront_products (
  id,
  design_key,
  ozon_variant,
  name,
  slug,
  description,
  ozon_description,
  category,
  category_slug,
  product_type,
  product_type_slug,
  decoration_type,
  decoration_slug,
  color_name,
  color_slug,
  color_hex,
  franchise_type,
  title_name,
  title_slug,
  anime_title,
  anime_slug,
  character_name,
  character_slug,
  collection_name,
  collection_slug,
  design_name,
  design_slug,
  tags,
  sizes,
  price_min,
  price_max,
  currency,
  primary_image_url,
  main_image_path,
  image_urls,
  ozon_product_ids,
  ozon_skus,
  ozon_offer_ids,
  offers,
  ozon_attributes,
  source_payload,
  is_active,
  sort_order,
  created_at,
  updated_at,
  short_description,
  badges,
  sales_6m_units,
  sales_6m_revenue,
  sales_6m_rank,
  sales_6m_period_start,
  sales_6m_period_end,
  sales_6m_updated_at,
  compare_at_price,
  size_chart_json,
  variant_group_key,
  hoodie_fit_slug,
  hoodie_fleece_slug
)
select
  '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
  'var18|embroidery|hoodie|black|crp|nf',
  source.ozon_variant,
  'Худи GTA — укороченное, без начёса',
  'ukorochennoe-hudi-grand-theft-auto-gta-bez-nachesa-vyshivka-chernaya',
  'Укороченное чёрное худи без начёса с машинной вышивкой по мотивам GTA. Плотный футер трёхнитка держит форму, а укороченная посадка создаёт более компактный силуэт. Состав: 100% хлопок (пенье). Плотность: 370 г/м². Уход: машинная стирка при 30 °C, гладить с изнанки, не отбеливать.',
  'Укороченное чёрное худи без начёса с машинной вышивкой по мотивам GTA. Плотный футер трёхнитка держит форму, а укороченная посадка создаёт более компактный силуэт. Состав: 100% хлопок (пенье). Плотность: 370 г/м². Уход: машинная стирка при 30 °C, гладить с изнанки, не отбеливать.',
  source.category,
  source.category_slug,
  source.product_type,
  source.product_type_slug,
  source.decoration_type,
  source.decoration_slug,
  source.color_name,
  source.color_slug,
  source.color_hex,
  source.franchise_type,
  source.title_name,
  source.title_slug,
  source.anime_title,
  source.anime_slug,
  source.character_name,
  source.character_slug,
  source.collection_name,
  source.collection_slug,
  source.design_name,
  source.design_slug,
  source.tags || array['cropped', 'no-fleece']::text[],
  array['S', 'M', 'L']::text[],
  source.price_min,
  source.price_max,
  source.currency,
  (source.selected_offers -> 0) ->> 'primary_image',
  (source.selected_offers -> 0) ->> 'primary_image',
  private.merch_storefront_image_urls_from_offers(source.selected_offers),
  array(
    select distinct (item.offer ->> 'product_id')::bigint
    from pg_catalog.jsonb_array_elements(source.selected_offers) as item(offer)
    order by (item.offer ->> 'product_id')::bigint
  ),
  array(
    select distinct (item.offer ->> 'sku')::bigint
    from pg_catalog.jsonb_array_elements(source.selected_offers) as item(offer)
    order by (item.offer ->> 'sku')::bigint
  ),
  array(
    select item.offer ->> 'offer_id'
    from pg_catalog.jsonb_array_elements(source.selected_offers)
      with ordinality as item(offer, ordinality)
    order by item.ordinality
  ),
  source.selected_offers,
  source.ozon_attributes,
  source.source_payload || pg_catalog.jsonb_build_object(
    'catalog_variant_split',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'source_product_id', source.id,
      'created_at', pg_catalog.transaction_timestamp()
    )
  ),
  source.is_active,
  source.sort_order,
  pg_catalog.now(),
  pg_catalog.now(),
  'Укороченная посадка, плотный футер без начёса и аккуратная вышивка GTA.',
  array['Укороченное', 'Без начёса']::text[],
  0,
  0,
  null,
  source.sales_6m_period_start,
  source.sales_6m_period_end,
  source.sales_6m_updated_at,
  source.compare_at_price,
  null,
  'var18|embroidery|hoodie|black',
  'cropped',
  'no-fleece'
from source;

with source as (
  select product.*,
    (
      select coalesce(
        pg_catalog.jsonb_agg(item.offer order by item.ordinality),
        '[]'::jsonb
      )
      from pg_catalog.jsonb_array_elements(product.offers)
        with ordinality as item(offer, ordinality)
      where item.offer ->> 'offer_id' = 'D8-HDY-EMB-WHT-REG-FLC-S'
    ) as selected_offers
  from public.merch_storefront_products as product
  where product.id = '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid
)
insert into public.merch_storefront_products (
  id, design_key, ozon_variant, name, slug, description, ozon_description,
  category, category_slug, product_type, product_type_slug, decoration_type,
  decoration_slug, color_name, color_slug, color_hex, franchise_type,
  title_name, title_slug, anime_title, anime_slug, character_name,
  character_slug, collection_name, collection_slug, design_name, design_slug,
  tags, sizes, price_min, price_max, currency, primary_image_url,
  main_image_path, image_urls, ozon_product_ids, ozon_skus, ozon_offer_ids,
  offers, ozon_attributes, source_payload, is_active, sort_order, created_at,
  updated_at, short_description, badges, sales_6m_units, sales_6m_revenue,
  sales_6m_rank, sales_6m_period_start, sales_6m_period_end,
  sales_6m_updated_at, compare_at_price, size_chart_json, variant_group_key,
  hoodie_fit_slug, hoodie_fleece_slug
)
select
  'f3986f1d-c338-589a-bd90-e6745fced385'::uuid,
  'var8|embroidery|hoodie|white|reg|flc',
  source.ozon_variant,
  'Худи Gravity белое — обычное, с начёсом',
  'hudi-gravity-s-nachesom-vyshivka-belaya',
  'Белое худи Gravity с начёсом и машинной вышивкой. Обычная свободная посадка, мягкая утеплённая изнанка и размер S. Подходит для прохладной погоды и спокойных повседневных образов. Уход: машинная стирка при 30 °C, гладить с изнанки, не отбеливать.',
  'Белое худи Gravity с начёсом и машинной вышивкой. Обычная свободная посадка, мягкая утеплённая изнанка и размер S. Подходит для прохладной погоды и спокойных повседневных образов. Уход: машинная стирка при 30 °C, гладить с изнанки, не отбеливать.',
  source.category, source.category_slug, source.product_type,
  source.product_type_slug, source.decoration_type, source.decoration_slug,
  source.color_name, source.color_slug, source.color_hex,
  source.franchise_type, source.title_name, source.title_slug,
  source.anime_title, source.anime_slug, source.character_name,
  source.character_slug, source.collection_name, source.collection_slug,
  source.design_name, source.design_slug,
  source.tags || array['regular', 'fleece']::text[],
  array['S']::text[],
  source.price_min, source.price_max, source.currency,
  (source.selected_offers -> 0) ->> 'primary_image',
  (source.selected_offers -> 0) ->> 'primary_image',
  private.merch_storefront_image_urls_from_offers(source.selected_offers),
  array(
    select distinct (item.offer ->> 'product_id')::bigint
    from pg_catalog.jsonb_array_elements(source.selected_offers) as item(offer)
    order by (item.offer ->> 'product_id')::bigint
  ),
  array(
    select distinct (item.offer ->> 'sku')::bigint
    from pg_catalog.jsonb_array_elements(source.selected_offers) as item(offer)
    order by (item.offer ->> 'sku')::bigint
  ),
  array['D8-HDY-EMB-WHT-REG-FLC-S']::text[],
  source.selected_offers,
  source.ozon_attributes,
  source.source_payload || pg_catalog.jsonb_build_object(
    'catalog_variant_split',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'source_product_id', source.id,
      'created_at', pg_catalog.transaction_timestamp()
    )
  ),
  source.is_active, source.sort_order, pg_catalog.now(), pg_catalog.now(),
  'Обычная посадка, мягкий начёс и минималистичная вышивка Gravity.',
  array['С начёсом']::text[],
  0, 0, null, source.sales_6m_period_start, source.sales_6m_period_end,
  source.sales_6m_updated_at, source.compare_at_price, source.size_chart_json,
  'var8|embroidery|hoodie|white', 'regular', 'fleece'
from source;

with selected as (
  select product.id,
    coalesce(
      pg_catalog.jsonb_agg(item.offer order by item.ordinality)
        filter (where item.offer ->> 'offer_id' like 'D18-HDY-EMB-BLK-REG-NF-%'),
      '[]'::jsonb
    ) as offers
  from public.merch_storefront_products as product
  cross join lateral pg_catalog.jsonb_array_elements(product.offers)
    with ordinality as item(offer, ordinality)
  where product.id = '8d6fe381-f203-4861-8108-60d3251dae18'::uuid
  group by product.id
)
update public.merch_storefront_products as product
set
  design_key = 'var18|embroidery|hoodie|black|reg|nf',
  name = 'Худи GTA — обычное, без начёса',
  tags = product.tags || array['regular', 'no-fleece']::text[],
  sizes = array['S', 'M', 'L', 'XL', 'XXL']::text[],
  primary_image_url = (selected.offers -> 0) ->> 'primary_image',
  main_image_path = (selected.offers -> 0) ->> 'primary_image',
  image_urls = private.merch_storefront_image_urls_from_offers(selected.offers),
  ozon_product_ids = array(
    select distinct (item.offer ->> 'product_id')::bigint
    from pg_catalog.jsonb_array_elements(selected.offers) as item(offer)
    order by (item.offer ->> 'product_id')::bigint
  ),
  ozon_skus = array(
    select distinct (item.offer ->> 'sku')::bigint
    from pg_catalog.jsonb_array_elements(selected.offers) as item(offer)
    order by (item.offer ->> 'sku')::bigint
  ),
  ozon_offer_ids = array(
    select item.offer ->> 'offer_id'
    from pg_catalog.jsonb_array_elements(selected.offers)
      with ordinality as item(offer, ordinality)
    order by item.ordinality
  ),
  offers = selected.offers,
  source_payload = product.source_payload
    || pg_catalog.jsonb_build_object(
      'catalog_variant_split',
      pg_catalog.jsonb_build_object(
        'version', 1,
        'source_product_id', product.id,
        'created_at', pg_catalog.transaction_timestamp()
      )
    )
    || pg_catalog.jsonb_build_object(
      'checkout',
      coalesce(product.source_payload -> 'checkout', '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'legacy_ambiguous_sizes', pg_catalog.to_jsonb(array['S', 'M', 'L']::text[])
        )
    ),
  short_description = 'Обычная свободная посадка, плотный футер без начёса и аккуратная вышивка GTA.',
  badges = array['Обычное', 'Без начёса']::text[],
  variant_group_key = 'var18|embroidery|hoodie|black',
  hoodie_fit_slug = 'regular',
  hoodie_fleece_slug = 'no-fleece',
  updated_at = pg_catalog.now()
from selected
where product.id = selected.id;

with selected as (
  select product.id,
    coalesce(
      pg_catalog.jsonb_agg(item.offer order by item.ordinality)
        filter (where item.offer ->> 'offer_id' like 'D8-HDY-EMB-WHT-REG-NF-%'),
      '[]'::jsonb
    ) as offers
  from public.merch_storefront_products as product
  cross join lateral pg_catalog.jsonb_array_elements(product.offers)
    with ordinality as item(offer, ordinality)
  where product.id = '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid
  group by product.id
)
update public.merch_storefront_products as product
set
  design_key = 'var8|embroidery|hoodie|white|reg|nf',
  name = 'Худи Gravity белое — обычное, без начёса',
  description = 'Белое худи Gravity без начёса с машинной вышивкой. Обычная свободная посадка и гладкая изнанка делают модель удобной для повседневной носки в помещении и в межсезонье. Универсальный белый цвет легко сочетается с джинсами, спортивными брюками и карго. Уход: машинная стирка при 30 °C, гладить с изнанки, не отбеливать.',
  ozon_description = 'Белое худи Gravity без начёса с машинной вышивкой. Обычная свободная посадка и гладкая изнанка делают модель удобной для повседневной носки в помещении и в межсезонье. Универсальный белый цвет легко сочетается с джинсами, спортивными брюками и карго. Уход: машинная стирка при 30 °C, гладить с изнанки, не отбеливать.',
  tags = product.tags || array['regular', 'no-fleece']::text[],
  sizes = array['S', 'M', 'L', 'XL', 'XXL']::text[],
  primary_image_url = (selected.offers -> 0) ->> 'primary_image',
  main_image_path = (selected.offers -> 0) ->> 'primary_image',
  image_urls = private.merch_storefront_image_urls_from_offers(selected.offers),
  ozon_product_ids = array(
    select distinct (item.offer ->> 'product_id')::bigint
    from pg_catalog.jsonb_array_elements(selected.offers) as item(offer)
    order by (item.offer ->> 'product_id')::bigint
  ),
  ozon_skus = array(
    select distinct (item.offer ->> 'sku')::bigint
    from pg_catalog.jsonb_array_elements(selected.offers) as item(offer)
    order by (item.offer ->> 'sku')::bigint
  ),
  ozon_offer_ids = array(
    select item.offer ->> 'offer_id'
    from pg_catalog.jsonb_array_elements(selected.offers)
      with ordinality as item(offer, ordinality)
    order by item.ordinality
  ),
  offers = selected.offers,
  size_chart_json = (
    select gta.size_chart_json
    from public.merch_storefront_products as gta
    where gta.id = '8d6fe381-f203-4861-8108-60d3251dae18'::uuid
  ),
  source_payload = product.source_payload
    || pg_catalog.jsonb_build_object(
      'catalog_variant_split',
      pg_catalog.jsonb_build_object(
        'version', 1,
        'source_product_id', product.id,
        'created_at', pg_catalog.transaction_timestamp()
      )
    )
    || pg_catalog.jsonb_build_object(
      'checkout',
      coalesce(product.source_payload -> 'checkout', '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'legacy_ambiguous_sizes', pg_catalog.to_jsonb(array['S']::text[])
        )
    ),
  short_description = 'Обычная посадка, гладкая изнанка без начёса и минималистичная вышивка Gravity.',
  badges = array['Без начёса']::text[],
  variant_group_key = 'var8|embroidery|hoodie|white',
  hoodie_fit_slug = 'regular',
  hoodie_fleece_slug = 'no-fleece',
  updated_at = pg_catalog.now()
from selected
where product.id = selected.id;

update public.merch_storefront_products
set
  design_key = 'var2|embroidery|hoodie|black|reg|flc',
  variant_group_key = 'var2|embroidery|hoodie|black',
  hoodie_fit_slug = 'regular',
  hoodie_fleece_slug = 'fleece',
  updated_at = pg_catalog.now()
where id = 'c5f5244c-33b1-4c83-8179-f0d18f91b99b'::uuid
  and design_key = 'var2|embroidery|hoodie|black';

update public.merch_storefront_products
set
  design_key = 'var8|embroidery|hoodie|black|reg|flc',
  variant_group_key = 'var8|embroidery|hoodie|black',
  hoodie_fit_slug = 'regular',
  hoodie_fleece_slug = 'fleece',
  updated_at = pg_catalog.now()
where id = 'b468c761-c7f8-47ab-bc15-721c2da563c4'::uuid
  and design_key = 'var8|embroidery|hoodie|black';

update public.merch_storefront_products
set
  design_key = 'var2|embroidery|hoodie|blue|reg|nf',
  variant_group_key = 'var2|embroidery|hoodie|blue',
  hoodie_fit_slug = 'regular',
  hoodie_fleece_slug = 'no-fleece',
  updated_at = pg_catalog.now()
where id = 'f1c7a8de-1018-45e3-9be7-8e4bb16b1210'::uuid
  and design_key = 'var2|embroidery|hoodie|blue';

update public.merch_storefront_reviews
set storefront_product_id = '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
    updated_at = pg_catalog.now()
where storefront_product_id = '8d6fe381-f203-4861-8108-60d3251dae18'::uuid
  and source_offer_id = any(array[
    'D18-HDY-EMB-BLK-CRP-NF-S',
    'D18-HDY-EMB-BLK-CRP-NF-M',
    'D18-HDY-EMB-BLK-CRP-NF-L'
  ]::text[]);

alter table public.merch_storefront_products
  validate constraint merch_storefront_products_hoodie_variant_check;

alter table public.merch_storefront_products
  validate constraint merch_storefront_products_unique_selectable_offer_size_check;

create unique index if not exists merch_storefront_products_hoodie_variant_unique_idx
  on public.merch_storefront_products (
    variant_group_key,
    hoodie_fit_slug,
    hoodie_fleece_slug
  )
  where variant_group_key is not null;

do $$
begin
  if (
    select count(*)
    from public.merch_storefront_products
    where id in (
      '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
      '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
      '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid,
      'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
    )
      and is_active
      and private.merch_storefront_offers_have_unique_selectable_sizes(offers)
  ) <> 4 then
    raise exception 'hoodie split postflight failed: four active unambiguous rows expected';
  end if;

  if exists (
    select 1
    from public.merch_storefront_products
    where product_type_slug = 'hoodie'
      and is_active
      and (
        variant_group_key is null
        or hoodie_fit_slug is null
        or hoodie_fleece_slug is null
      )
  ) then
    raise exception 'hoodie split postflight failed: hoodie variant metadata missing';
  end if;

  if exists (
    select 1
    from public.merch_storefront_reviews
    where source_offer_id like 'D18-HDY-EMB-BLK-CRP-NF-%'
      and storefront_product_id is distinct from '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid
  ) then
    raise exception 'hoodie split postflight failed: cropped GTA review mapping';
  end if;
end
$$;

drop function private.merch_storefront_image_urls_from_offers(jsonb);

commit;
