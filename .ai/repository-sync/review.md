# Review

## Pre-commit findings addressed

- The original production Xray files contained no subscription URL, HWID,
  endpoint credential, Telegram token, private key, or password assignment.
- Publication-only metadata was sanitized from the unpublished task evidence.
- Two symmetric P2 failover-capacity edges were fixed before the first Git
  commit. Regression tests cover alternate-provider fetch failure, partial
  secondary capacity use, both primary-to-secondary and secondary-to-primary
  healthy-to-unhealthy transitions, deferred capacity reclamation, and the
  unchanged preferred-profile order and 32-profile ceiling.
- Pre-commit review also found staging Basic Auth in several curl argument
  lists and a deploy-status remote lookup that aborted instead of degrading to
  a bounded cached result. The live server additionally rejected Git protocol
  v2 while v1 returned the expected public `main`; these classes were fixed
  and regression-tested before rollout.
- The disposable server deploy checkout is expected to contain generated
  storefront changes after `build-products.js`; the deployment script performs
  a hard reset and clean before each new checkout. This output is not source
  work and must not be copied back into Git.
- Pushes do not automatically deploy this repository. Staging and production
  require explicit, sequential `komui-deploy-from-git` runs with acceptance
  between them.

## Acceptance gates

- Inspect the exact staged path set and staged diff before committing.
- Re-fetch before pushing `main`; never force-push over concurrent work.
- Run source/schema compatibility checks before both staging and production.
- Save all four active release symlink targets before deployment.
- Accept staging only after release provenance, generated storefront, backend,
  email worker, queues, logs, Nginx, and authenticated/public probes pass.
- Install the Xray updater separately from the application deploy using an
  exact committed candidate and a retained root-only backup; verify the normal
  oneshot, state v2, timer, loopback listeners, canaries, and secret absence.
- Accept production only after the same immutable revision and full postflight
  checks pass.

## Explicitly separate follow-ups

- Historical CDEK effects in `needs_review`, legacy `api.komui.ru` upstream
  failures, certificate-helper drift, and off-server backup-key custody are not
  hidden by this synchronization. They require separate operational decisions
  and are not modified by this task.
