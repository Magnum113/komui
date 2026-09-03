# Hoodie variant checkout — context

## Verified pre-migration production baseline

- Baseline Git/deploy commit: `bc3d5acd2a52a501ce9b28e4d320fbf026b75968`.
- Production exposes 35 active products.
- `8d6fe381-f203-4861-8108-60d3251dae18` (`Худи без начёса GTA`) contains:
  - cropped/no-fleece S, M, L;
  - regular/no-fleece S, M, L, XL, XXL.
- `4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e` (`Худи Gravity`, white) contains:
  - regular/fleece S;
  - regular/no-fleece S, M, L, XL, XXL.
- Both rows are active, all listed offers are non-archived, and `visible = null`
  is the existing representation of a selectable offer.
- There are no historical order items for either source product.
- The GTA product has one published review sourced from
  `D18-HDY-EMB-BLK-CRP-NF-L`; it belongs with the new cropped card.
- The white Gravity product has one published review sourced from
  `D8-HDY-EMB-WHT-REG-NF-L`; it remains on the no-fleece card.

## Root causes

1. Cart identity is only `product id + size`; `offerId` is not stored or sent.
2. The server uses the first offer whose size matches and does not reject zero or
   multiple selectable offers.
3. Ozon import derives `design_key` from design, decoration, product type, and
   colour only. It ignores the `CRP`/`REG` and `FLC`/`NF` SKU segments, so a
   later new size can be merged back into the wrong card.
4. The storefront does not expose fit/warmth as explicit product attributes or
   connect sibling cards as variant choices.
5. A legacy cart created before the split cannot reveal which of the previously
   ambiguous physical variants the buyer meant.

## Existing compatibility surface

- Order items and product snapshots already persist `offer_id` and `sku`.
- Admin order views and CDEK shipment construction already read those fields.
- Therefore downstream order/admin/CDEK work needs verification, not a storage
  redesign.
- Yandex ecommerce/feed identity intentionally remains the storefront product
  UUID; SKU identity is added as supplemental metadata and must not replace it.
- The generic deploy does not apply database migrations. The migration must be
  applied explicitly to staging and production before the matching release is
  activated.

## Chosen model

- Keep the current canonical URLs on the broad regular/no-fleece products.
- Add canonical sibling cards for GTA cropped/no-fleece and white Gravity
  regular/fleece.
- Encode physical dimensions in variant-aware design keys so Ozon import cannot
  merge the rows again.
- Store canonical variant metadata in explicit nullable columns
  (`variant_group_key`, `hoodie_fit_slug`, `hoodie_fleece_slug`). Keep only the
  transitional legacy-cart ambiguity marker in `source_payload`, and expose a
  sanitized projection through the catalog API.
- Preserve legacy carts only where their old `product + size` identity was
  genuinely unambiguous. Previously ambiguous sizes must be reselected.
- Add a database constraint which rejects duplicate selectable sizes inside a
  product row, while allowing archived or explicitly hidden historical offers.

## Verified staging state — 2026-09-03

- The migration and candidate revision are deployed; total/active catalog rows
  changed from 31/30 to 33/32.
- The four target cards are distinct and there are zero duplicate selectable
  sizes, duplicate global active offer IDs, or active hoodies with incomplete
  variant metadata.
- A read-only transaction under the real `komui_app` role accepted all four
  exact offer selections and legacy GTA XL, rejected legacy GTA S as
  `ambiguous_offer`, and rejected a cross-card offer as `offer_unavailable`.
- A real browser verified no preselected size, exact offer ID persistence in
  cart and checkout, visible variant text, zero console errors, and no mobile
  horizontal overflow.
- Verification created no order, payment, provider call, or customer alert.
