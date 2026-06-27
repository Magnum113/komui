import { createHash, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scalarString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function createTbankToken(
  payload: Record<string, unknown>,
  password: string,
): string {
  const values = Object.entries(payload)
    .filter(
      ([key, value]) =>
        key !== "Token" &&
        value !== null &&
        value !== undefined &&
        typeof value !== "object",
    )
    .concat([["Password", password]])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => scalarString(value))
    .join("");

  return sha256Hex(values);
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase(), "utf8");
  const b = Buffer.from(right.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sanitizedTbankPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { Token: _token, ...safePayload } = payload;
  return safePayload;
}
