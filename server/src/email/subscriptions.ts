import { randomBytes } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { QueryResultRow } from "pg";
import type { Db } from "../db";
import { HttpError } from "../errors";
import {
  emailRequestEvidence,
  FOOTER_MARKETING_CONSENT_SOURCE,
  FOOTER_MARKETING_CONSENT_VERSION,
  normalizeContactEmail,
  PRIVACY_POLICY_VERSION,
  sha256Hex,
  type RequestEvidence,
} from "./contacts";

type SubscriptionContext = {
  db: Db;
};

type ContactRow = QueryResultRow & {
  id: string;
  marketing_status: string;
};

type ConfirmationRow = QueryResultRow & {
  id: string;
  email_normalized: string;
};

type SubscriptionOptions = {
  now?: Date;
  eventNonce?: string;
};

type RateBucket = { count: number; resetAt: number };

const rateLimitWindowMs = 60 * 60_000;
const rateLimitMax = 10;
const rateBuckets = new Map<string, RateBucket>();

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new HttpError(400, "invalid_subscription_request", "Проверьте данные формы");
  }
  return request.body as Record<string, unknown>;
}

function acceptedReply(reply: FastifyReply) {
  return reply.send({
    ok: true,
    message: "Подписка оформлена. Спасибо!",
  });
}

function consumeRateLimit(key: string | null, now: number): boolean {
  if (!key) return true;
  if (rateBuckets.size > 5_000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    return true;
  }
  if (bucket.count >= rateLimitMax) return false;
  bucket.count += 1;
  return true;
}

function blockedSuppression(reason: string | null): boolean {
  return ["hard_bounce", "spam_complaint", "manual"].includes(reason ?? "");
}

function blockedStatus(status: string): boolean {
  return ["bounced", "complained", "suppressed"].includes(status);
}

