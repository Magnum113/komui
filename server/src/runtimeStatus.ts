import type { FastifyReply, FastifyRequest } from "fastify";
import { auditAdminEvent } from "./audit";
import type { AppConfig } from "./config";

export async function handleRuntimeRead(
  request: FastifyRequest,
  _reply: FastifyReply,
  config: AppConfig,
) {
  await auditAdminEvent(config, request, "admin.runtime.read", "allowed");

  return {
    runtimeMode: config.RUNTIME_MODE,
    service: "komui-backend",
    legacyFallbackConfigured: false,
    trafficSwitchEnabled: false,
    // Static compatibility shape for the currently deployed GetoMerch admin.
    // There is no switch implementation behind it; mutation route is absent.
    trafficSwitch: {
      enabled: false,
      target: config.RUNTIME_MODE,
      currentMode: config.RUNTIME_MODE,
      state: "retired",
      legacyOriginConfigured: false,
      productionVhostEnabled: true,
      message: "Self-hosted runtime is permanent; hosted fallback is retired.",
      constraints: ["Hosted fallback cannot be enabled through this API."],
    },
  };
}
