-- Convert footer newsletter subscriptions from Double Opt-In to Single Opt-In.
--
-- Run with both KOMUI email workers stopped. This script is idempotent and
-- intentionally activates only contacts that already submitted the footer
-- form with explicit privacy and marketing checkboxes. Suppressed contacts
-- are never reactivated.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';

create temporary table komui_footer_single_opt_in on commit drop as
select distinct on (contacts.id)
  contacts.id as contact_id,
  events.occurred_at as consent_at,
  events.consent_text_version,
  events.privacy_policy_version,
  events.request_ip_hash,
  events.user_agent
from public.merch_email_contacts contacts
join public.merch_email_consent_events events
  on events.contact_id = contacts.id
 and events.action = 'requested'
 and events.source = 'footer'
where contacts.marketing_status = 'pending'
  and not exists (
    select 1
    from public.merch_email_suppressions suppressions
    where suppressions.email_normalized = contacts.email_normalized
      and suppressions.reason in (
        'unsubscribed',
        'hard_bounce',
        'spam_complaint',
        'manual'
      )
  )
order by contacts.id, events.occurred_at desc, events.id desc;

insert into public.merch_email_consent_events (
  event_key,
  contact_id,
  action,
  source,
  occurred_at,
  consent_text_version,
  privacy_policy_version,
  request_ip_hash,
  user_agent,
  metadata
)
select
  'footer-single-opt-in-migration:' || pending.contact_id::text,
  pending.contact_id,
  'granted',
  'footer',
  pending.consent_at,
  pending.consent_text_version,
  pending.privacy_policy_version,
  pending.request_ip_hash,
  pending.user_agent,
  jsonb_build_object(
    'single_opt_in', true,
    'migrated_from', 'double_opt_in_pending',
    'migration', 'email-single-opt-in-v1'
  )
from komui_footer_single_opt_in pending
on conflict (event_key) do nothing;

update public.merch_email_contacts contacts
set
  marketing_status = 'subscribed',
  marketing_consent_at = pending.consent_at,
  marketing_consent_version = pending.consent_text_version,
  marketing_consent_source = 'footer',
  confirmation_token_hash = null,
  confirmation_expires_at = null,
  confirmation_sent_at = null,
  unsubscribed_at = null,
  suppression_reason = null
from komui_footer_single_opt_in pending
where contacts.id = pending.contact_id;

update public.merch_email_outbox outbox
set
  status = case
    when outbox.status in ('pending', 'retry', 'processing') then 'cancelled'
    else outbox.status
  end,
  payload = outbox.payload - 'confirmationUrl',
  next_attempt_at = null,
  locked_at = null,
  locked_by = null,
  last_error = case
    when outbox.status in ('pending', 'retry', 'processing')
      then 'superseded_by_single_opt_in'
    else outbox.last_error
  end
from komui_footer_single_opt_in pending
where outbox.contact_id = pending.contact_id
  and outbox.event_type = 'subscription_confirmation';

commit;