function suppressionStatus(reason: string | null): string | null {
  switch (reason) {
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

export async function subscribeFooterEmailContact(
  context: SubscriptionContext,
  input: {
    email: unknown;
    evidence: RequestEvidence;
  },
  options: SubscriptionOptions = {},
): Promise<{ subscribed: boolean }> {
  const email = normalizeContactEmail(input.email);
  const now = options.now ?? new Date();
  const eventNonce = options.eventNonce ?? randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(eventNonce)) {
    throw new Error("invalid_subscription_event_nonce");
  }

  return context.db.withTransaction(async (client) => {
    await client.query(
      `
        /* email_contacts:remove_footer_unsubscribe */
        select private.merch_remove_unsubscribed_email_suppression($1)
      `,
      [email],
    );

    const suppressionResult = await client.query<{ reason: string }>(
      `
        /* email_contacts:footer_suppression */
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
    const initialStatus = forcedStatus ?? "subscribed";

    await client.query(
      `
        /* email_contacts:footer_insert */
        insert into public.merch_email_contacts (
          email_normalized,
          marketing_status,
          marketing_consent_at,
          marketing_consent_version,
          marketing_consent_source,
          suppression_reason
        )
        values ($1, $2, $3::timestamptz, $4, $5, $6)
        on conflict (email_normalized) do nothing
      `,
      [
        email,
        initialStatus,
        now.toISOString(),
        FOOTER_MARKETING_CONSENT_VERSION,
        FOOTER_MARKETING_CONSENT_SOURCE,
        suppressionReason,
      ],
    );

    const contactResult = await client.query<ContactRow>(
      `
        /* email_contacts:footer_lock */
        select id, marketing_status
        from public.merch_email_contacts
        where email_normalized = $1
        for update
      `,
      [email],
    );
    const contact = contactResult.rows[0];
    if (!contact) throw new Error("email_contact_unavailable");

    const nextStatus = forcedStatus
      ?? (blockedStatus(contact.marketing_status)
        ? contact.marketing_status
        : "subscribed");

    await client.query(
      `
        /* email_contacts:footer_subscribe */
        update public.merch_email_contacts
        set
          marketing_status = $2,
          marketing_consent_at = $3::timestamptz,
          marketing_consent_version = $4,
          marketing_consent_source = $5,
          confirmation_token_hash = null,
          confirmation_expires_at = null,
          confirmation_sent_at = null,
          unsubscribed_at = case when $2 = 'subscribed' then null else unsubscribed_at end,
          suppression_reason = $6
        where id = $1::uuid
      `,
      [
        contact.id,
        nextStatus,
        now.toISOString(),
        FOOTER_MARKETING_CONSENT_VERSION,
        FOOTER_MARKETING_CONSENT_SOURCE,
        suppressionReason,
      ],
    );

    await client.query(
      `
        /* email_contacts:footer_granted_event */
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
        values (
          $1,
          $2::uuid,
          'granted',
          'footer',
          $3::timestamptz,
          $4,
          $5,
          $6,
          $7,
          jsonb_build_object('single_opt_in', true)
        )
        on conflict (event_key) do nothing
      `,
      [
        `footer-granted:${contact.id}:${eventNonce}`,
        contact.id,
        now.toISOString(),
        FOOTER_MARKETING_CONSENT_VERSION,
        PRIVACY_POLICY_VERSION,
        input.evidence.requestIpHash,
        input.evidence.userAgent,
      ],
    );

    return { subscribed: nextStatus === "subscribed" };
  });
}

export async function confirmFooterEmailSubscription(
  context: SubscriptionContext,
  input: {
    token: unknown;
    evidence: RequestEvidence;
  },
  options: Pick<SubscriptionOptions, "now"> = {},
): Promise<{ confirmed: boolean; alreadyConfirmed: boolean }> {
  const token = boundedText(input.token, 200);
  if (token.length < 32) {
    throw new HttpError(400, "invalid_confirmation_link", "Ссылка подтверждения недействительна");
  }
  const tokenHash = sha256Hex(token);
  const now = options.now ?? new Date();

  return context.db.withTransaction(async (client) => {
    const contactResult = await client.query<ConfirmationRow>(
      `
        /* email_contacts:confirmation_lock */
        select id, email_normalized
        from public.merch_email_contacts
        where confirmation_token_hash = $1
          and confirmation_expires_at >= $2::timestamptz
        for update
      `,
      [tokenHash, now.toISOString()],
    );
    const contact = contactResult.rows[0];

    if (!contact) {
      const repeated = await client.query<{ exists: boolean }>(
        `
          /* email_contacts:confirmation_replay */
          select exists (
            select 1
            from public.merch_email_consent_events
            where action = 'confirmed'
              and confirmation_token_hash = $1
          ) as exists
        `,
        [tokenHash],
      );
      if (repeated.rows[0]?.exists) {
        return { confirmed: true, alreadyConfirmed: true };
      }
      throw new HttpError(
        400,
        "invalid_confirmation_link",
        "Ссылка устарела или уже недействительна. Отправьте форму подписки ещё раз.",
      );
    }

    const suppressionResult = await client.query<{ reason: string }>(
      `
        /* email_contacts:confirmation_suppression */
        select reason
        from public.merch_email_suppressions
        where email_normalized = $1
        limit 1
      `,
      [contact.email_normalized],
    );
    const suppressionReason = boundedText(
      suppressionResult.rows[0]?.reason,
      80,
    ).toLowerCase() || null;
    if (blockedSuppression(suppressionReason)) {
      throw new HttpError(
        409,
        "subscription_suppressed",
        "Не удалось активировать подписку для этого адреса.",
      );
    }

    await client.query(
      `
        /* email_contacts:remove_confirmed_unsubscribe */
        select private.merch_remove_unsubscribed_email_suppression($1)
      `,
      [contact.email_normalized],
    );

    await client.query(
      `
        /* email_contacts:confirm */
        update public.merch_email_contacts
        set
          marketing_status = 'subscribed',
          marketing_consent_at = $2::timestamptz,
          marketing_consent_version = $3,
          marketing_consent_source = $4,
          confirmation_token_hash = null,
          confirmation_expires_at = null,
          unsubscribed_at = null,
          suppression_reason = null
        where id = $1::uuid
      `,
      [
        contact.id,
        now.toISOString(),
        FOOTER_MARKETING_CONSENT_VERSION,
        FOOTER_MARKETING_CONSENT_SOURCE,
      ],
    );

    await client.query(
      `
        /* email_contacts:footer_confirmed_event */
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
          confirmation_token_hash,
          metadata
        )
        values (
          $1,
          $2::uuid,
          'confirmed',
          'footer',
          $3::timestamptz,
          $4,
          $5,
          $6,
          $7,
          $8,
          jsonb_build_object('double_opt_in', true)
        )
        on conflict (event_key) do nothing
      `,
      [
        `footer-confirmed:${contact.id}:${tokenHash.slice(0, 24)}`,
        contact.id,
        now.toISOString(),
        FOOTER_MARKETING_CONSENT_VERSION,
        PRIVACY_POLICY_VERSION,
        input.evidence.requestIpHash,
        input.evidence.userAgent,
        tokenHash,
      ],
    );

    await client.query(
      `
        /* email_contacts:redact_confirmation_url */
        update public.merch_email_outbox
        set payload = payload - 'confirmationUrl'
        where contact_id = $1::uuid
          and event_type = 'subscription_confirmation'
          and payload ->> 'tokenFingerprint' = $2
      `,
      [contact.id, tokenHash.slice(0, 24)],
    );

    return { confirmed: true, alreadyConfirmed: false };
  });
}

export async function registerEmailSubscriptionRoutes(
  app: FastifyInstance,
  context: SubscriptionContext,
) {
  app.post("/v1/email/subscribe", async (request, reply) => {
    const body = bodyObject(request);
    const honeypot = boundedText(body.company, 200);
    if (honeypot) return acceptedReply(reply);
    if (body.privacyConsent !== true || body.marketingConsent !== true) {
      throw new HttpError(
        400,
        "subscription_consent_required",
        "Необходимо подтвердить оба согласия",
      );
    }

    const evidence = emailRequestEvidence(request);
    if (!consumeRateLimit(evidence.requestIpHash, Date.now())) {
      throw new HttpError(
        429,
        "subscription_rate_limited",
        "Слишком много попыток. Повторите позже.",
      );
    }

    try {
      await subscribeFooterEmailContact(context, {
        email: body.email,
        evidence,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_email") {
        throw new HttpError(400, "invalid_email", "Введите корректный email");
      }
      throw error;
    }
    return acceptedReply(reply);
  });

  app.post("/v1/email/confirm", async (request, reply) => {
    const body = bodyObject(request);
    const result = await confirmFooterEmailSubscription(context, {
      token: body.token,
      evidence: emailRequestEvidence(request),
    });
    return reply.send({
      ok: true,
      confirmed: result.confirmed,
      alreadyConfirmed: result.alreadyConfirmed,
      message: result.alreadyConfirmed
        ? "Подписка уже подтверждена."
        : "Подписка подтверждена.",
    });
  });
}
