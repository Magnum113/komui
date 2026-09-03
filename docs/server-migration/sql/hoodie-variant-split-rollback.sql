-- Emergency rollback for 20260903125110_split_hoodie_storefront_variants.sql.
-- Use only before accepting orders on the split cards. The script deliberately
-- aborts once a new order/review/import has made a merge unsafe.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  perform 1
  from public.merch_storefront_products
  where id in (
    '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
    '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
    '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid,
    'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
  )
  for update;

  if (select count(*) from public.merch_storefront_products where id in (
    '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
    '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
    '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid,
    'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
  )) <> 4 then
    raise exception 'hoodie variant rollback aborted: expected four split rows';
  end if;

  if exists (
    select 1
    from public.merch_customer_order_items
    where product_id in (
      '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
      '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
      '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid,
      'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
    )
  ) then
    raise exception 'hoodie variant rollback aborted: variant rows have order history';
  end if;

  if exists (
    select 1
    from public.merch_storefront_reviews
    where storefront_product_id in (
      '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
      'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
    )
      and not (
        source_offer_id = 'D18-HDY-EMB-BLK-CRP-NF-L'
        and storefront_product_id = '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid
      )
  ) then
    raise exception 'hoodie variant rollback aborted: split cards have new reviews';
  end if;

  if exists (
    with expected(product_id, offer_ids) as (
      values
        (
          '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
          array[
            'D18-HDY-EMB-BLK-CRP-NF-L',
            'D18-HDY-EMB-BLK-CRP-NF-M',
            'D18-HDY-EMB-BLK-CRP-NF-S'
          ]::text[]
        ),
        (
          '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
          array[
            'D18-HDY-EMB-BLK-REG-NF-2XL',
            'D18-HDY-EMB-BLK-REG-NF-L',
            'D18-HDY-EMB-BLK-REG-NF-M',
            'D18-HDY-EMB-BLK-REG-NF-S',
            'D18-HDY-EMB-BLK-REG-NF-XL'
          ]::text[]
        ),
        (
          'f3986f1d-c338-589a-bd90-e6745fced385'::uuid,
          array['D8-HDY-EMB-WHT-REG-FLC-S']::text[]
        ),
        (
          '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid,
          array[
            'D8-HDY-EMB-WHT-REG-NF-2XL',
            'D8-HDY-EMB-WHT-REG-NF-L',
            'D8-HDY-EMB-WHT-REG-NF-M',
            'D8-HDY-EMB-WHT-REG-NF-S',
            'D8-HDY-EMB-WHT-REG-NF-XL'
          ]::text[]
        )
    ), actual as (
      select
        product.id as product_id,
        array_agg(item.offer ->> 'offer_id' order by item.offer ->> 'offer_id') as offer_ids
      from public.merch_storefront_products as product
      cross join lateral jsonb_array_elements(product.offers) as item(offer)
      where product.id in (select product_id from expected)
      group by product.id
    )
    select 1
    from expected
    left join actual using (product_id)
    where actual.offer_ids is distinct from expected.offer_ids
  ) then
    raise exception 'hoodie variant rollback aborted: offers changed after split';
  end if;

  if exists (
    select 1
    from public.merch_storefront_products
    where id in (
      '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
      '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
      '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid,
      'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
    )
      and (
        source_payload #>> '{catalog_variant_split,version}' is distinct from '1'
        or source_payload #>> '{catalog_variant_split,created_at}' is null
        or updated_at is distinct from (
          source_payload #>> '{catalog_variant_split,created_at}'
        )::timestamptz
      )
  ) then
    raise exception 'hoodie variant rollback aborted: variant rows changed after split';
  end if;
end
$$;

alter table public.merch_storefront_products
  drop constraint if exists merch_storefront_products_unique_selectable_offer_size_check;

alter table public.merch_storefront_products
  drop constraint if exists merch_storefront_products_hoodie_variant_check;

drop index if exists public.merch_storefront_products_hoodie_variant_unique_idx;

