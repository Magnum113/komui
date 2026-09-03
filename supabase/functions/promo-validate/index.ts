import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  errorMessage,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { validatePromoCode } from "../_shared/promo.ts";
import {
  type CartItemInput,
  CheckoutCartError,
  type CheckoutProductRow,
  resolveCartItems,
  validatedCart,
} from "../_shared/checkout.ts";

async function subtotalFromCart(
  admin: ReturnType<typeof createAdminClient>,
  cart: CartItemInput[],
): Promise<number> {
  const productIds = [...new Set(cart.map((item) => item.id))];
  const { data: products, error } = await admin
    .from("merch_storefront_products")
    .select("id,name,price_min,is_active,sizes,offers,source_payload")
    .in("id", productIds)
    .eq("is_active", true);
  if (error) throw error;

  return resolveCartItems(
    cart,
    (products ?? []) as CheckoutProductRow[],
  ).reduce((sum, item) => sum + item.lineTotalAmount, 0);
}

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
    const cart = validatedCart(body.items);
    const admin = createAdminClient();
    const subtotalAmount = await subtotalFromCart(admin, cart);
    const delivery = (body.delivery ?? {}) as Record<string, unknown>;
    const deliveryAmount = Math.max(0, Math.round(Number(delivery.amount) || 0));
    const validation = await validatePromoCode(admin, {
      code: body.promoCode,
      subtotalAmount,
      deliveryAmount,
    });

    return jsonResponse({
      ...validation,
      subtotalAmount,
      deliveryAmount,
      totalAmount: subtotalAmount - validation.discountAmount +
        validation.chargedDeliveryAmount,
    }, 200, cors);
  } catch (error) {
    console.error("promo-validate", error);
    return jsonResponse(
      {
        error: errorMessage(error),
        ...(error instanceof CheckoutCartError ? { code: error.code } : {}),
      },
      error instanceof CheckoutCartError ? error.status : 400,
      cors,
    );
  }
});
