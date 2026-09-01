import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { HttpError } from "../errors";
import { normalizeRecipientEmail } from "./unisenderGo";

type UnisenderWebhookContext = {
  config: AppConfig;
  db: Db;
};

type SuppressionReason =
  | "unsubscribed"
  | "hard_bounce"
  | "spam_complaint";

type SuppressionAction = {
  email: string;
  reason: SuppressionReason;
  providerEventId: string;
};

const rawWebhookBody = Symbol("unisender-go-raw-body");

type RawBodyRequest = FastifyRequest & {
  [rawWebhookBody]?: string;
};

export type UnisenderWebhookResult = {
  received: number;
  actionable: number;
  suppressedAddresses: number;
  cancelledMarketingJobs: number;
  ignored: number;
  invalid: number;
  duplicates: number;
};

const WEBHOOK_BODY_LIMIT = 1_048_576;
const WEBHOOK_MAX_EVENTS = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MD5_PATTERN = /^[a-f0-9]{32}$/i;

const webhookEventSchema = z
  .object({
    event_name: z.string().trim().min(1).max(100),
    event_data: z.record(z.unknown()),
  })
  .passthrough();

const webhookUserSchema = z
  .object({
    user_id: z.number().int(),
    project_id: z.string().max(200).optional(),
    project_name: z.string().max(300).optional(),
    events: z.array(webhookEventSchema).max(WEBHOOK_MAX_EVENTS),
  })
  .passthrough();

const webhookPayloadSchema = z
  .object({
    auth: z.string().regex(MD5_PATTERN),
    events_by_user: z.array(webhookUserSchema).min(1).max(10),
  })
  .passthrough();

type UnisenderWebhookPayload = z.infer<typeof webhookPayloadSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function jsonStringEnd(source: string, start: number): number | null {
  if (source[start] !== '"') return null;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      if (index >= source.length) return null;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  return null;
}

function jsonValueEnd(source: string, start: number): number | null {
  if (source[start] === '"') return jsonStringEnd(source, start);
  if (source[start] === "{" || source[start] === "[") {
    const stack = [source[start]];
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === '"') {
        const stringEnd = jsonStringEnd(source, index);
        if (!stringEnd) return null;
        index = stringEnd - 1;
        continue;
      }
      if (source[index] === "{" || source[index] === "[") {
        stack.push(source[index]);
        continue;
      }
      if (source[index] === "}" || source[index] === "]") {
        const opening = stack.pop();
        if (
          (opening === "{" && source[index] !== "}") ||
          (opening === "[" && source[index] !== "]")
        ) {
          return null;
        }
        if (!stack.length) return index + 1;
      }
    }
    return null;
  }

  let index = start;
  while (
    index < source.length &&
    source[index] !== "," &&
    source[index] !== "}"
  ) {
    index += 1;
  }
  return index > start ? index : null;
}

function topLevelAuthRange(
  source: string,
): { start: number; end: number } | null {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") return null;
  index += 1;
  let authRange: { start: number; end: number } | null = null;

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === "}") return authRange;

    const keyStart = index;
    const keyEnd = jsonStringEnd(source, keyStart);
    if (!keyEnd) return null;
    let key: unknown;
    try {
      key = JSON.parse(source.slice(keyStart, keyEnd));
    } catch {
      return null;
    }

    index = skipWhitespace(source, keyEnd);
    if (source[index] !== ":") return null;
    const valueStart = skipWhitespace(source, index + 1);
    const valueEnd = jsonValueEnd(source, valueStart);
    if (!valueEnd) return null;

    if (key === "auth") {
      if (authRange || source[valueStart] !== '"') return null;
      let authValue: unknown;
      try {
        authValue = JSON.parse(source.slice(valueStart, valueEnd));
      } catch {
        return null;
      }
      if (typeof authValue !== "string") return null;
      authRange = { start: valueStart, end: valueEnd };
    }

    index = skipWhitespace(source, valueEnd);
    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source[index] === "}") return authRange;
    return null;
  }
  return null;
}

function eventId(
  user: UnisenderWebhookPayload["events_by_user"][number],
  event: UnisenderWebhookPayload["events_by_user"][number]["events"][number],
): string {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        user_id: user.user_id,
        project_id: user.project_id ?? null,
        event_name: event.event_name,
        event_data: event.event_data,
      }),
      "utf8",
    )
    .digest("hex");
  return `unisender:${digest}`;
}

/**
 * Unisender Go signs callbacks with an MD5 hash of the exact string body after
 * replacing the JSON value of `auth` with the API key used to register the
 * webhook. Whitespace and property order must therefore remain untouched.
 */
