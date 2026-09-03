# Hoodie variant checkout — inputs

## User request

Correctly plan, implement, and test the resolution of ambiguous hoodie variants.

## Confirmed problem

- The storefront currently lets a buyer select only `product + size`.
- Checkout sends only `id`, `size`, and `qty`.
- The backend selects the first offer matching the size.
- Four live combinations are ambiguous:
  - GTA hoodie sizes S, M, and L: cropped/no-fleece (`CRP-NF`) and regular/no-fleece (`REG-NF`).
  - White Gravity hoodie size S: regular/fleece (`REG-FLC`) and regular/no-fleece (`REG-NF`).
- A buyer can therefore receive a different physical SKU from the one they intended.

## Required outcome

- Each buyer-visible choice maps to exactly one concrete active storefront offer/SKU.
- The interface clearly distinguishes cut and warmth when those dimensions differ.
- Cart, checkout, order snapshot, admin/email/CDEK/receipt/analytics retain the selected concrete offer identity where relevant.
- Server-side validation is fail-closed:
  - zero matches: unavailable;
  - one exact match: accepted;
  - more than one match: rejected as `ambiguous_offer`.
- Existing valid carts/orders remain compatible.
- Current GTA and Gravity data are migrated without changing unrelated products or historical orders.
- Changes are tested locally, on staging, and on production without making a real payment.

## Constraints

- Preserve unrelated working-tree changes and secrets.
- Use immutable migrations and the existing deploy pipeline.
- Do not issue broad database privileges.
- Do not make a real production purchase/payment.
- Verify public behavior after deployment and clean up synthetic staging/browser data.

## Skill note

The installed `task-think` entrypoint references `PROMPTS.md`, but that file is absent from the skill package. The required artifact/phase contract is followed directly in this task directory instead.
