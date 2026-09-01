import { createHash } from "node:crypto";
import type { AppConfig } from "../config";

export type EmailMessageClass = "transactional" | "marketing";

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export type EmailSendRequest = {
  recipientEmail: string;
  messageClass: EmailMessageClass;
  templateKey: string;
  idempotencyKey: string;
  rendered: RenderedEmail;
  metadata?: Record<string, string>;
};

export type EmailSendResult = {
  provider: "unisender_go";
  providerMessageId: string;
  accepted: true;
};

export type EmailProviderErrorKind =
  | "configuration"
  | "temporary"
  | "permanent"
  | "duplicate";

export class EmailProviderError extends Error {
  constructor(
    public readonly kind: EmailProviderErrorKind,
    public readonly code: string,
    message: string,
    public readonly providerCode: number | null = null,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }

  get retryable() {
    return this.kind === "temporary";
  }
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type UnisenderResponse = {
  status?: unknown;
  job_id?: unknown;
  emails?: unknown;
  failed_emails?: unknown;
  code?: unknown;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TEMPORARY_RECIPIENT_ERRORS = new Set(["temporary_unavailable"]);
const DUPLICATE_API_CODE = 1573;
const TEMPORARY_API_CODES = new Set([204]);

export function normalizeRecipientEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function maskEmail(value: string): string {
  const normalized = normalizeRecipientEmail(value);
  const [local = "", domain = ""] = normalized.split("@");
  if (!local || !domain) return "***";
  const [domainName = "", ...suffixParts] = domain.split(".");
  const suffix = suffixParts.length ? `.${suffixParts.join(".")}` : "";
  return `${local.slice(0, 1)}***@${domainName.slice(0, 1)}***${suffix}`;
}

export function providerIdempotencyKey(value: string): string {
  const digest = createHash("sha256").update(value).digest("base64url");
  return `komui-${digest}`;
}

export function allowedEmailRecipients(config: AppConfig): Set<string> {
  return new Set(
    config.EMAIL_ALLOWED_RECIPIENTS.split(/[\s,;]+/)
      .map(normalizeRecipientEmail)
      .filter(Boolean),
  );
}

function apiEndpoint(config: AppConfig): string {
  const url = new URL(config.UNISENDER_GO_API_URL);
  if (url.protocol !== "https:") {
    throw new EmailProviderError(
      "configuration",
      "email_api_https_required",
      "Email provider API must use HTTPS",
    );
  }
  return `${url.toString().replace(/\/$/, "")}/email/send.json`;
}

function assertSendAllowed(config: AppConfig, recipientEmail: string) {
  if (!config.EMAIL_ENABLED) {
    throw new EmailProviderError(
      "configuration",
      "email_disabled",
      "Email delivery is disabled",
    );
  }
  if (
    !config.EMAIL_FROM ||
    !config.EMAIL_REPLY_TO ||
    !config.UNISENDER_GO_API_KEY
  ) {
    throw new EmailProviderError(
      "configuration",
      "email_not_configured",
      "Email provider is not fully configured",
    );
  }
  if (config.NODE_ENV !== "production" && !config.EMAIL_TEST_MODE) {
    throw new EmailProviderError(
      "configuration",
      "email_test_mode_required",
      "Non-production email delivery requires test mode",
    );
  }
  if (
    config.EMAIL_TEST_MODE &&
    !allowedEmailRecipients(config).has(recipientEmail)
  ) {
    throw new EmailProviderError(
      "permanent",
      "email_recipient_not_allowed",
      `Test email recipient ${maskEmail(recipientEmail)} is not allowlisted`,
    );
  }
}

function safeMetadata(
  templateKey: string,
  messageClass: EmailMessageClass,
  values: Record<string, string> | undefined,
) {
  const result: Record<string, string> = {
    event_type: templateKey.slice(0, 64),
    message_class: messageClass,
  };
  for (const [key, value] of Object.entries(values ?? {}).slice(0, 8)) {
    if (key === "event_type" || key === "message_class") continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    result[key] = String(value).slice(0, 1024);
  }
  return result;
}

function subjectWithPrefix(config: AppConfig, subject: string): string {
  return [config.EMAIL_SUBJECT_PREFIX, subject.trim()]
    .filter(Boolean)
    .join(" ")
    .slice(0, 998);
}

function providerTemplateEngine(request: EmailSendRequest): "none" | "simple" {
  if (request.templateKey !== "subscription_confirmation") return "none";
  if (!request.rendered.html.includes("{{UnsubscribeUrl}}")) {
    throw new EmailProviderError(
      "configuration",
      "email_unsubscribe_link_missing",
      "Subscription confirmation template must contain an unsubscribe link",
    );
  }
  return "simple";
}

async function parseResponse(response: Response): Promise<UnisenderResponse> {
  const raw = (await response.text()).slice(0, 64_000);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as UnisenderResponse)
      : {};
  } catch {
    throw new EmailProviderError(
      "temporary",
      "email_provider_invalid_response",
      "Email provider returned invalid JSON",
      null,
      response.status,
    );
  }
}

