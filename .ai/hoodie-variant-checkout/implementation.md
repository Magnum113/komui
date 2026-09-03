# Hoodie variant checkout — implementation record

Status at 2026-09-03: implementation, migration rehearsal, staging verification,
and controlled production rollout complete.

## Implemented contract

- The two mixed physical hoodie rows are split into four customer-visible
  cards: GTA regular/no-fleece, GTA cropped/no-fleece, Gravity
  regular/no-fleece, and Gravity regular/fleece.
- The existing regular/no-fleece UUIDs remain
  `8d6fe381-f203-4861-8108-60d3251dae18` and
  `4d4af0f7-6c22-48b1-bc76-3e5803d9bf9e`; the new cropped and fleece UUIDs are
  `33744741-8c0f-5b69-a7cb-766c16b88e0f` and
  `f3986f1d-c338-589a-bd90-e6745fced385`.
- Every active hoodie carries constrained `variant_group_key`, fit, and fleece
  metadata. A database check rejects duplicate selectable sizes within a card;
  a unique index rejects duplicate active physical variant tuples.
- A shared resolver accepts an exact `offerId + size` pair. Legacy carts without
  `offerId` work only when the size maps to exactly one selectable offer;
  ambiguous legacy rows fail closed and require a new selection.
- Cart identity, checkout snapshots, delivery quote, promo validation, payment
  identity, order items, analytics, and buyer session state preserve the exact
  offer ID. The order price comes from that offer.
- For groups with multiple active cards, the storefront shows fit and fleece
  facts and exposes sibling-card choices. It suppresses these internal metadata
  labels for singleton groups, uses native radio controls, and never silently
  preselects a size.
- Ozon offer grouping includes `CRP/REG` and `FLC/NF`, so future imports cannot
  collapse these physical variants back into one product row.

## Verification evidence

- Server test suite: 314/314 passed; TypeScript build passed.
- Operations regression suite: 113/113 passed; shell syntax checks passed.
- Legacy Edge compatibility path: 7/7 Deno tests and type checks for all three
  checkout-related functions passed. It is not the active self-hosted runtime.
- Frontend resolver, generated-page, fabric-fact, analytics, JavaScript syntax,
  and whitespace checks passed.
- A disposable clone of the full production database completed forward and
  rollback rehearsal. Forward changed total/active rows from 38/35 to 40/37;
  rollback restored 38/35 and exact source JSON/chart hashes. Negative duplicate
  size and duplicate variant-tuple inserts were rejected. The disposable
  database was deleted.
- Staging changed from 31/30 to 33/32 total/active rows. It has exactly four
  target hoodie cards, zero ambiguous selectable sizes, zero duplicate global
  offer IDs, and complete active hoodie metadata.
- A transaction-safe repository smoke under the real `komui_app` role resolved
  all four exact offers, preserved an unambiguous legacy size, rejected an
  ambiguous legacy size, and rejected a cross-card offer. It performed no
  order, payment, CDEK, or customer-notification write.
- A real browser smoke on staging selected GTA cropped size S, persisted the
  exact offer ID, displayed the same variant in cart and checkout, produced no
  console errors, and had no horizontal overflow at 390 px. The payment button
  was not clicked.
- The disposable database, temporary browser proxy/config files, and one
  incomplete inactive staging release from a network-stalled pre-activation
  build were removed. Active and rollback releases were retained.
- Before production mutation, backup v2 archive
  `komui-backup-20260903T135701Z.tar.gz.gpg` was uploaded, downloaded back and
  checksum-verified. A focused custom-format production dump was also validated
  with `pg_restore --list`.
- Production changed from 38/35 to 40/37 total/active catalog rows and passed
  the same exact-card, constraint, global offer-ID, metadata, and read-only
  `komui_app` repository checks as staging.
- The production static fallback was regenerated from the new backend, produced
  37 active product pages, and passed resolver, frontend/build, fabric-fact,
  analytics, JavaScript, external-image and whitespace gates before final
  activation.
- Public production browser verification repeated the exact GTA cropped S cart
  and checkout flow without clicking the payment button or creating customer
  data/provider effects.

## Rollout safeguards

- The forward migration and rollback are immutable, hash-reviewed, and contain
  exact-data assertions that abort unexpected live state.
- The deploy compatibility guard blocks a new source/legacy schema pair and a
  legacy source/new schema pair before activation.
- Production requires a fresh verified backup, closed API ingress, stopped
  backend workers, forward migration, first compatible backend activation,
  canonical static regeneration from the migrated production API, final
  activation, public browser smoke, and only then reopened ingress.
- No real payment or provider side effect is part of this rollout.
