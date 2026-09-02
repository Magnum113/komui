# Inputs

## Goal

Bring the repository, GitHub branches, canonical operational documentation,
and the deployed Komui server back to one verifiable source of truth.

## Requested scope

- Commit the production Xray subscription updater, its systemd units, tests,
  and durable task documentation after a secret review.
- Bring the PostgreSQL 17.11 production-upgrade documentation from
  `codex/payment-consistency-hardening` into `main`.
- Update canonical documentation that still describes payment hardening,
  PostgreSQL, order monitoring, Single Opt-In, or Xray as pending or legacy.
- Merge the reviewed result into `main`, push it, observe the normal deployment
  path, and verify Git, staging, production, databases, services, and backups.
- Fast-forward the local `main` only after the remote and production result is
  accepted.

## Safety constraints

- Never commit or print subscription URLs, provider credentials, Telegram
  tokens, database passwords, backup encryption keys, or private SSH keys.
- Preserve historical task reports as historical evidence; update canonical
  current-state documentation instead of rewriting old observations.
- Do not include ignored runtime credentials or host-specific files.
- Treat the existing untracked Xray files as user work until reviewed.
- Do not claim deployment success from a Git push or timer state alone; verify
  the active release, service processes, schema, public behavior, and logs.
