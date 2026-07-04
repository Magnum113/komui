-- SEO product slugs migration.
--
-- Purpose:
-- - replace legacy product URL slugs like var16-print-tshirt-washed-grey;
-- - keep old slugs as redirect aliases;
-- - allow backend/static build to generate canonical product pages and 301s.

begin;

create table if not exists public.merch_storefront_product_slug_redirects (
  old_slug text primary key
    check (old_slug ~ '^[a-z0-9][a-z0-9-]*$'),
  product_id uuid not null
    references public.merch_storefront_products(id)
    on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists merch_storefront_product_slug_redirects_product_idx
  on public.merch_storefront_product_slug_redirects(product_id);

with mapping(old_slug, new_slug) as (
  values
    ('var16-print-tshirt-washed-grey', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-print-seraya'),
    ('var20-print-tshirt-washed-grey', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-chb2-print-seraya'),
    ('var4-embroidery-tshirt-white', 'futbolka-naruto-akatsuki-vyshivka-belaya'),
    ('var2-embroidery-tshirt-black', 'futbolka-naruto-itachi-uchiha-vyshivka-chernaya'),
    ('var2-embroidery-hoodie-black', 'hudi-naruto-itachi-uchiha-vyshivka-chernaya'),
    ('var15-print-tshirt-white', 'futbolka-naruto-naruto-uzumaki-print-belaya'),
    ('var16-print-tshirt-washed-beige', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-print-bezhevaya'),
    ('var18-embroidery-hoodie-black', 'hudi-grand-theft-auto-gta-bez-nachesa-vyshivka-chernaya'),
    ('var8-embroidery-hoodie-white', 'hudi-gravity-vyshivka-belaya'),
    ('var2-embroidery-tshirt-washed-beige', 'futbolka-varenka-naruto-itachi-uchiha-vyshivka-bezhevaya'),
    ('var19-print-tshirt-white', 'futbolka-jujutsu-kaisen-satoru-gojo-print-belaya'),
    ('var17-print-tshirt-black', 'futbolka-jujutsu-kaisen-satoru-gojo-print-chernaya'),
    ('var16-print-tshirt-white', 'futbolka-jujutsu-kaisen-satoru-gojo-print-belaya-2'),
    ('var3-embroidery-tshirt-black', 'futbolka-naruto-akatsuki-swoosh-vyshivka-chernaya'),
    ('var14-embroidery-tshirt-white', 'futbolka-naruto-madara-uchiha-vyshivka-belaya'),
    ('var5-print-tshirt-white', 'futbolka-naruto-akatsuki-print-belaya'),
    ('var5-print-tshirt-black', 'futbolka-naruto-akatsuki-print-chernaya'),
    ('var1-print-tshirt-black', 'futbolka-naruto-akatsuki-print-chernaya-2'),
    ('var8-embroidery-tshirt-white', 'futbolka-gravity-vyshivka-belaya'),
    ('var8-print-tshirt-white', 'futbolka-gravity-print-belaya'),
    ('var8-print-tshirt-black', 'futbolka-gravity-print-chernaya'),
    ('var18-embroidery-tshirt-black', 'futbolka-grand-theft-auto-gta-vyshivka-chernaya'),
    ('var8-embroidery-hoodie-black', 'hudi-gravity-vyshivka-chernaya'),
    ('var8-print-tshirt-washed-grey', 'futbolka-varenka-gravity-print-seraya'),
    ('var12-embroidery-tshirt-white', 'futbolka-star-wars-darth-vader-naruto-vyshivka-belaya'),
    ('var13-embroidery-tshirt-white', 'futbolka-naruto-itachi-uchiha-vyshivka-belaya'),
    ('var17-print-tshirt-blue', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-print-sinyaya'),
    ('var4-embroidery-tshirt-other', 'futbolka-naruto-akatsuki-vyshivka-belaya-2'),
    ('var7-print-tshirt-other', 'futbolka-naruto-akatsuki-s-tekstom-print-belaya'),
    ('var2-embroidery-hoodie-blue', 'hudi-naruto-itachi-uchiha-vyshivka-sinyaya'),
    ('var2-embroidery-sweatshirt-black', 'svitshot-naruto-itachi-uchiha-vyshivka-chernaya')
),
target_products as (
  select
    m.old_slug,
    m.new_slug,
    p.id as product_id
  from mapping m
  join public.merch_storefront_products p
    on p.slug = m.old_slug
    or p.slug = m.new_slug
)
insert into public.merch_storefront_product_slug_redirects(old_slug, product_id)
select old_slug, product_id
from target_products
where old_slug <> new_slug
on conflict (old_slug) do update
set product_id = excluded.product_id;

with mapping(old_slug, new_slug) as (
  values
    ('var16-print-tshirt-washed-grey', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-print-seraya'),
    ('var20-print-tshirt-washed-grey', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-chb2-print-seraya'),
    ('var4-embroidery-tshirt-white', 'futbolka-naruto-akatsuki-vyshivka-belaya'),
    ('var2-embroidery-tshirt-black', 'futbolka-naruto-itachi-uchiha-vyshivka-chernaya'),
    ('var2-embroidery-hoodie-black', 'hudi-naruto-itachi-uchiha-vyshivka-chernaya'),
    ('var15-print-tshirt-white', 'futbolka-naruto-naruto-uzumaki-print-belaya'),
    ('var16-print-tshirt-washed-beige', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-print-bezhevaya'),
    ('var18-embroidery-hoodie-black', 'hudi-grand-theft-auto-gta-bez-nachesa-vyshivka-chernaya'),
    ('var8-embroidery-hoodie-white', 'hudi-gravity-vyshivka-belaya'),
    ('var2-embroidery-tshirt-washed-beige', 'futbolka-varenka-naruto-itachi-uchiha-vyshivka-bezhevaya'),
    ('var19-print-tshirt-white', 'futbolka-jujutsu-kaisen-satoru-gojo-print-belaya'),
    ('var17-print-tshirt-black', 'futbolka-jujutsu-kaisen-satoru-gojo-print-chernaya'),
    ('var16-print-tshirt-white', 'futbolka-jujutsu-kaisen-satoru-gojo-print-belaya-2'),
    ('var3-embroidery-tshirt-black', 'futbolka-naruto-akatsuki-swoosh-vyshivka-chernaya'),
    ('var14-embroidery-tshirt-white', 'futbolka-naruto-madara-uchiha-vyshivka-belaya'),
    ('var5-print-tshirt-white', 'futbolka-naruto-akatsuki-print-belaya'),
    ('var5-print-tshirt-black', 'futbolka-naruto-akatsuki-print-chernaya'),
    ('var1-print-tshirt-black', 'futbolka-naruto-akatsuki-print-chernaya-2'),
    ('var8-embroidery-tshirt-white', 'futbolka-gravity-vyshivka-belaya'),
    ('var8-print-tshirt-white', 'futbolka-gravity-print-belaya'),
    ('var8-print-tshirt-black', 'futbolka-gravity-print-chernaya'),
    ('var18-embroidery-tshirt-black', 'futbolka-grand-theft-auto-gta-vyshivka-chernaya'),
    ('var8-embroidery-hoodie-black', 'hudi-gravity-vyshivka-chernaya'),
    ('var8-print-tshirt-washed-grey', 'futbolka-varenka-gravity-print-seraya'),
    ('var12-embroidery-tshirt-white', 'futbolka-star-wars-darth-vader-naruto-vyshivka-belaya'),
    ('var13-embroidery-tshirt-white', 'futbolka-naruto-itachi-uchiha-vyshivka-belaya'),
    ('var17-print-tshirt-blue', 'futbolka-varenka-jujutsu-kaisen-satoru-gojo-print-sinyaya'),
    ('var4-embroidery-tshirt-other', 'futbolka-naruto-akatsuki-vyshivka-belaya-2'),
    ('var7-print-tshirt-other', 'futbolka-naruto-akatsuki-s-tekstom-print-belaya'),
    ('var2-embroidery-hoodie-blue', 'hudi-naruto-itachi-uchiha-vyshivka-sinyaya'),
    ('var2-embroidery-sweatshirt-black', 'svitshot-naruto-itachi-uchiha-vyshivka-chernaya')
)
update public.merch_storefront_products p
set slug = m.new_slug,
    updated_at = now()
from mapping m
where p.slug = m.old_slug
  and p.slug <> m.new_slug;

commit;
