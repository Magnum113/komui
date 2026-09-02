# Plan

1. Refresh remote refs and create `codex/repository-sync` from the exact current
   `origin/main` commit.
2. Review all untracked Xray files for credentials, machine-specific secrets,
   unsafe examples, and unnecessary diagnostic artifacts.
3. Import the two PostgreSQL 17.11 documentation commits without rewriting the
   already-pushed feature branch.
4. Add the reviewed Xray source, units, tests, and durable documentation.
5. Update canonical current-state documentation for payment/CDEK hardening,
   PostgreSQL 17.11, backup/DR, order monitoring, Single Opt-In, and Xray.
6. Run focused and full local validation, inspect the complete diff, and obtain
   an independent review.
7. Commit and push the feature branch; compare it with GitHub by immutable SHA.
8. Integrate it into `main` without rewriting history, push `main`, and observe
   the standard staging/production rollout.
9. Verify active releases, backend/frontend provenance, PostgreSQL schema,
   services, timers, public/API health, and the latest backup.
10. Fast-forward local `main`, confirm all intended refs, and record the final
    evidence and any explicitly deferred operational items.

## Acceptance criteria

- No tracked or untracked intended implementation remains outside Git.
- No secrets or credential values are introduced into Git history.
- PostgreSQL upgrade evidence and Xray implementation are reachable from
  `origin/main`.
- Canonical documentation describes the actual current production state.
- GitHub `main`, the server deployment source, and both active releases point to
  the accepted commit, except for documented deterministic build output.
- Local and server tests and health checks pass, with no failed Komui units.
