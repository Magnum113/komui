import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { createDb, type Db } from "./db";
import {
  allowedEmailRecipients,
  maskEmail,
  normalizeRecipientEmail,
} from "./email/unisenderGo";

type AcceptanceDb = Pick<Db, "query">;

type AcceptanceRow = QueryResultRow & {
  id: string;
  status: string;
};

export async function enqueueStageOrderPaidAcceptance(
  config: AppConfig,
  db: AcceptanceDb,
  recipient: string,
  acceptanceId = randomUUID(),
) {
  if (config.NODE_ENV !== "staging") {
    throw new Error("Email acceptance command is restricted to staging");
  }
  if (
    !config.EMAIL_ENABLED ||
    !config.EMAIL_WORKER_ENABLED ||
    !config.EMAIL_TEST_MODE
  ) {
    throw new Error("Staging email delivery and test mode must be enabled");
  }

  const normalizedRecipient = normalizeRecipientEmail(recipient);
  if (!allowedEmailRecipients(config).has(normalizedRecipient)) {
    throw new Error("Acceptance recipient is not in the staging allowlist");
  }

  const safeAcceptanceId = acceptanceId.trim().toLowerCase();
  if (!/^[a-z0-9-]{8,80}$/.test(safeAcceptanceId)) {
    throw new Error("Acceptance id is invalid");
  }
  const orderNumber = `STAGE-EMAIL-${safeAcceptanceId.slice(0, 8).toUpperCase()}`;
  const idempotencyKey = `stage-acceptance:order-paid:${safeAcceptanceId}`;
  const result = await db.query<AcceptanceRow>(
    `
      insert into public.merch_email_outbox (
        order_id,
        event_type,
        message_class,
        recipient_email,
        template_key,
        payload,
        status,
        scheduled_at,
        idempotency_key
      ) values (
        null,
        'order_paid',
        'transactional',
        $1,
        'order_paid',
        $2::jsonb,
        'pending',
        now(),
        $3
      )
      on conflict (idempotency_key) do update
      set idempotency_key = excluded.idempotency_key
      returning id, status
    `,
    [
      normalizedRecipient,
      JSON.stringify({
        schemaVersion: 1,
        customerFirstName: "Клиент",
        orderNumber,
        items: [
          {
            name: "Тестовое письмо KOMUI",
            size: null,
            quantity: 1,
            lineTotalAmount: 1_000,
          },
        ],
        subtotalAmount: 1_000,
        discountAmount: 0,
        deliveryAmount: 0,
        totalAmount: 1_000,
        currency: "RUB",
        deliveryCity: "Тестовый контур",
        deliveryAddress: "Отправление не создаётся",
        deliveryEta: null,
      }),
      idempotencyKey,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Acceptance email was not queued");
  return {
    outboxId: row.id,
    status: row.status,
    recipient: maskEmail(normalizedRecipient),
    orderNumber,
  };
}

async function main() {
  const recipient = process.argv[2]?.trim();
  if (!recipient || process.argv.length !== 3) {
    throw new Error("Usage: emailStageAcceptance.js <allowlisted-email>");
  }
  const config = loadConfig();
  const db = createDb(config);
  try {
    const result = await enqueueStageOrderPaidAcceptance(
      config,
      db,
      recipient,
    );
    console.info(JSON.stringify(result));
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    process.exit(1);
  });
}
