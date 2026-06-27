import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config";
import { readTrafficSwitchStatus } from "../src/runtimeSwitch";

test("readTrafficSwitchStatus returns idle defaults without status file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "komui-switch-"));
  try {
    const config = loadConfig({
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
      ADMIN_API_TOKEN: "x".repeat(32),
      TRAFFIC_SWITCH_STATE_DIR: dir,
      ENABLE_TRAFFIC_SWITCH: "true",
      LEGACY_ORIGIN: "https://komui-legacy.vercel.app",
    });

    const status = await readTrafficSwitchStatus(config);

    assert.equal(status.enabled, true);
    assert.equal(status.currentMode, "staging");
    assert.equal(status.state, "idle");
    assert.equal(status.legacyOriginConfigured, true);
    assert.equal(status.productionVhostEnabled, false);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("readTrafficSwitchStatus exposes last applied mode from status file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "komui-switch-"));
  try {
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify({
        requestId: "req-1",
        state: "prepared",
        mode: "legacy",
        target: "production",
        productionVhostEnabled: false,
        updatedAt: "2026-06-27T00:00:00.000Z",
      }),
    );
    const config = loadConfig({
      DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
      ADMIN_API_TOKEN: "x".repeat(32),
      TRAFFIC_SWITCH_STATE_DIR: dir,
      ENABLE_TRAFFIC_SWITCH: "true",
    });

    const status = await readTrafficSwitchStatus(config);

    assert.equal(status.currentMode, "legacy");
    assert.equal(status.state, "prepared");
    assert.equal(status.lastRequestId, "req-1");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
