export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: unknown;
};

export type ErrorDiagnostic = {
  code: string | null;
  message: string;
};

/**
 * Preserve the useful part of nested fetch/undici failures without exposing
 * request payloads or credentials. Node's top-level error is often only
 * "fetch failed", while the actionable TLS/network code lives in `cause`.
 */
export function errorDiagnostic(error: unknown): ErrorDiagnostic {
  const messages: string[] = [];
  let code: string | null = null;
  let current: unknown = error;
  const visited = new Set<unknown>();

  for (let depth = 0; depth < 6 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (current instanceof Error) {
      const item = current as ErrorWithCause;
      const message = item.message.trim();
      if (message && !messages.includes(message)) messages.push(message);
      if (!code && typeof item.code === "string" && item.code.trim()) {
        code = item.code.trim().slice(0, 120);
      }
      current = item.cause;
      continue;
    }
    if (typeof current === "object") {
      const item = current as { cause?: unknown; code?: unknown; message?: unknown };
      if (typeof item.message === "string") {
        const message = item.message.trim();
        if (message && !messages.includes(message)) messages.push(message);
      }
      if (!code && typeof item.code === "string" && item.code.trim()) {
        code = item.code.trim().slice(0, 120);
      }
      current = item.cause;
      continue;
    }
    const message = String(current).trim();
    if (message && !messages.includes(message)) messages.push(message);
    break;
  }

  return {
    code,
    message: (messages.join(": ") || "Unknown error").slice(0, 500),
  };
}
