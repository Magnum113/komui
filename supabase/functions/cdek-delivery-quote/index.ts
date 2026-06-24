import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  errorMessage,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import {
  buildCdekPackages,
  cdekProfileForProduct,
  quoteCdekDelivery,
} from "../_shared/cdek.ts";

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
  offers: Array<Record<string, unknown>>;
  product_type_slug: string | null;
  category_slug: string | null;
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

function offerForSize(
  product: ProductRow,
  size: string,
): Record<string, unknown> | null {
  return (product.offers ?? []).find((offer) =>
    String(offer.size ?? "").toUpperCase() === size
  ) ?? null;
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
    const delivery = (body.delivery ?? {}) as Record<string, unknown>;
    const deliveryPointCode = text(delivery.code, 40);
    const deliveryCityCode = Number(delivery.cityCode);
    if (!deliveryPointCode || !Number.isInteger(deliveryCityCode)) {
      throw new Error("Выберите пункт выдачи CDEK");
    }

    const cart = validatedCart(body.items);
    const admin = createAdminClient();
    const productIds = [...new Set(cart.map((item) => item.id))];
    const { data: products, error: productsError } = await admin
      .from("merch_storefront_products")
      .select(
        "id,name,price_min,is_active,sizes,offers,product_type_slug,category_slug",
      )
      .in("id", productIds)
      .eq("is_active", true);
    if (productsError) throw productsError;

    const productMap = new Map(
      ((products ?? []) as ProductRow[]).map((product) => [product.id, product]),
    );
    const packageItems = cart.map((cartItem) => {
      const product = productMap.get(cartItem.id);
      if (!product) throw new Error("Один из товаров больше недоступен");
      if (!(product.sizes ?? []).map(String).includes(cartItem.size)) {
        throw new Error(`Размер ${cartItem.size} товара «${product.name}» недоступен`);
      }

      const priceRub = Number(product.price_min);
      if (!Number.isFinite(priceRub) || priceRub <= 0) {
        throw new Error(`Для товара «${product.name}» не задана цена`);
      }

      const offer = offerForSize(product, cartItem.size);
      const profile = cdekProfileForProduct(product);
      return {
        productId: product.id,
        offerId: offer ? text(offer.offer_id, 120) || null : null,
        sku: offer ? text(offer.sku, 120) || null : null,
        productName: product.name,
        size: cartItem.size,
        quantity: cartItem.qty,
        unitPriceAmount: Math.round(priceRub * 100),
        productTypeSlug: product.product_type_slug,
        categorySlug: product.category_slug,
        profileKey: profile.key,
      };
    });

    const packages = buildCdekPackages("quote", packageItems);
    const quote = await quoteCdekDelivery({
      deliveryCityCode,
      packages,
    });

    return jsonResponse({
      provider: "cdek",
      deliveryPointCode,
      amount: quote.amountKopecks,
      amountRub: quote.amount,
      currency: "RUB",
      eta: quote.eta,
      tariffCode: quote.tariffCode,
      tariffName: quote.tariffName,
      deliveryMode: quote.deliveryMode,
      packages,
    }, 200, cors);
  } catch (error) {
    console.error("cdek-delivery-quote", error);
    return jsonResponse({ error: errorMessage(error) }, 400, cors);
  }
});
