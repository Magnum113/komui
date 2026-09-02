import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient, QueryResultRow } from "pg";
import type { FastifyRequest } from "fastify";
import { normalizeRecipientEmail } from "./unisenderGo";

export const PRIVACY_POLICY_VERSION = "privacy-2026-07-21";
export const FOOTER_MARKETING_CONSENT_VERSION = "footer-email-marketing-v1";
export const FOOTER_MARKETING_CONSENT_SOURCE = "footer";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type EmailContactQueryable = Pick<PoolClient, "query">;

type ContactRow = QueryResultRow & {
  id: string;
  marketing_status: string;
};

export type RequestEvidence = {
  requestIpHash: string | null;
  userAgent: string | null;
};

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeContactEmail(value: unknown): string {
  const email = normalizeRecipientEmail(boundedText(value, 254));
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error("invalid_email");
  }
  return email;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestIp(request: FastifyRequest): string | null {
  const realIpHeader = request.headers["x-real-ip"];
  const realIp = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;
  const candidate = boundedText(realIp, 64);
  if (candidate && isIP(candidate)) return candidate;
  return isIP(request.ip) ? request.ip : null;
}

export function emailRequestEvidence(request: FastifyRequest): RequestEvidence {
  const ip = requestIp(request);
  const userAgent = boundedText(request.headers["user-agent"], 300) || null;
  return {
    requestIpHash: ip ? sha256Hex(ip) : null,
    userAgent,
  };
}

function suppressionStatus(reason: string | null): string | null {
  switch (reason) {
    case "unsubscribed":
      return "unsubscribed";
    case "hard_bounce":
      return "bounced";
    case "spam_complaint":
      return "complained";
    case "manual":
      return "suppressed";
    default:
      return null;
  }
}

export async function upsertCheckoutEmailContact(
  queryable: EmailContactQueryable,
  input: {
    orderId: string;
    email: string;
    displayName: string;
    marketingConsent: boolean;
    consentAt: string;
    consentVersion: string;
    consentSource: "checkout";
    evidence: RequestEvidence;
  },
): Promise<{ contactId: string; marketingStatus: string }> {
  const email = normalizeContactEmail(input.email);
  const displayName = boundedText(input.displayName, 160) || null;

  if (input.marketingConsent) {
    await queryable.query(
      `
        /* email_contacts:remove_checkout_unsubscribe */
        select private.merch_remove_unsubscribed_email_suppression($1)
      `,
      [email],
    );
  }

  const suppressionResult = await queryable.query<{ reason: string }>(
    `
      /* email_contacts:checkout_suppression */
      select reason
      from public.merch_email_suppressions
      where email_normalized = $1
      limit 1
    `,
    [email],
  );
  const suppressionReason = boundedText(
    suppressionResult.rows[0]?.reason,
    80,
  ).toLowerCase() || null;
  const forcedStatus = suppressionStatus(suppressionReason);
  const initialStatus = forcedStatus ?? (input.marketingConsent ? "subscribed" : "not_subscribed");

  await queryable.query(
    `
      /* email_contacts:checkout_insert */
      insert into public.merch_email_contacts (
        email_normalized,
        display_name,
        marketing_status,
        marketing_consent_at,
        marketing_consent_version,
        marketing_consent_source,
        suppression_reason
      )
      values (
        $1,
        $2,
        $3,
        case when $4::boolean then $5::timestamptz else null end,
        case when $4::boolean then $6 else null end,
        case when $4::boolean then $7 else null end,
        $8
      )
      on conflict (email_normalized) do nothing
    `,
    [
      email,
      displayName,
      initialStatus,
      input.marketingConsent,
      input.consentAt,
      input.consentVersion,
      input.consentSource,
      suppressionReason,
    ],
  );

  const contactResult = await queryable.query<ContactRow>(
    `
      /* email_contacts:checkout_lock */
      select id, marketing_status
      from public.merch_email_contacts
      where email_normalized = $1
      for update
    `,
    [email],
  );
  const contact = contactResult.rows[0];
  if (!contact) throw new Error("email_contact_unavailable");

  const terminalStatus = ["bounced", "complained", "suppressed"].includes(
    contact.marketing_status,
  );
  const nextStatus = forcedStatus
    ?? (input.marketingConsent && !terminalStatus
      ? "subscribed"
      : contact.marketing_status);

  const updated = await queryable.query<ContactRow>(
    `
      /* email_contacts:checkout_update */
      update public.merch_email_contacts
      set
        display_name = coalesce($2, display_name),
        marketing_status = $3,
        marketing_consent_at = case when $4::boolean then $5::timestamptz else marketing_consent_at end,
        marketing_consent_version = case when $4::boolean then $6 else marketing_consent_version end,
        marketing_consent_source = case when $4::boolean then $7 else marketing_consent_source end,
        confirmation_token_hash = case when $4::boolean then null else confirmation_token_hash end,
        confirmation_expires_at = case when $4::boolean then null else confirmation_expires_at end,
        unsubscribed_at = case when $3 = 'subscribed' then null else unsubscribed_at end,
        suppression_reason = $8
      where id = $1::uuid
      returning id, marketing_status
    `,
    [
      contact.id,
      displayName,
      nextStatus,
      input.marketingConsent,
      input.consentAt,
      input.consentVersion,
      input.consentSource,
      suppressionReason,
    ],
  );

  if (input.marketingConsent) {
    await queryable.query(
      `
        /* email_contacts:checkout_consent_event */
        insert into public.merch_email_consent_events (
          event_key,
          contact_id,
          order_id,
          action,
          source,
          occurred_at,
          consent_text_version,
          privacy_policy_version,
          request_ip_hash,
          user_agent
        )
        values (
          'checkout-granted:' || $2::text,
          $1::uuid,
          $2::uuid,
          'granted',
          'checkout',
          $3::timestamptz,
          $4,
          $5,
          $6,
          $7
        )
        on conflict (event_key) do nothing
      `,
      [
        contact.id,
        input.orderId,
        input.consentAt,
        input.consentVersion,
        PRIVACY_POLICY_VERSION,
        input.evidence.requestIpHash,
        input.evidence.userAgent,
      ],
    );
  }

  await queryable.query(
    `
      /* email_contacts:checkout_paid_stats */
      update public.merch_email_contacts contacts
      set
        first_paid_order_at = stats.first_paid_order_at,
        last_paid_order_at = stats.last_paid_order_at,
        paid_orders_count = stats.paid_orders_count,
        paid_orders_amount = stats.paid_orders_amount
      from (
        select
          min(paid_at) as first_paid_order_at,
          max(paid_at) as last_paid_order_at,
          count(*) filter (where paid_at is not null)::integer as paid_orders_count,
          coalesce(sum(total_amount) filter (where paid_at is not null), 0)::bigint as paid_orders_amount
        from public.merch_customer_orders
        where lower(btrim(customer_email)) = $2
      ) stats
      where contacts.id = $1::uuid
    `,
    [contact.id, email],
  );

  const row = updated.rows[0] ?? contact;
  return { contactId: row.id, marketingStatus: row.marketing_status };
}
