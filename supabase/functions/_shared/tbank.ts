export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function scalarString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export async function createTbankToken(
  payload: Record<string, unknown>,
  password: string,
): Promise<string> {
  const values = Object.entries(payload)
    .filter(([key, value]) =>
      key !== "Token" &&
      value !== null &&
      value !== undefined &&
      typeof value !== "object"
    )
    .concat([["Password", password]])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => scalarString(value))
    .join("");

  return await sha256Hex(values);
}

export function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left.toLowerCase());
  const b = new TextEncoder().encode(right.toLowerCase());
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

export async function parseTbankBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const text = await request.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

export function sanitizedTbankPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { Token: _token, ...safePayload } = payload;
  return safePayload;
}

export function tbankConfig() {
  const terminalKey = Deno.env.get("TBANK_DEMO_TERMINAL_KEY");
  const password = Deno.env.get("TBANK_DEMO_PASSWORD");
  if (!terminalKey || !password) {
    throw new Error(
      "TBANK_DEMO_TERMINAL_KEY and TBANK_DEMO_PASSWORD must be configured",
    );
  }

  return {
    terminalKey,
    password,
    apiUrl: Deno.env.get("TBANK_API_URL") ??
      "https://securepay.tinkoff.ru/v2",
  };
}
