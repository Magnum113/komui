# PostgreSQL schema changes

`db/migrations/` contains the SQL changes used by the self-hosted KOMUI
PostgreSQL databases. These files are applied through the controlled server
rollout with `psql`; no hosted database CLI or external data API is required.

The directory contains historical forward migrations that have already been
applied to staging and production. Do not edit an applied migration to make a
new schema change: add a new ordered SQL file and verify it against an isolated
database before rollout.
