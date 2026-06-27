import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { auditAdminEvent } from "./audit";
import type { AppConfig } from "./config";
import { HttpError } from "./errors";

const switchRequestSchema = z.object({
  mode: z.enum(["server", "legacy"]),
  confirm: z.literal(true),
  reason: z.string().trim().max(500).optional(),
  target: z.enum(["production"]).default("production"),
});

type SwitchMode = "server" | "legacy";

type SwitchStatus = {
  requestId?: string;
  state?: "idle" | "pending" | "prepared" | "applied" | "failed" | "rejected";
  mode?: SwitchMode;
  target?: "production";
  message?: string;
  productionVhostEnabled?: boolean;
  updatedAt?: string;
  appliedAt?: string;
  nginxTest?: "passed" | "failed" | "skipped";
  legacyOriginConfigured?: boolean;
  error?: string;
};

type SwitchRequest = {
  requestId: string;
  mode: SwitchMode;
  target: "production";
  requestedAt: string;
  reason?: string;
  requestedByIp?: string;
  requestedByRequestId?: string;
};

function statusPath(config: AppConfig) {
  return join(config.TRAFFIC_SWITCH_STATE_DIR, "status.json");
}

function requestPath(config: AppConfig) {
  return join(config.TRAFFIC_SWITCH_STATE_DIR, "request.json");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    return null;
  }
}

async function writeJsonAtomic(path: string, payload: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o640,
  });
  await rename(tmpPath, path);
}

export async function readTrafficSwitchStatus(config: AppConfig) {
  const status = await readJsonFile<SwitchStatus>(statusPath(config));
  return {
    enabled: config.ENABLE_TRAFFIC_SWITCH,
    target: "production",
    currentMode: status?.mode || config.RUNTIME_MODE,
    state: status?.state || "idle",
    legacyOriginConfigured: Boolean(config.LEGACY_ORIGIN),
    productionVhostEnabled: status?.productionVhostEnabled === true,
    message: status?.message,
    updatedAt: status?.updatedAt,
    appliedAt: status?.appliedAt,
    lastRequestId: status?.requestId,
    nginxTest: status?.nginxTest,
    error: status?.error,
    constraints: [
      "The admin switch affects komui.ru only after production DNS points to this server.",
      "Switching to legacy requires LEGACY_ORIGIN to be a fixed Vercel deployment domain, not komui.ru.",
      "If this server is unavailable, use manual DNS rollback.",
    ],
  };
}

export async function handleRuntimeRead(
  request: FastifyRequest,
  _reply: FastifyReply,
  config: AppConfig,
) {
  const trafficSwitch = await readTrafficSwitchStatus(config);
  await auditAdminEvent(config, request, "admin.runtime.read", "allowed");

  return {
    runtimeMode: config.RUNTIME_MODE,
    legacyFallbackConfigured: Boolean(config.LEGACY_ORIGIN),
    trafficSwitchEnabled: config.ENABLE_TRAFFIC_SWITCH,
    service: "komui-backend",
    trafficSwitch,
  };
}

export async function handleRuntimeFallbackSwitch(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
) {
  const parsed = switchRequestSchema.parse(request.body || {});

  if (!config.ENABLE_TRAFFIC_SWITCH) {
    await auditAdminEvent(config, request, "admin.runtime.fallback", "denied", {
      reason: "traffic_switch_disabled",
      requestedMode: parsed.mode,
    });
    throw new HttpError(
      503,
      "traffic_switch_disabled",
      "Traffic switch is disabled on this server",
    );
  }

  if (parsed.mode === "legacy" && !config.LEGACY_ORIGIN) {
    await auditAdminEvent(config, request, "admin.runtime.fallback", "denied", {
      reason: "legacy_origin_not_configured",
      requestedMode: parsed.mode,
    });
    throw new HttpError(
      503,
      "legacy_origin_not_configured",
      "LEGACY_ORIGIN is required before switching production traffic to legacy",
    );
  }

  const switchRequest: SwitchRequest = {
    requestId: randomUUID(),
    mode: parsed.mode,
    target: parsed.target,
    requestedAt: new Date().toISOString(),
    reason: parsed.reason,
    requestedByIp: request.ip,
    requestedByRequestId: request.id,
  };

  await writeJsonAtomic(requestPath(config), switchRequest);
  await auditAdminEvent(config, request, "admin.runtime.fallback", "allowed", {
    requestId: switchRequest.requestId,
    requestedMode: parsed.mode,
    outcome: "accepted_pending",
  });

  return reply.status(202).send({
    requestId: switchRequest.requestId,
    status: "pending",
    mode: parsed.mode,
    message: "Traffic switch request accepted; poll GET /admin/runtime for result",
    trafficSwitch: await readTrafficSwitchStatus(config),
  });
}
