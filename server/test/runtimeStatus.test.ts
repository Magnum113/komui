import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { loadConfig, publicConfig } from "../src/config";
import { handleRuntimeRead } from "../src/runtimeStatus";

test("runtime config supports only self-hosted environments", () => {
  const staging = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
  });
  const production = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_production",
    RUNTIME_MODE: "server",
  });

  assert.equal(staging.RUNTIME_MODE, "staging");
  assert.equal(production.RUNTIME_MODE, "server");
  assert.equal(publicConfig(production).runtimeMode, "server");
  assert.throws(() =>
    loadConfig({
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_production",
      RUNTIME_MODE: "legacy",
    }),
  );
});

test("runtime status reports a permanent self-hosted runtime to legacy admin clients", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_production",
    RUNTIME_MODE: "server",
    AUDIT_LOG_PATH: "/dev/null",
  });
  const status = await handleRuntimeRead(
    {
      ip: "127.0.0.1",
      headers: {},
    } as FastifyRequest,
    {} as never,
    config,
  );

  assert.equal(status.runtimeMode, "server");
  assert.equal(status.legacyFallbackConfigured, false);
  assert.equal(status.trafficSwitchEnabled, false);
  assert.equal(status.trafficSwitch.currentMode, "server");
  assert.equal(status.trafficSwitch.productionVhostEnabled, true);
  assert.equal(status.trafficSwitch.legacyOriginConfigured, false);
  assert.equal(status.trafficSwitch.state, "retired");
});
