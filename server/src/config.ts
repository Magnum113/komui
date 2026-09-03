import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(6),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(30_000)
    .default(3_000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(10_000)
    .default(2_000),
  ADMIN_API_TOKEN: z.string().min(24).optional(),
  RUNTIME_MODE: z.enum(["staging", "server"]).default("staging"),
  AUDIT_LOG_PATH: z.string().min(1).default("/var/lib/komui/admin-audit.log"),
  SITE_URL: z.string().url().default("https://komui.ru"),
  PUBLIC_API_BASE_URL: z.string().url().optional(),
  yandexMapsApiKey: z.string().min(1).optional(),
  YANDEX_MAPS_API_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_YANDEX_MAPS_API_KEY: z.string().min(1).optional(),
  TBANK_MODE: z.enum(["demo", "production"]).default("demo"),
  TBANK_DEMO_TERMINAL_KEY: z.string().min(1).optional(),
  TBANK_DEMO_PASSWORD: z.string().min(1).optional(),
  TBANK_TERMINAL_KEY: z.string().min(1).optional(),
  TBANK_PASSWORD: z.string().min(1).optional(),
  TBANK_API_URL: z.string().url().default("https://securepay.tinkoff.ru/v2"),
  TBANK_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(15_000),
  TBANK_RECONCILIATION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  TBANK_RECONCILIATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(300_000)
    .default(30_000),
  TBANK_RECONCILIATION_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(25)
    .default(5),
  TBANK_RECONCILIATION_STALE_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .default(30_000),
  TBANK_RECONCILIATION_LEASE_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .default(60_000),
  TBANK_RECONCILIATION_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20),
  TBANK_TAXATION: z.string().min(1).optional(),
  TBANK_TAX: z.string().min(1).optional(),
  TBANK_MOCK_PAYMENTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CDEK_LOGIN: z.string().min(1).optional(),
  CDEK_PASSWORD: z.string().min(1).optional(),
  CDEK_CLIENT_ID: z.string().min(1).optional(),
  CDEK_CLIENT_SECRET: z.string().min(1).optional(),
  CDEK_API_BASE_URL: z.string().url().default("https://api.cdek.ru"),
  CDEK_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(8_000),
  CDEK_MOCK: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CDEK_CREATE_SHIPMENTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CDEK_SHIPMENT_POINT: z.string().min(1).default("MKHCH20"),
  CDEK_SHIPMENT_CITY: z.string().min(1).default("Махачкала"),
  CDEK_SHIPMENT_CITY_CODE: z.string().optional(),
  CDEK_SHIPMENT_ADDRESS: z.string().min(1).default("ул. Сурикова, 77"),
  CDEK_SENDER_NAME: z.string().min(1).default("Komui"),
  CDEK_SENDER_PHONE: z.string().min(1).default("+79995330015"),
  CDEK_TARIFF_CODE: z.string().optional(),
  CDEK_DELIVERY_MODES: z.string().default("4"),
  CDEK_PACKING_HEIGHT_EXTRA_CM: z.coerce
    .number()
    .int()
    .min(0)
    .max(50)
    .default(1),
  OZON_IMPORT_ENV_FILE: z.string().min(1).default("/etc/komui/ozon-sync.env"),
  OZON_IMPORT_MAX_ITEMS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(2_000),
  EMAIL_PROVIDER: z.enum(["unisender_go"]).default("unisender_go"),
  EMAIL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  EMAIL_WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  EMAIL_WORKER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(10_000),
  EMAIL_WORKER_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),
  EMAIL_WORKER_LEASE_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(900_000)
    .default(120_000),
  EMAIL_WORKER_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(4),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().trim().min(1).max(100).default("KOMUI"),
  EMAIL_REPLY_TO: z.string().email().optional(),
  EMAIL_TEST_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  EMAIL_ALLOWED_RECIPIENTS: z.string().default(""),
  EMAIL_SUBJECT_PREFIX: z.string().trim().max(40).default(""),
  UNISENDER_GO_API_URL: z
    .string()
    .url()
    .startsWith("https://")
    .default("https://goapi.unisender.ru/ru/transactional/api/v1"),
  UNISENDER_GO_API_KEY: z.string().min(16).optional(),
  UNISENDER_GO_WEBHOOK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  UNISENDER_GO_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(10_000),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}

export function publicConfig(config: AppConfig) {
  return {
    nodeEnv: config.NODE_ENV,
    host: config.HOST,
    port: config.PORT,
    databasePoolMax: config.DATABASE_POOL_MAX,
    runtimeMode: config.RUNTIME_MODE,
    adminEnabled: Boolean(config.ADMIN_API_TOKEN),
    siteUrl: config.SITE_URL,
    publicApiBaseUrlConfigured: Boolean(config.PUBLIC_API_BASE_URL),
    yandexMapsConfigured: Boolean(yandexMapsApiKey(config)),
    tbankMode: config.TBANK_MODE,
    tbankConfigured: Boolean(
      config.TBANK_MODE === "production"
        ? config.TBANK_TERMINAL_KEY && config.TBANK_PASSWORD
        : config.TBANK_DEMO_TERMINAL_KEY && config.TBANK_DEMO_PASSWORD,
    ),
    tbankMockPayments: config.TBANK_MOCK_PAYMENTS,
    cdekConfigured: Boolean(
      (config.CDEK_LOGIN || config.CDEK_CLIENT_ID) &&
        (config.CDEK_PASSWORD || config.CDEK_CLIENT_SECRET),
    ),
    cdekMock: config.CDEK_MOCK,
    cdekCreateShipments: config.CDEK_CREATE_SHIPMENTS,
    ozonImportEnvFileConfigured: Boolean(config.OZON_IMPORT_ENV_FILE),
    emailProvider: config.EMAIL_PROVIDER,
    emailEnabled: config.EMAIL_ENABLED,
    emailWorkerEnabled: config.EMAIL_WORKER_ENABLED,
    emailConfigured: Boolean(
      config.EMAIL_FROM &&
        config.EMAIL_REPLY_TO &&
        config.UNISENDER_GO_API_KEY,
    ),
    emailTestMode: config.EMAIL_TEST_MODE,
    emailAllowlistConfigured: Boolean(
      config.EMAIL_ALLOWED_RECIPIENTS.trim(),
    ),
    emailWebhookEnabled: config.UNISENDER_GO_WEBHOOK_ENABLED,
    emailWebhookConfigured: Boolean(config.UNISENDER_GO_API_KEY),
  };
}

export function yandexMapsApiKey(config: AppConfig) {
  return (
    config.yandexMapsApiKey ||
    config.YANDEX_MAPS_API_KEY ||
    config.NEXT_PUBLIC_YANDEX_MAPS_API_KEY ||
    ""
  );
}
