import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  errorMessage,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { validatePromoCode } from "../_shared/promo.ts";

type CartItemInput = {
  id: string;
  size: string;
  qty: number;
};

type ProductRow = {
  id: string;
  name: string;
  price_min: number | string | null;
  is_active: boolean;
  sizes: string[];
};

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function validatedCart(value: unknown): CartItemInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error("Корзина пуста или содержит слишком много позиций");
  }

  const items = value.map((item) => {
    const raw = item as Record<string, unknown>;
    const id = text(raw.id, 36);
    const size = text(raw.size, 12).toUpperCase();
    const qty = Number(raw.qty);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(id) ||
      !size ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 10
    ) {
      throw new Error("В корзине есть некорректная позиция");
    }
    return { id, size, qty };
  });

  const units = items.reduce((sum, item) => sum + item.qty, 0);
  if (units > 50) throw new Error("В одном заказе может быть не более 50 вещей");
  return items;
}

async function subtotalFromCart(
  admin: ReturnType<typeof createAdminClient>,
  cart: CartItemInput[],
): Promise<number> {
  const productIds = [...new Set(cart.map((item) => item.id))];
  const { data: products, error } = await admin
    .from("merch_storefront_products")
    .select("id,name,price_min,is_active,sizes")
    .in("id", productIds)
    .eq("is_active", true);
  if (error) throw error;

  const productMap = new Map(
    ((products ?? []) as ProductRow[]).map((product) => [product.id, product]),
  );

  return cart.reduce((sum, item) => {
    const product = productMap.get(item.id);
    if (!product) throw new Error("Один из товаров больше недоступен");
    if (!(product.sizes ?? []).map(String).includes(item.size)) {
      throw new Error(`Размер ${item.size} товара «${product.name}» недоступен`);
    }
    const priceRub = Number(product.price_min);
    if (!Number.isFinite(priceRub) || priceRub <= 0) {
      throw new Error(`Для товара «${product.name}» не задана цена`);
    }
    return sum + Math.round(priceRub * 100) * item.qty;
  }, 0);
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
    return jsonResponse({ error: errorMessage(error) }, 400, cors);
  }
});