with variants as (
  select
    retained.id,
    cropped.offers as moved_offers
  from public.merch_storefront_products as retained
  join public.merch_storefront_products as cropped
    on cropped.id = '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid
  where retained.id = '8d6fe381-f203-4861-8108-60d3251dae18'::uuid
)
update public.merch_storefront_products as product
set
  design_key = 'var18|embroidery|hoodie|black',
  name = 'Худи без начёса GTA',
  tags = array['black', 'embroidery', 'game', 'gta', 'hoodie', 'streetwear']::text[],
  sizes = array['S', 'M', 'L', 'XL', 'XXL']::text[],
  primary_image_url = 'https://ir.ozone.ru/s3/multimedia-1-9/8224713081.jpg',
  main_image_path = './assets/ozon-main/02-худи-без-начеса-с-вышивкой-gta.jpg',
  image_urls = array[
    'https://ir.ozone.ru/s3/multimedia-1-9/8224713081.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-p/8222756065.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-d/8222756197.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-v/8222756431.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-k/8222523500.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-r/12069343575.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-r/8222756355.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-f/8426384907.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-w/8426384960.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-i/8426384802.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-s/8426384884.jpg'
  ]::text[],
  ozon_product_ids = array[3097415669, 3097415764, 3097415901, 3143640806,
    3153042231, 3153042232, 3153042236, 3153042237]::bigint[],
  ozon_skus = array[3134088448, 3134088915, 3134088781, 3169574953,
    3176809977, 3176810055, 3176810110, 3176809782]::bigint[],
  ozon_offer_ids = array[
    'D18-HDY-EMB-BLK-CRP-NF-M', 'D18-HDY-EMB-BLK-CRP-NF-S',
    'D18-HDY-EMB-BLK-CRP-NF-L', 'D18-HDY-EMB-BLK-REG-NF-S',
    'D18-HDY-EMB-BLK-REG-NF-XL', 'D18-HDY-EMB-BLK-REG-NF-2XL',
    'D18-HDY-EMB-BLK-REG-NF-M', 'D18-HDY-EMB-BLK-REG-NF-L'
  ]::text[],
  offers = variants.moved_offers || product.offers,
  source_payload = (product.source_payload - 'checkout' - 'catalog_variant_split') ||
    case
      when (coalesce(product.source_payload -> 'checkout', '{}'::jsonb)
        - 'legacy_ambiguous_sizes') = '{}'::jsonb
        then '{}'::jsonb
      else jsonb_build_object(
        'checkout',
        (product.source_payload -> 'checkout') - 'legacy_ambiguous_sizes'
      )
    end,
  short_description = 'Худи без начёса: не парит летом и держит форму к осени. Аккуратная вышивка в духе GTA вместо громких принтов — тот случай, когда решает деталь.',
  badges = '{}'::text[],
  variant_group_key = null,
  hoodie_fit_slug = null,
  hoodie_fleece_slug = null,
  updated_at = now()
from variants
where product.id = variants.id;

