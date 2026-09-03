# Hoodie variant checkout — review

## Verdict

GO for the controlled production rollout; this is not yet a
production-complete verdict. No P0/P1 implementation blocker remains after
local, database-rehearsal, and staging verification.

## Correctness and safety review

- The selected physical SKU is no longer inferred by array order. Exact offer
  identity is carried end to end and revalidated against the owning card and
  normalized size at every checkout boundary.
- Backward compatibility is deliberately narrow: a legacy row is accepted only
  when it is uniquely resolvable. Historical ambiguous sizes never default to a
  variant.
- The database, importer, API, browser state, payment fingerprint, order
  snapshots, and generated storefront enforce the same variant model.
- The schema change is transactional, fails closed on data drift or existing
  target-order history, and has a rehearsed exact rollback.
- Native radios, visible fit/fleece labels, and no implicit size selection make
  the choice explicit for keyboard, screen-reader, and pointer users.

## Remaining non-blocking work

- Static generation runs before backend activation, so the schema change needs
  the documented two-deploy sequence while API ingress remains closed.
- Cross-card active offer ID uniqueness is enforced by importer, deploy, and
  healthcheck validation rather than a global relational unique constraint.
- The rollback is safe before new orders reference the split cards; after that,
  order reconciliation is required instead of blindly merging the rows.
- The dependency audit still reports one moderate Fastify advisory. It is not
  an exploit path introduced by this change and should be handled as a separate
  dependency-maintenance item.
- A real T-Bank payment is intentionally outside verification scope; the rollout
  validates the payload and repository boundary without charging or notifying a
  customer.
- The inactive Supabase Edge compatibility functions were hardened and tested,
  but are not deployed because the production checkout runs through Fastify.
