# Context

- Local implementation and independent review are complete: 228/228 server
  tests, focused suites, TypeScript build, ops tests, inline JavaScript parse,
  diff checks, and secret scan passed.
- The migration has not yet been applied to a real PostgreSQL instance.
- Active production was checked read-only and does not contain this release or
  schema. Production is explicitly outside this task.
- Staging uses `komui-backend` on port 3000, `/opt/komui/current` for the backend,
  and `/var/lib/komui/staging-root` for static frontend releases.
- The normal Git deploy script activates the backend immediately and does not
  apply schema migrations, so this migration needs an explicit closed-write
  rollout sequence around release activation.
- Staging is configured to create real CDEK shipments. Therefore smoke testing
  must avoid paid-order flows unless the owner separately authorizes a real
  provider mutation.
