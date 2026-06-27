import { appendFile } from "node:fs/promises";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config";

export async function auditAdminEvent(
  config: AppConfig,
  request: FastifyRequest,
  action: string,
  outcome: "allowed" | "denied" | "disabled",
  details: Record<string, unknown> = {},
) {
  const event = {
    ts: new Date().toISOString(),
    action,
    outcome,
    requestId: request.id,
    ip: request.ip,
    method: request.method,
    url: request.url,
    ...details,
  };

  await appendFile(config.AUDIT_LOG_PATH, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o640,
  });
}
