# Context

- Local implementation and independent review are complete: 228/228 server
  tests, focused suites, TypeScript build, ops tests, inline JavaScript parse,
  diff checks, and secret scan passed.
- На старте rollout migration ещё не применялась к реальному PostgreSQL.
  В итоге она применена только к `komui_staging`; production schema осталась
  legacy.
- Active production runtime/DB were checked read-only and do not contain this
  release or schema. Production deployment/migration are outside this task;
  only the shared fail-closed deploy guard was later installed.
- Staging uses `komui-backend` on port 3000, `/opt/komui/current` for the backend,
  and `/var/lib/komui/staging-root` for static frontend releases.
- The normal Git deploy script activates the backend immediately and does not
  apply schema migrations, so this migration used an explicit closed-write
  rollout sequence around release activation. После rollout deploy script
  дополнен fail-closed source/schema compatibility gate; этот gate не заменяет
  controlled migration procedure.
- Staging is configured to create real CDEK shipments. Therefore smoke testing
  must avoid paid-order flows unless the owner separately authorizes a real
  provider mutation.
