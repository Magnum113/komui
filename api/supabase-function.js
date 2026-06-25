const ALLOWED_FUNCTIONS = new Set([
  "cdek-delivery-points",
  "cdek-delivery-quote",
  "promo-validate",
  "tbank-create-payment",
  "tbank-payment-status",
]);

const SUPABASE_FUNCTIONS_URL =
  "https://bkxpzfnglihxpbnhtjjq.supabase.co/functions/v1";
const MAX_BODY_BYTES = 64_000;
const UPSTREAM_TIMEOUT_MS = 25_000;

function json(response, status, body) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.status(status).send(JSON.stringify(body));
}

module.exports = async function supabaseFunction(request, response) {
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "POST, OPTIONS");
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, OPTIONS");
    json(response, 405, { error: "Method not allowed" });
    return;
  }

  const functionName = String(request.query?.name || "").trim();
  if (!ALLOWED_FUNCTIONS.has(functionName)) {
    json(response, 404, { error: "Function not found" });
    return;
  }

  const apiKey = String(request.headers.apikey || "").trim();
  if (!apiKey.startsWith("sb_publishable_") || apiKey.length > 256) {
    json(response, 401, { error: "Missing or invalid API key" });
    return;
  }

  const requestBody = typeof request.body === "string"
    ? request.body
    : JSON.stringify(request.body ?? {});
  if (Buffer.byteLength(requestBody, "utf8") > MAX_BODY_BYTES) {
    json(response, 413, { error: "Request is too large" });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(
      `${SUPABASE_FUNCTIONS_URL}/${functionName}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: apiKey,
          Authorization: String(request.headers.authorization || `Bearer ${apiKey}`),
          Origin: "https://komui.ru",
        },
        body: requestBody,
        signal: controller.signal,
      },
    );
    const body = await upstream.text();

    response.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/json; charset=utf-8",
    );
    response.setHeader("Cache-Control", "no-store");
    response.status(upstream.status).send(body);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.error("supabase-function proxy", functionName, error);
    json(response, timedOut ? 504 : 502, {
      error: timedOut
        ? "Сервис не ответил вовремя. Попробуйте ещё раз"
        : "Не удалось связаться с сервисом. Попробуйте ещё раз",
    });
  } finally {
    clearTimeout(timeout);
  }
};