with variants as (
  select
    retained.id,
    fleece.offers as moved_offers,
    fleece.size_chart_json as moved_size_chart_json
  from public.merch_storefront_products as retained
  join public.merch_storefront_products as fleece
    on fleece.id = 'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
  where retained.id = '4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e'::uuid
)
update public.merch_storefront_products as product
set
  design_key = 'var8|embroidery|hoodie|white',
  name = 'Худи Gravity',
  description = E'Белое худи с вышивкой Gravity Defied — стильная и универсальная толстовка для повседневной носки. Модель выполнена из футера 3-х нитки плотностью 240 г/м² (хлопок 85%, полиэстер 10%, эластан 5%). Материал мягкий, приятный к телу, хорошо пропускает воздух и сохраняет форму после стирок.\nКлассический крой делает худи удобным и практичным. Универсальный белый цвет легко сочетается с джинсами, спортивными брюками или карго. Вышивка по мотивам культовой игры Gravity Defied добавляет оригинальности и станет акцентом в любом образе.\nТолстовка подходит как мужчинам, так и женщинам. Идеальна для прогулок, учёбы, работы и отдыха.\nПреимущества модели:\nХуди белого цвета с классическим кроем; Футер 3-х нитка (240 г/м²) — плотный, долговечный материал; Состав: хлопок 85%, полиэстер 10%, эластан 5%; Удобный капюшон и вместительный карман-кенгуру; Вышивка по мотивам легендарной игры Gravity Defied. Такое худи станет отличным выбором для любителей ретро-игр, коллекционеров и тех, кто ценит качественные и стильные вещи.',
  ozon_description = E'Белое худи с вышивкой Gravity Defied — стильная и универсальная толстовка для повседневной носки. Модель выполнена из футера 3-х нитки плотностью 240 г/м² (хлопок 85%, полиэстер 10%, эластан 5%). Материал мягкий, приятный к телу, хорошо пропускает воздух и сохраняет форму после стирок.\nКлассический крой делает худи удобным и практичным. Универсальный белый цвет легко сочетается с джинсами, спортивными брюками или карго. Вышивка по мотивам культовой игры Gravity Defied добавляет оригинальности и станет акцентом в любом образе.\nТолстовка подходит как мужчинам, так и женщинам. Идеальна для прогулок, учёбы, работы и отдыха.\nПреимущества модели:\nХуди белого цвета с классическим кроем; Футер 3-х нитка (240 г/м²) — плотный, долговечный материал; Состав: хлопок 85%, полиэстер 10%, эластан 5%; Удобный капюшон и вместительный карман-кенгуру; Вышивка по мотивам легендарной игры Gravity Defied. Такое худи станет отличным выбором для любителей ретро-игр, коллекционеров и тех, кто ценит качественные и стильные вещи.',
  tags = array['embroidery', 'gravity', 'hoodie', 'line-art', 'original', 'white']::text[],
  sizes = array['S', 'M', 'L', 'XL', 'XXL']::text[],
  primary_image_url = 'https://ir.ozone.ru/s3/multimedia-1-x/7983638457.jpg',
  main_image_path = './assets/ozon-main/03-худи-с-вышивкой-gravity.jpg',
  image_urls = array[
    'https://ir.ozone.ru/s3/multimedia-1-x/7983638457.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-n/7983638483.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-z/7983638675.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-b/7983638291.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-x/7983638709.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-r/12069343575.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-g/8426112064.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-r/8426112003.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-w/8426112260.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-e/8426112350.jpg'
  ]::text[],
  ozon_product_ids = array[3097415908, 3143545153, 3153042230, 3153042233,
    3153042234, 3153042235]::bigint[],
  ozon_skus = array[3134088911, 3169503419, 3176809802, 3176809894,
    3176809914, 3176809807]::bigint[],
  ozon_offer_ids = array[
    'D8-HDY-EMB-WHT-REG-FLC-S', 'D8-HDY-EMB-WHT-REG-NF-S',
    'D8-HDY-EMB-WHT-REG-NF-2XL', 'D8-HDY-EMB-WHT-REG-NF-L',
    'D8-HDY-EMB-WHT-REG-NF-XL', 'D8-HDY-EMB-WHT-REG-NF-M'
  ]::text[],
  offers = variants.moved_offers || product.offers,
  size_chart_json = variants.moved_size_chart_json,
  source_payload = (product.source_payload - 'checkout' - 'catalog_variant_split') ||
    case
      when (coalesce(product.source_payload -> 'checkout', '{}'::jsonb)
        - 'legacy_ambiguous_sizes') = '{}'::jsonb
        then '{}'::jsonb
      else jsonb_build_object(
        'checkout',
        (product.source_payload -> 'checkout') - 'legacy_ambiguous_sizes'
      )
    end,
  short_description = 'Белое худи из авторской линейки Gravity: чистый силуэт и вышитый логотип, который проявляется только вблизи. Минимализм, который дружит с чем угодно.',
  badges = '{}'::text[],
  variant_group_key = null,
  hoodie_fit_slug = null,
  hoodie_fleece_slug = null,
  updated_at = now()
from variants
where product.id = variants.id;

update public.merch_storefront_reviews
set storefront_product_id = '8d6fe381-f203-4861-8108-60d3251dae18'::uuid,
    updated_at = now()
where storefront_product_id = '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid
  and source_offer_id = 'D18-HDY-EMB-BLK-CRP-NF-L';

delete from public.merch_storefront_products
where id in (
  '33744741-8c0f-5b69-a7cb-766c16b88e0f'::uuid,
  'f3986f1d-c338-589a-bd90-e6745fced385'::uuid
);

update public.merch_storefront_products
set
  design_key = regexp_replace(design_key, '\|(reg|crp)\|(flc|nf)$', ''),
  variant_group_key = null,
  hoodie_fit_slug = null,
  hoodie_fleece_slug = null,
  updated_at = now()
where product_type_slug = 'hoodie';

alter table public.merch_storefront_products
  drop column if exists variant_group_key,
  drop column if exists hoodie_fit_slug,
  drop column if exists hoodie_fleece_slug;

drop function if exists private.merch_storefront_offers_have_unique_selectable_sizes(jsonb);

commit;
