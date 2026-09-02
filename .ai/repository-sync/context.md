# Context

## Audit baseline (2026-09-02)

- GitHub `main`, `codex/email-single-opt-in`, the server deploy source, and the
  active staging/production application releases point to commit `10da49f`.
- The local `main` is 17 commits behind `origin/main`, with no local-only work.
- `codex/payment-consistency-hardening` contains two unique documentation
  commits, `e10f2ae` and `fef444d`, recording the accepted PostgreSQL 17.11
  production maintenance.
- Sixteen Xray source/test/documentation files are untracked locally. The
  installed updater and systemd unit hashes match their local counterparts,
  but none of those files exists in GitHub.
- Production payment, email, backup, and order-monitor runtime is healthy. The
  active database server is PostgreSQL 17.11.
- The disposable deployment checkout is intentionally changed by the static
  storefront build. Active generated frontend artifacts match that checkout,
  and the deployment script resets and cleans it before every deployment.

## Non-goals

- Resolve historical CDEK effects requiring operator review.
- Repair unused legacy Supabase-compatible endpoints on `api.komui.ru`.
- Create or move an off-server copy of the backup encryption key.
- Rewrite dated task evidence to pretend that later production work had already
  happened at the time of the original report.
