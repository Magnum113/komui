import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  errorMessage,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { safeEqual, sha256Hex } from "../_shared/tbank.ts";

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }
  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ error: "Origin is not allowed" }, 403, cors);
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const orderNumber = String(body.orderNumber ?? "").trim().slice(0, 36);
    const accessToken = String(body.accessToken ?? "").trim().slice(0, 128);
    if (!orderNumber || !/^[A-Za-z0-9_-]{32,128}$/.test(accessToken)) {
      return jsonResponse({ error: "Invalid request" }, 400, cors);
    }

    const admin = createAdminClient();
    const { data: order } = await admin
      .from("merch_customer_orders")
      .select(
        "id,order_number,access_token_hash,status,total_amount,currency,delivery_point_code,created_at,paid_at",
      )
      .eq("order_number", orderNumber)
      .maybeSingle();
    if (!order) return jsonResponse({ error: "Order not found" }, 404, cors);

    const tokenHash = await sha256Hex(accessToken);
    if (!safeEqual(tokenHash, order.access_token_hash)) {
      return jsonResponse({ error: "Order not found" }, 404, cors);
    }

    const { data: attempt } = await admin
      .from("merch_payment_attempts")
      .select("provider_status,error_code,error_message,updated_at")
      .eq("order_id", order.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return jsonResponse({
      orderNumber: order.order_number,
      status: order.status,
      providerStatus: attempt?.provider_status ?? null,
      amount: order.total_amount,
      currency: order.currency,
      deliveryPointCode: order.delivery_point_code,
      createdAt: order.created_at,
      paidAt: order.paid_at,
      errorCode: attempt?.error_code ?? null,
      errorMessage: attempt?.error_message ?? null,
    }, 200, cors);
  } catch (error) {
    console.error("tbank-payment-status", error);
    return jsonResponse({ error: errorMessage(error) }, 400, cors);
  }
});
