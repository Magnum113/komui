import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config";
import {
  EmailProviderError,
  maskEmail,
  providerIdempotencyKey,
  UnisenderGoClient,
} from "../src/email/unisenderGo";

function emailConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "staging",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    EMAIL_ENABLED: "true",
    EMAIL_TEST_MODE: "true",
    EMAIL_ALLOWED_RECIPIENTS: "owner@example.com",
    EMAIL_FROM: "hello@komui.ru",
    EMAIL_FROM_NAME: "KOMUI",
    EMAIL_REPLY_TO: "reply@example.com",
    EMAIL_SUBJECT_PREFIX: "[STAGE]",
    UNISENDER_GO_API_KEY: "secret-project-api-key",
    ...overrides,
  });
}

const request = {
  recipientEmail: "Owner@Example.com",
  messageClass: "transactional" as const,
  templateKey: "order_paid",
  idempotencyKey: "order-paid:7c169f01-b459-4e25-b74f-a4909a1b4149",
  rendered: {
    subject: "Оплата заказа подтверждена",
    html: "<p>Заказ оплачен</p>",
    text: "Заказ оплачен",
  },
  metadata: { order_id: "7c169f01-b459-4e25-b74f-a4909a1b4149" },
};

test("Unisender Go client sends the documented payload without leaking API key", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchMock = async (input: string | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        status: "success",
        job_id: "1ZymBc-00041N-9X",
        emails: ["owner@example.com"],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await new UnisenderGoClient(
    emailConfig(),
    fetchMock,
  ).send(request);

  assert.deepEqual(result, {
    provider: "unisender_go",
    providerMessageId: "1ZymBc-00041N-9X",
    accepted: true,
  });
  assert.equal(
    capturedUrl,
    "https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    (capturedInit?.headers as Record<string, string>)["X-API-KEY"],
    "secret-project-api-key",
  );

  const payload = JSON.parse(String(capturedInit?.body));
  assert.equal("api_key" in payload, false);
  assert.equal(payload.message.recipients[0].email, "owner@example.com");
  assert.equal("substitutions" in payload.message.recipients[0], false);
  assert.equal(JSON.stringify(payload).includes('"to_name"'), false);
  assert.equal(
    payload.message.recipients[0].metadata.message_class,
    "transactional",
  );
  assert.equal(payload.message.subject, "[STAGE] Оплата заказа подтверждена");
  assert.equal(payload.message.body.plaintext, "Заказ оплачен");
  assert.equal(payload.message.template_engine, "none");
  assert.equal(payload.message.global_language, "ru");
  assert.equal(payload.message.tags[0], "order_paid");
  assert.equal(payload.message.idempotence_key.length <= 64, true);
  assert.equal(JSON.stringify(payload).includes("secret-project-api-key"), false);
});

test("provider idempotency key is stable, opaque and within provider limit", () => {
  const first = providerIdempotencyKey(request.idempotencyKey);
  const second = providerIdempotencyKey(request.idempotencyKey);

  assert.equal(first, second);
  assert.match(first, /^komui-[A-Za-z0-9_-]{43}$/);
  assert.equal(first.includes("7c169f01"), false);
  assert.equal(first.length <= 64, true);
});

test("subscription confirmation uses a custom compact unsubscribe link", async () => {
  let capturedInit: RequestInit | undefined;
  const fetchMock = async (_input: string | URL, init?: RequestInit) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({ status: "success", job_id: "subscription-job" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  await new UnisenderGoClient(emailConfig(), fetchMock).send({
    ...request,
    templateKey: "subscription_confirmation",
    idempotencyKey: "subscription-confirm:test",
    rendered: {
      subject: "Подтвердите подписку",
      html: '<a href="{{UnsubscribeUrl}}">Отписаться</a>',
      text: "Отписаться: {{UnsubscribeUrl}}",
    },
  });

  const payload = JSON.parse(String(capturedInit?.body));
  assert.equal(payload.message.template_engine, "simple");
  assert.match(payload.message.body.html, /\{\{UnsubscribeUrl\}\}/);
  assert.equal("skip_unsubscribe" in payload.message, false);
});

test("test mode refuses every recipient outside the allowlist", async () => {
  let fetchCalled = false;
  const client = new UnisenderGoClient(emailConfig(), async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(
    () => client.send({ ...request, recipientEmail: "buyer@example.net" }),
    (error: unknown) => {
      assert.equal(error instanceof EmailProviderError, true);
      const providerError = error as EmailProviderError;
      assert.equal(providerError.code, "email_recipient_not_allowed");
      assert.equal(providerError.retryable, false);
      assert.equal(providerError.message.includes("buyer@example.net"), false);
      return true;
    },
  );
  assert.equal(fetchCalled, false);
});

test("non-production delivery requires test mode even with a configured key", async () => {
  const client = new UnisenderGoClient(
    emailConfig({ EMAIL_TEST_MODE: "false" }),
    async () => new Response("{}", { status: 200 }),
  );

  await assert.rejects(
    () => client.send(request),
    (error: unknown) =>
      error instanceof EmailProviderError &&
      error.code === "email_test_mode_required",
  );
});

test("disabled delivery fails before the network request", async () => {
  let fetchCalled = false;
  const client = new UnisenderGoClient(
    emailConfig({ EMAIL_ENABLED: "false" }),
    async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    },
  );

  await assert.rejects(
    () => client.send(request),
    (error: unknown) =>
      error instanceof EmailProviderError && error.code === "email_disabled",
  );
  assert.equal(fetchCalled, false);
});

test("HTTP and recipient failures are classified for bounded worker retries", async (t) => {
  const scenarios = [
    {
      name: "provider 503",
      response: new Response(JSON.stringify({ status: "error", code: 5000 }), {
        status: 503,
      }),
      kind: "temporary",
      code: undefined,
    },
    {
      name: "invalid sender",
      response: new Response(JSON.stringify({ status: "error", code: 1574 }), {
        status: 400,
      }),
      kind: "permanent",
      code: undefined,
    },
    {
      name: "rejected API key",
      response: new Response(JSON.stringify({ status: "error", code: 401 }), {
        status: 401,
      }),
      kind: "permanent",
      code: "email_provider_auth_rejected",
    },
    {
      name: "duplicate idempotence key",
      response: new Response(JSON.stringify({ status: "error", code: 1573 }), {
        status: 400,
      }),
      kind: "duplicate",
      code: undefined,
    },
    {
      name: "temporarily unavailable recipient",
      response: new Response(
        JSON.stringify({
          status: "success",
          job_id: "job-id",
          failed_emails: { "owner@example.com": "temporary_unavailable" },
        }),
        { status: 200 },
      ),
      kind: "temporary",
      code: undefined,
    },
    {
      name: "unsubscribed recipient",
      response: new Response(
        JSON.stringify({
          status: "success",
          job_id: "job-id",
          failed_emails: { "owner@example.com": "unsubscribed" },
        }),
        { status: 200 },
      ),
      kind: "permanent",
      code: undefined,
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const client = new UnisenderGoClient(
        emailConfig(),
        async () => scenario.response.clone(),
      );
      await assert.rejects(
        () => client.send(request),
        (error: unknown) =>
          error instanceof EmailProviderError &&
          error.kind === scenario.kind &&
          (scenario.code === undefined || error.code === scenario.code),
      );
    });
  }
});

test("email masking keeps diagnostics useful without exposing the address", () => {
  const masked = maskEmail("buyer@example.com");
  assert.equal(masked, "b***@e***.com");
  assert.equal(masked.includes("buyer@example.com"), false);
});
