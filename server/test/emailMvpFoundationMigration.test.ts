import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260831193000_add_email_mvp_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

test("email MVP migration stores coherent marketing consent evidence", () => {
  assert.match(migration, /marketing_consent_at timestamptz/i);
  assert.match(migration, /marketing_consent_version text/i);
  assert.match(migration, /marketing_consent_source text/i);
  assert.match(
    migration,
    /before insert on public\.merch_customer_orders[\s\S]*merch_fill_marketing_consent_evidence/i,
  );
  assert.match(migration, /marketing_consent_source in \('checkout', 'legacy_checkout'\)/i);
  assert.match(migration, /validate constraint merch_customer_orders_marketing_consent_evidence_check/i);
});

test("email MVP migration creates an idempotent private outbox", () => {
  assert.match(migration, /create table if not exists public\.merch_email_outbox/i);
  assert.match(migration, /idempotency_key text not null unique/i);
  assert.match(migration, /message_class in \('transactional', 'marketing'\)/i);
  assert.match(migration, /where status in \('pending', 'retry', 'processing'\)/i);
  assert.match(migration, /alter table public\.merch_email_outbox enable row level security/i);
  assert.match(
    migration,
    /grant select, insert, update on public\.merch_email_outbox to komui_app/i,
  );
  assert.match(migration, /No direct anon access to email outbox/i);
  assert.match(migration, /No direct authenticated access to email outbox/i);
});

test("email MVP migration creates the suppression registry", () => {
  assert.match(migration, /create table if not exists public\.merch_email_suppressions/i);
  assert.match(migration, /'unsubscribed', 'hard_bounce', 'spam_complaint', 'manual'/i);
});

test("server checkout submits versioned consent and links to its text", () => {
  const checkout = readFileSync(
    new URL("../src/checkout.ts", import.meta.url),
    "utf8",
  );
  const paymentHandler = readFileSync(
    new URL("../src/stage5.ts", import.meta.url),
    "utf8",
  );
  const checkoutPage = readFileSync(
    new URL("../../checkout.html", import.meta.url),
    "utf8",
  );

  assert.match(checkout, /checkout-email-marketing-v1/);
  assert.match(checkout, /MARKETING_CONSENT_SOURCE = ["']checkout["']/);
  assert.match(paymentHandler, /marketing_consent_at/);
  assert.match(paymentHandler, /marketing_consent_version/);
  assert.match(paymentHandler, /marketing_consent_source/);
  assert.match(paymentHandler, /marketingConsentEvidence\(/);
  assert.match(checkoutPage, /id="marketingConsent" type="checkbox"/);
  assert.doesNotMatch(checkoutPage, /id="marketingConsent"[^>]*checked/);
  assert.match(checkoutPage, /href="\/marketing-consent"/);
});