function numericProviderCode(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function providerHttpError(response: Response, body: UnisenderResponse) {
  const providerCode = numericProviderCode(body.code);
  if (providerCode === DUPLICATE_API_CODE) {
    return new EmailProviderError(
      "duplicate",
      "email_provider_duplicate",
      "Email provider has already received this idempotent request",
      providerCode,
      response.status,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new EmailProviderError(
      "permanent",
      "email_provider_auth_rejected",
      "Email provider rejected authentication",
      providerCode,
      response.status,
    );
  }
  const retryable =
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500 ||
    (providerCode !== null && TEMPORARY_API_CODES.has(providerCode));
  return new EmailProviderError(
    retryable ? "temporary" : "permanent",
    retryable ? "email_provider_temporary_error" : "email_provider_rejected",
    retryable
      ? "Email provider is temporarily unavailable"
      : "Email provider rejected the request",
    providerCode,
    response.status,
  );
}

function recipientFailure(
  recipientEmail: string,
  failedEmails: unknown,
): EmailProviderError | null {
  if (!failedEmails || typeof failedEmails !== "object") return null;
  const reason = (failedEmails as Record<string, unknown>)[recipientEmail];
  if (typeof reason !== "string") return null;
  const normalizedReason = reason.slice(0, 80);
  return new EmailProviderError(
    TEMPORARY_RECIPIENT_ERRORS.has(normalizedReason)
      ? "temporary"
      : normalizedReason === "duplicate"
        ? "duplicate"
        : "permanent",
    `email_recipient_${normalizedReason.replace(/[^a-z0-9_]/g, "_")}`,
    `Email provider did not accept recipient ${maskEmail(recipientEmail)}`,
  );
}

export class UnisenderGoClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    const recipientEmail = normalizeRecipientEmail(request.recipientEmail);
    if (!EMAIL_PATTERN.test(recipientEmail)) {
      throw new EmailProviderError(
        "permanent",
        "email_recipient_invalid",
        "Email recipient is invalid",
      );
    }
    assertSendAllowed(this.config, recipientEmail);

    const payload = {
      message: {
        recipients: [
          {
            email: recipientEmail,
            metadata: safeMetadata(
              request.templateKey,
              request.messageClass,
              request.metadata,
            ),
          },
        ],
        tags: [request.templateKey.slice(0, 50)],
        global_language: "ru",
        template_engine: providerTemplateEngine(request),
        body: {
          html: request.rendered.html,
          plaintext: request.rendered.text,
        },
        subject: subjectWithPrefix(this.config, request.rendered.subject),
        from_email: this.config.EMAIL_FROM,
        from_name: this.config.EMAIL_FROM_NAME,
        reply_to: this.config.EMAIL_REPLY_TO,
        reply_to_name: this.config.EMAIL_FROM_NAME,
        idempotence_key: providerIdempotencyKey(request.idempotencyKey),
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(apiEndpoint(this.config), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-KEY": this.config.UNISENDER_GO_API_KEY!,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(
          this.config.UNISENDER_GO_REQUEST_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      if (error instanceof EmailProviderError) throw error;
      throw new EmailProviderError(
        "temporary",
        "email_provider_network_error",
        "Unable to reach email provider",
      );
    }

    const body = await parseResponse(response);
    if (!response.ok) throw providerHttpError(response, body);

    const failed = recipientFailure(recipientEmail, body.failed_emails);
    if (failed) throw failed;
    if (body.status !== "success" || typeof body.job_id !== "string") {
      throw new EmailProviderError(
        "temporary",
        "email_provider_incomplete_response",
        "Email provider returned an incomplete response",
        numericProviderCode(body.code),
        response.status,
      );
    }

    return {
      provider: "unisender_go",
      providerMessageId: body.job_id.slice(0, 255),
      accepted: true,
    };
  }
}
