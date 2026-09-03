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
import {
  CheckoutCartError,
  type CheckoutProductRow,
  resolveCartItems,
  text,
  validatedCart,
} from "../_shared/checkout.ts";

type ProductRow = CheckoutProductRow & {
  product_type_slug: string | null;
  category_slug: string | null;
};

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
        "id,name,price_min,is_active,sizes,offers,product_type_slug,category_slug,source_payload",
      )
      .in("id", productIds)
      .eq("is_active", true);
    if (productsError) throw productsError;

    const packageItems = resolveCartItems(
      cart,
      (products ?? []) as ProductRow[],
    ).map((item) => {
      const { cartItem, product } = item;
      const profile = cdekProfileForProduct(product);
      return {
        productId: product.id,
        offerId: item.offerId,
        sku: item.sku,
        productName: product.name,
        size: cartItem.size,
        quantity: cartItem.qty,
        unitPriceAmount: item.unitPriceAmount,
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
