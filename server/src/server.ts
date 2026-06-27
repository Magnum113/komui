import { buildApp } from "./app";
import { loadConfig } from "./config";

async function main() {
  const config = loadConfig();
  const app = buildApp({ config });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
