import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, publicConfig } from "../src/config";

test("loadConfig parses safe defaults and hides secrets in publicConfig", () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
    ADMIN_API_TOKEN: "x".repeat(32),
  });

  assert.equal(config.HOST, "127.0.0.1");
  assert.equal(config.PORT, 3000);
  assert.equal(config.DATABASE_POOL_MAX, 6);
  assert.equal(config.RUNTIME_MODE, "staging");

  const exposed = publicConfig(config);
  assert.equal("DATABASE_URL" in exposed, false);
  assert.equal(exposed.adminEnabled, true);
});

test("loadConfig rejects non-postgres DATABASE_URL", () => {
  assert.throws(() =>
    loadConfig({
      DATABASE_URL: "https://example.com/database",
    }),
  );
});
