export const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
};

const defaultOrigins = [
  "https://komui.ru",
  "https://www.komui.ru",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

export function allowedOrigins(): Set<string> {
  const configured = (Deno.env.get("SITE_URL") ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);

  return new Set([...defaultOrigins, ...configured]);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const normalized = origin?.replace(/\/$/, "") ?? "";
  const allowed = allowedOrigins();
  return {
    "Access-Control-Allow-Origin": allowed.has(normalized)
      ? normalized
      : "https://komui.ru",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return allowedOrigins().has(origin.replace(/\/$/, ""));
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
