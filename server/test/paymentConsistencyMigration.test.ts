import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260830143000_harden_payment_consistency.sql",
    import.meta.url,
  ),
  "utf8",
);

test("payment consistency migration contains every runtime state and durable effect primitive", () => {
  assert.match(migration, /'payment_unknown'/);
  assert.match(migration, /'deleting'/);
  assert.match(migration, /create table if not exists public\.merch_order_effects/i);
  assert.match(migration, /dedupe_key text not null unique/i);
  assert.match(migration, /for each row execute function private\.merch_set_updated_at\(\)/i);
  assert.match(migration, /provider_status in \('INITIATING', 'INIT_UNKNOWN', 'RECONCILING_INIT'\)/);
  assert.match(migration, /payment_url is null[\s\S]*'FORM_SHOWED'[\s\S]*'REFUNDING'/);
  assert.match(migration, /payment_url is null[\s\S]*'AUTH_FAIL'/);
  assert.match(migration, /rolname = 'komui_app'/);
  assert.match(
    migration,
    /grant select, insert, update on public\.merch_order_effects to komui_app/i,
  );
  assert.match(migration, /Backend access to order effects/);
  assert.doesNotMatch(
    migration,
    /^revoke all on public\.merch_order_effects from public, anon, authenticated/m,
  );
});

test("historical CDEK cancellation backfill cannot act on a currently paid order", () => {
  const backfill = migration.slice(
    migration.indexOf("insert into public.merch_order_effects"),
  );
  assert.match(backfill, /orders\.status = 'refunded'/);
  assert.match(
    backfill,
    /orders\.status = 'payment_failed'[\s\S]*attempts\.provider_status = 'REVERSED'/,
  );
  assert.doesNotMatch(backfill, /orders\.status = 'paid'/);
  assert.match(backfill, /on conflict \(dedupe_key\) do nothing/i);
});
