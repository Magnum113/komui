import { loadConfig } from "./config";
import { createDb } from "./db";
import {
  emailWorkerConfigurationError,
  startEmailOutboxWorker,
} from "./email/outboxWorker";

function writeLog(
  level: "info" | "warn" | "error",
  values: Record<string, unknown>,
  message: string,
) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: "komui-email-worker",
    message,
    ...values,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

async function main() {
  const config = loadConfig();
  if (!config.EMAIL_WORKER_ENABLED) {
    writeLog("info", {}, "Email worker is disabled by configuration");
    return;
  }
  const configurationError = emailWorkerConfigurationError(config);
  if (configurationError) throw new Error(configurationError);

  const db = createDb(config);
  const logger = {
    info: (values: Record<string, unknown>, message: string) =>
      writeLog("info", values, message),
    warn: (values: Record<string, unknown>, message: string) =>
      writeLog("warn", values, message),
    error: (values: Record<string, unknown>, message: string) =>
      writeLog("error", values, message),
  };
  const stopWorker = startEmailOutboxWorker({ config, db, logger });

  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  writeLog("info", {}, "Email worker is shutting down");
  await stopWorker();
  await db.close();
}

main().catch((error) => {
  writeLog(
    "error",
    { error: error instanceof Error ? error.message : "unknown_error" },
    "Email worker failed",
  );
  process.exit(1);
});
