/** Operational read-only provider check; --warm-points only fills the local point cache. */
import { loadConfig } from "./config";
import { createDb } from "./db";
import {
  ozonClient,
  ozonCacheReady,
  refreshOzonPointsPage,
} from "./ozonDelivery";
async function main() {
  const config = loadConfig();
  const client = ozonClient(config);
  const methods = await client.call<{
    shipment_methods: Array<{
      shipment_method_id: number;
      status: string;
      name: string;
      full_address?: string;
    }>;
  }>("/v1/shipment-method/info", {
    shipment_method_ids: [config.OZON_DELIVERY_SHIPMENT_METHOD_ID],
  });
  const method = methods.shipment_methods.find(
    (m) => m.shipment_method_id === config.OZON_DELIVERY_SHIPMENT_METHOD_ID,
  );
  console.log(
    JSON.stringify({
      authenticated: true,
      method: method
        ? {
            id: method.shipment_method_id,
            status: method.status,
            name: method.name,
            address: method.full_address,
          }
        : null,
    }),
  );
  if (!method || method.status !== "active")
    throw new Error("Configured shipment method is not active");
  if (process.argv.includes("--warm-points")) {
    const db = createDb(config);
    try {
      for (let page = 0; page < 3000; page++) {
        await refreshOzonPointsPage(db, config);
        if (page % 20 === 0)
          console.log(JSON.stringify({ pagesProcessed: page + 1 }));
        if (await ozonCacheReady(db, config)) {
          console.log(JSON.stringify({ pointsReady: true }));
          return;
        }
      }
      throw new Error("Point cache scan limit reached");
    } finally {
      await db.close();
    }
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Readiness check failed",
    }),
  );
  process.exitCode = 1;
});
