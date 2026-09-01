import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260901170000_add_email_contacts_and_subscriptions.sql",
    import.meta.url,
  ),
  "utf8",
);
const singleOptInMigration = readFileSync(
  new URL(
    "../../docs/server-migration/sql/email-single-opt-in-forward.sql",
    import.meta.url,
  ),
  "utf8",
);

test("email contacts migration creates one normalized contact and append-only consent evidence", () => {
  assert.match(migration, /create table if not exists public\.merch_email_contacts/i);
  assert.match(migration, /email_normalized text not null unique/i);
  assert.match(migration, /'not_subscribed'[\s\S]*'pending'[\s\S]*'subscribed'/i);
  assert.match(migration, /create table if not exists public\.merch_email_consent_events/i);
  assert.match(migration, /event_key text not null unique/i);
  assert.match(migration, /grant select, insert on public\.merch_email_consent_events to komui_app/i);
  assert.doesNotMatch(migration, /grant[^;]*update[^;]*merch_email_consent_events to komui_app/i);
});

test("email contacts migration backfills orders and links outbox messages", () => {
  assert.match(migration, /from public\.merch_customer_orders/i);
  assert.match(migration, /legacy-checkout-granted:/i);
  assert.match(migration, /add column if not exists contact_id uuid/i);
  assert.match(migration, /update public\.merch_email_outbox outbox[\s\S]*set contact_id/i);
});

test("email contacts migration keeps suppressions and paid-order aggregates synchronized", () => {
  assert.match(migration, /merch_email_suppressions_sync_contact/i);
  assert.match(
    migration,
    /create or replace function private\.merch_remove_unsubscribed_email_suppression[\s\S]*security definer/i,
  );
  assert.match(
    migration,
    /grant execute on function private\.merch_remove_unsubscribed_email_suppression\(text\) to komui_app/i,
  );
  assert.doesNotMatch(
    migration,
    /grant[^;]*delete[^;]*merch_email_suppressions to komui_app/i,
  );
  assert.match(migration, /merch_customer_orders_refresh_email_contact_stats/i);
  assert.match(migration, /count\(\*\) filter \(where paid_at is not null\)/i);
  assert.match(migration, /merch_email_outbox_sync_contact_sent/i);
});

test("single opt-in transition activates only explicit unsuppressed footer requests", () => {
  assert.match(singleOptInMigration, /contacts\.marketing_status = 'pending'/i);
  assert.match(singleOptInMigration, /events\.action = 'requested'/i);
  assert.match(singleOptInMigration, /events\.source = 'footer'/i);
  assert.match(singleOptInMigration, /not exists[\s\S]*merch_email_suppressions/i);
  assert.match(singleOptInMigration, /'unsubscribed'[\s\S]*'hard_bounce'[\s\S]*'spam_complaint'[\s\S]*'manual'/i);
  assert.match(singleOptInMigration, /'granted'[\s\S]*'single_opt_in', true/i);
  assert.match(singleOptInMigration, /marketing_status = 'subscribed'/i);
  assert.match(singleOptInMigration, /event_type = 'subscription_confirmation'/i);
  assert.match(singleOptInMigration, /status in \('pending', 'retry', 'processing'\) then 'cancelled'/i);
  assert.match(singleOptInMigration, /payload - 'confirmationUrl'/i);
});
