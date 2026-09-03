# Hoodie variant checkout — implementation plan

## 1. Data and invariant

1. Add an immutable migration which:
   - splits GTA cropped S/M/L into a new row;
   - keeps GTA regular S–XXL on the existing UUID and URL;
   - splits white Gravity fleece S into a new row;
   - keeps white Gravity no-fleece S–XXL on the existing UUID and URL;
   - partitions offer IDs, Ozon SKU/product IDs, sizes and offer-specific images;
   - moves only the GTA cropped review identified by its source offer;
   - leaves historical orders untouched;
   - records variant group, fit and warmth in explicit constrained columns;
   - records only legacy ambiguous sizes in `source_payload`;
   - installs and validates a check constraint for unique selectable offer size.
2. Make the migration transactional and include explicit assertions so
   unexpected live data aborts rather than being partially rewritten.
3. Provide a narrow rollback script for the catalog split and constraint. Do
   not run rollback unless validation fails.

## 2. Ozon import

1. Parse `CRP`/`REG` and `FLC`/`NF` from structured hoodie offer IDs.
2. Prefer a variant-aware design key, then use the legacy base key only for
   unsplit historical products.
3. Group newly discovered offers by the variant-aware key.
4. Add tests proving that cropped/regular and fleece/no-fleece offers never
   collapse into one inferred product group.

## 3. Catalog and storefront

1. Expose sanitized variant metadata, sibling identity, and required-reselection
   sizes from the catalog API.
2. Add one shared browser/Node offer resolver which filters out archived and
   explicitly hidden offers and returns exactly one of: selected, unavailable,
   ambiguous, or reselection-required.
3. On catalog modals and product pages:
   - show the current fit and warmth in human language;
   - show links to sibling cards only for the dimension that differs;
   - keep size as the within-card choice;
   - stop quick-add from silently choosing M.
4. Store `offerId` in cart and checkout snapshots, include it in cart keys and
   display human-readable variant details.
5. Keep storefront product UUID as the ecommerce/feed product ID; add offer ID
   only as supplemental analytics metadata.

## 4. Checkout fail-closed validation

1. Accept optional `offerId` for backward compatibility.
2. With `offerId`, require one exact selectable offer whose size matches.
3. Without `offerId`:
   - reject migrated historically ambiguous sizes with `ambiguous_offer`;
   - otherwise allow exactly one selectable size match;
   - reject zero as `offer_unavailable` and multiple as `ambiguous_offer`.
4. Price the order from the selected offer (with the existing product price only
   as a compatibility fallback), and keep `offer_id`/`sku` in every existing
   downstream snapshot.
5. Carry `offerId` through delivery quote, promo validation, payment identity,
   payment creation, and buyer analytics/session state.

## 5. Verification and rollout

1. Static/unit tests:
   - checkout validation/resolution and legacy compatibility;
   - Ozon inference/grouping;
   - catalog sanitization;
   - browser cart/checkout payload contract;
   - generated pages, feed, sitemap, links and committed generated artifacts.
2. Rehearse migration against a disposable database copy or rolled-back
   transaction; verify row counts, exact offer partition, constraints and review
   ownership.
3. Apply to staging, build/deploy the candidate, then verify:
   - the environment-specific catalog count (32 active cards on the current
     staging dataset; 37 after the same split on production) and zero duplicate
     selectable sizes;
   - all four sibling pages and selectors;
   - cart/quote/promo/checkout request payloads include the exact offer ID;
   - transaction-safe checkout repository smoke with the real app role;
   - no real payment and no production/customer alerts.
4. After staging gates pass, take a fresh backup, apply the same migration to
   production, deploy the exact reviewed commit, rebuild the canonical static
   fallback from the migrated production catalog, deploy that generated
   artifact commit, and repeat public/read-only and transaction-safe postflight
   checks. Keep checkout/API ingress closed between the schema change and the
   final compatible release.
5. Confirm Git branch/remote/main and active stage/prod release hashes are
   synchronized; retain rollback evidence and remove synthetic test state.
