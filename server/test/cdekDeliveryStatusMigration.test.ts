import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../db/migrations/20260907150000_add_cdek_delivery_status_emails.sql",
    import.meta.url,
  ),
  "utf8",
);

test("CDEK delivery migration separates provider delivery state from creation state", () => {
  for (const column of [
    "delivery_status_code",
    "delivery_status_at",
    "delivery_status_terminal",
    "delivery_status_synced_at",
    "delivery_status_sync_attempts",
    "delivery_status_sync_error",
    "delivery_status_next_sync_at",
    "planned_delivery_date",
    "keep_free_until",
    "delivery_mode",
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}`, "i"));
  }
  assert.match(migration, /merch_cdek_shipments_delivery_sync_due_idx/i);
  assert.match(migration, /where cdek_uuid is not null[\s\S]*delivery_status_terminal is false/i);
});

test("CDEK delivery migration preserves idempotent provider event history", () => {
  for (const column of [
    "status_at",
    "reason_code",
    "status_city",
    "status_deleted",
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}`, "i"));
  }
  assert.match(migration, /merch_cdek_events_status_at_idx/i);
  assert.match(migration, /grant select, insert on public\.merch_cdek_events to komui_app/i);
  assert.doesNotMatch(
    migration,
    /grant[^;]*update[^;]*public\.merch_cdek_events to komui_app/i,
  );
});
