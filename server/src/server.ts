import { buildApp } from "./app";
import { startCdekEffectWorker } from "./cdekEffects";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { startTbankInitReconciler } from "./tbankReconciliation";

async function main() {
  const config = loadConfig();
  const db = createDb(config);
  const app = buildApp({ config, db });
  let stopCdekEffectWorker: (() => Promise<void>) | null = null;
  let stopTbankInitReconciler: (() => Promise<void>) | null = null;

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutting down");
    await Promise.all([
      stopCdekEffectWorker?.(),
      stopTbankInitReconciler?.(),
    ]);
    await app.close();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
  stopCdekEffectWorker = startCdekEffectWorker({
    config,
    db,
    logger: app.log,
  });
  stopTbankInitReconciler = startTbankInitReconciler(config, db, app.log);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
