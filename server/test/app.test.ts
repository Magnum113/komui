import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";

function mockDb(): Db {
  return {
    query: async () => ({ rows: [] }),
    withTransaction: async (callback) =>
      callback({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      } as never),
    ping: async () => ({ ok: 1, database_name: "komui_test" }),
    close: async () => undefined,
  } as unknown as Db;
}

test("delivery config exposes configured Yandex Maps browser key", async () => {
  const app = buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
      YANDEX_MAPS_API_KEY: "public-map-key",
    }),
    db: mockDb(),
  });

  const response = await app.inject({
    method: "GET",
    url: "/delivery-config",
  });

  assert.equal(response.statusCode, 200);
  assert.match(
    response.headers["content-type"]?.toString() || "",
    /application\/javascript/,
  );
  assert.equal(response.headers["cache-control"], "public, max-age=300, s-maxage=300");
  assert.match(response.body, /window\.KOMUI_DELIVERY/);
  assert.match(response.body, /public-map-key/);

  await app.close();
});
