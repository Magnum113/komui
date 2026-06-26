# Stage 3 runbook

These scripts are prepared but must not be run until a source PostgreSQL
connection string is stored on the server in:

`/etc/komui/source-supabase.env`

Required format:

```text
SOURCE_DATABASE_URL=postgresql://...
```

The file must be `0600 root:root`. It is temporary and must be deleted after the
encrypted dump is verified.

Order:

1. Run `stage3-dump.sh`.
2. Run `stage3-restore.sh` for `komui_staging`.
3. Run `stage3-validate.sh`.
4. Repeat restore into `komui_restore_verify`.
5. Compare validation outputs.
6. Drop `komui_restore_verify`.
7. Remove `/etc/komui/source-supabase.env`.

The dump connection forces `default_transaction_read_only=on`. The resulting
custom-format dump is encrypted with AES-256 and stored root-only.