export function computeUnisenderWebhookAuth(
  rawBody: string,
  apiKey: string,
): string | null {
  const authRange = topLevelAuthRange(rawBody);
  if (!authRange) return null;
  const substituted = `${rawBody.slice(0, authRange.start)}${JSON.stringify(
    apiKey,
  )}${rawBody.slice(authRange.end)}`;
  return createHash("md5").update(substituted, "utf8").digest("hex");
}

export function verifyUnisenderWebhookAuth(
  rawBody: string,
  providedAuth: string,
  apiKey: string,
): boolean {
  if (!MD5_PATTERN.test(providedAuth)) return false;
  const expected = computeUnisenderWebhookAuth(rawBody, apiKey);
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected, "ascii");
  const providedBytes = Buffer.from(providedAuth.toLowerCase(), "ascii");
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

function suppressionPriority(reason: SuppressionReason): number {
  switch (reason) {
    case "spam_complaint":
      return 30;
    case "hard_bounce":
      return 20;
    case "unsubscribed":
      return 10;
  }
}

function suppressionReason(status: string): SuppressionReason | null {
  switch (status.toLowerCase()) {
    case "unsubscribed":
      return "unsubscribed";
    case "hard_bounced":
      return "hard_bounce";
    case "spam":
      return "spam_complaint";
    default:
      return null;
  }
}

function eventActions(payload: UnisenderWebhookPayload) {
  const actions = new Map<string, SuppressionAction>();
  const seenEvents = new Set<string>();
  let received = 0;
  let actionable = 0;
  let ignored = 0;
  let invalid = 0;
  let duplicates = 0;

  for (const user of payload.events_by_user) {
    for (const event of user.events) {
      received += 1;
      const providerEventId = eventId(user, event);
      if (seenEvents.has(providerEventId)) {
        duplicates += 1;
        continue;
      }
      seenEvents.add(providerEventId);

      if (event.event_name !== "transactional_email_status") {
        ignored += 1;
        continue;
      }

      const status =
        typeof event.event_data.status === "string"
          ? event.event_data.status.trim().toLowerCase()
          : "";
      const reason = suppressionReason(status);
      if (!reason) {
        ignored += 1;
        continue;
      }

      const email = normalizeRecipientEmail(
        typeof event.event_data.email === "string"
          ? event.event_data.email
          : "",
      );
      if (!EMAIL_PATTERN.test(email)) {
        invalid += 1;
        continue;
      }

      actionable += 1;
      const current = actions.get(email);
      if (
        !current ||
        suppressionPriority(reason) >= suppressionPriority(current.reason)
      ) {
        actions.set(email, { email, reason, providerEventId });
      }
    }
  }

  return {
    actions,
    received,
    actionable,
    ignored,
    invalid,
    duplicates,
  };
}

async function upsertSuppressions(
  client: Pick<PoolClient, "query">,
  actions: SuppressionAction[],
) {
  await client.query(
    `
      /* email_webhook:upsert_suppression */
      with incoming as (
        select
          email,
          reason,
          provider_event_id
        from jsonb_to_recordset($1::jsonb) as event(
          email text,
          reason text,
          provider_event_id text
        )
      )
      insert into public.merch_email_suppressions (
        email_normalized,
        reason,
        source,
        provider_event_id
      )
      select
        incoming.email,
        incoming.reason,
        'unisender_go_webhook',
        incoming.provider_event_id
      from incoming
      on conflict (email_normalized) do update
      set reason = excluded.reason,
          source = excluded.source,
          provider_event_id = excluded.provider_event_id
      where (
        case excluded.reason
          when 'spam_complaint' then 30
          when 'hard_bounce' then 20
          when 'unsubscribed' then 10
          else 0
        end
      ) >= (
        case merch_email_suppressions.reason
          when 'manual' then 40
          when 'spam_complaint' then 30
          when 'hard_bounce' then 20
          when 'unsubscribed' then 10
          else 0
        end
      )
    `,
    [
      JSON.stringify(
        actions.map((action) => ({
          email: action.email,
          reason: action.reason,
          provider_event_id: action.providerEventId,
        })),
      ),
    ],
  );
}

async function cancelPendingMarketing(
  client: Pick<PoolClient, "query">,
  actions: SuppressionAction[],
): Promise<number> {
  const result = await client.query(
    `
      /* email_webhook:cancel_marketing */
      with incoming as (
        select distinct email, reason
        from jsonb_to_recordset($1::jsonb) as event(
          email text,
          reason text
        )
      )
      update public.merch_email_outbox
      set status = 'cancelled',
          next_attempt_at = null,
          locked_at = null,
          locked_by = null,
          last_error = 'suppressed:' || incoming.reason
      from incoming
      where recipient_email = incoming.email
        and message_class = 'marketing'
        and status in ('pending', 'retry')
    `,
    [
      JSON.stringify(
        actions.map((action) => ({
          email: action.email,
          reason: action.reason,
        })),
      ),
    ],
  );
  return result.rowCount ?? 0;
}

