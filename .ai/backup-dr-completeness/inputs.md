# Inputs

- User request: proceed to the next logical stage after the successful exact
  post-drain restore drill.
- Selected stage:
  - preserve PostgreSQL ownership and ACL recovery data;
  - include the complete active production runtime in the encrypted bundle;
  - deploy the revised backup script without changing application runtime;
  - create and upload a new archive;
  - download that exact archive back from Object Storage;
  - restore and validate both DB dumps, then remove all drill state.
- Recoverable scope:
  - `komui_staging` and `komui_production` only;
  - global roles and non-system memberships required by their owners/ACL;
  - global role settings and settings bound to those two databases;
  - `fullClusterRecovery=false` and `fullPostgresCluster=false` in manifest.
- Constraints:
  - do not restart/switch staging or production application runtime;
  - do not call T-Bank/CDEK or create provider-side entities;
  - do not weaken permissions or print secrets/password hashes;
  - never apply globals to the live PostgreSQL cluster;
  - preserve all unrelated worktree changes.
