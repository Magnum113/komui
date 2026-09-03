-- Retire the Darth Vader storefront product without deleting historical order references.
update public.merch_storefront_products
set
  is_active = false,
  updated_at = now()
where id = 'e82f9e2a-9eb7-4680-8916-7252ad8e0861'
   or slug = 'futbolka-star-wars-darth-vader-naruto-vyshivka-belaya';