async function recordProviderUnsubscribes(
  client: Pick<PoolClient, "query">,
  actions: SuppressionAction[],
) {
  const unsubscribes = actions.filter((action) => action.reason === "unsubscribed");
  if (!unsubscribes.length) return;
  await client.query(
    `
      /* email_webhook:record_unsubscribe_consent */
      with incoming as (
        select email, provider_event_id
        from jsonb_to_recordset($1::jsonb) as event(
          email text,
          provider_event_id text
        )
      )
      insert into public.merch_email_consent_events (
        event_key,
        contact_id,
        action,
        source,
        occurred_at,
        consent_text_version,
        privacy_policy_version,
        metadata
      )
      select
        'provider-revoked:' || incoming.provider_event_id,
        contacts.id,
        'revoked',
        'provider',
        now(),
        'provider-unsubscribe-v1',
        'privacy-2026-07-21',
        jsonb_build_object('provider', 'unisender_go')
      from incoming
      join public.merch_email_contacts contacts
        on contacts.email_normalized = incoming.email
      on conflict (event_key) do nothing
    `,
    [
      JSON.stringify(
        unsubscribes.map((action) => ({
          email: action.email,
          provider_event_id: action.providerEventId,
        })),
      ),
    ],
  );
}

export async function processUnisenderWebhook(
  db: Pick<Db, "withTransaction">,
  payload: UnisenderWebhookPayload,
): Promise<UnisenderWebhookResult> {
  const extracted = eventActions(payload);
  if (extracted.received > WEBHOOK_MAX_EVENTS) {
    throw new HttpError(
      400,
      "unisender_webhook_too_many_events",
      "Webhook event batch is too large",
    );
  }

  const actions = [...extracted.actions.values()];
  const cancelledMarketingJobs = actions.length
    ? await db.withTransaction(async (client) => {
        await upsertSuppressions(client, actions);
        await recordProviderUnsubscribes(client, actions);
        return cancelPendingMarketing(client, actions);
      })
    : 0;

  return {
    received: extracted.received,
    actionable: extracted.actionable,
    suppressedAddresses: extracted.actions.size,
    cancelledMarketingJobs,
    ignored: extracted.ignored,
    invalid: extracted.invalid,
    duplicates: extracted.duplicates,
  };
}

export async function registerUnisenderGoWebhook(
  app: FastifyInstance,
  context: UnisenderWebhookContext,
) {
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: WEBHOOK_BODY_LIMIT },
    (request, body, done) => {
      const rawBody = String(body);
      (request as RawBodyRequest)[rawWebhookBody] = rawBody;
      defaultJsonParser(request, rawBody, done);
    },
  );

  // Unisender validates a webhook URL with an unauthenticated GET before it
  // saves the callback. Do not reveal runtime configuration in this response.
  app.get("/v1/webhooks/unisender-go", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({ ok: true }),
  );

  app.post(
    "/v1/webhooks/unisender-go",
    { bodyLimit: WEBHOOK_BODY_LIMIT },
    async (request, reply) => {
      if (!context.config.UNISENDER_GO_WEBHOOK_ENABLED) {
        throw new HttpError(
          503,
          "unisender_webhook_disabled",
          "Email provider webhook is disabled",
        );
      }
      const apiKey = context.config.UNISENDER_GO_API_KEY;
      if (!apiKey) {
        throw new HttpError(
          503,
          "unisender_webhook_not_configured",
          "Email provider webhook is not configured",
        );
      }

      const rawBody = (request as RawBodyRequest)[rawWebhookBody];
      const parsed = webhookPayloadSchema.safeParse(request.body);
      if (!rawBody || !parsed.success) {
        throw new HttpError(
          400,
          "unisender_webhook_invalid_payload",
          "Invalid email provider webhook payload",
        );
      }
      if (!verifyUnisenderWebhookAuth(rawBody, parsed.data.auth, apiKey)) {
        request.log.warn("Unisender webhook authentication failed");
        throw new HttpError(
          401,
          "unisender_webhook_unauthorized",
          "Invalid email provider webhook signature",
        );
      }

      const result = await processUnisenderWebhook(context.db, parsed.data);
      request.log.info(
        {
          received: result.received,
          actionable: result.actionable,
          suppressedAddresses: result.suppressedAddresses,
          cancelledMarketingJobs: result.cancelledMarketingJobs,
          ignored: result.ignored,
          invalid: result.invalid,
          duplicates: result.duplicates,
        },
        "Unisender webhook processed",
      );
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    },
  );
}
