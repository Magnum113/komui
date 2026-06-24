import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  errorMessage,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import {
  createTbankToken,
  sanitizedTbankPayload,
  sha256Hex,
  tbankConfig,
} from "../_shared/tbank.ts";

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
  main_image_path: string | null;
  primary_image_url: string | null;
};

type OrderItem = {
  product_id: string;
  offer_id: string | null;
  sku: string | null;
  product_name: string;
  size: string;
  quantity: number;
  unit_price_amount: number;
  line_total_amount: number;
  image_url: string | null;
  product_snapshot: Record<string, unknown>;
};

const deliveryPoints = new Map([
  ["MSK214", {
    code: "MSK214",
    city: "Москва",
    address: "Тверская улица, 12с8",
    hours: "Пн–Вс, 10:00–21:00",
    eta: "1–2 дня",
    amount: 39000,
  }],
  ["MSK1177", {
    code: "MSK1177",
    city: "Москва",
    address: "улица Арбат, 19",
    hours: "Пн–Вс, 09:00–21:00",
    eta: "1–3 дня",
    amount: 42000,
  }],
  ["MSK565", {
    code: "MSK565",
    city: "Москва",
    address: "Кожевническая улица, 7с1",
    hours: "Пн–Пт, 09:00–20:00",
    eta: "1–2 дня",
    amount: 36000,
  }],
  ["MSK1924", {
    code: "MSK1924",
    city: "Москва",
    address: "Бакунинская улица, 14с1",
    hours: "Пн–Вс, 10:00–20:00",
    eta: "2–3 дня",
    amount: 39000,
  }],
  ["MSK130", {
    code: "MSK130",
    city: "Москва",
    address: "Брянская улица, 2",
    hours: "Пн–Вс, 09:00–21:00",
    eta: "1–2 дня",
    amount: 41000,
  }],
]);

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizePhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  const normalized = digits.startsWith("8")
    ? `7${digits.slice(1)}`
    : digits;
  if (!/^7\d{10}$/.test(normalized)) {
    throw new Error("Введите корректный российский номер телефона");
  }
  return `+${normalized}`;
}

function randomBase64Url(bytesLength = 18): string {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function orderNumber(): string {
  const date = new Date();
  const stamp = [
    String(date.getUTCFullYear()).slice(-2),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
  return `KOM-${stamp}-${randomBase64Url(5).toUpperCase()}`;
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

function buildReceipt(
  items: OrderItem[],
  discountAmount: number,
  delivery: { amount: number },
  phone: string,
): Record<string, unknown> | undefined {
  const taxation = Deno.env.get("TBANK_TAXATION");
  const tax = Deno.env.get("TBANK_TAX");
  if (!taxation || !tax) return undefined;

  const units = items.flatMap((item) =>
    Array.from({ length: item.quantity }, () => ({
      name: `${item.product_name} · ${item.size}`.slice(0, 128),
      amount: item.unit_price_amount,
      object: "commodity",
    }))
  );

  let remainingDiscount = discountAmount;
  let remainingBase = units.reduce((sum, unit) => sum + unit.amount, 0);
  const receiptItems = units.map((unit, index) => {
    const isLast = index === units.length - 1;
    const unitDiscount = isLast
      ? remainingDiscount
      : Math.min(
        remainingDiscount,
        Math.round((remainingDiscount * unit.amount) / remainingBase),
      );
    const amount = unit.amount - unitDiscount;
    remainingDiscount -= unitDiscount;
    remainingBase -= unit.amount;
    return {
      Name: unit.name,
      Price: amount,
      Quantity: 1,
      Amount: amount,
      PaymentMethod: "full_prepayment",
      PaymentObject: unit.object,
      Tax: tax,
    };
  });

  if (delivery.amount > 0) {
    receiptItems.push({
      Name: "Доставка СДЭК",
      Price: delivery.amount,
      Quantity: 1,
      Amount: delivery.amount,
      PaymentMethod: "full_prepayment",
      PaymentObject: "service",
      Tax: tax,
    });
  }

  return {
    Phone: phone,
    Taxation: taxation,
    Items: receiptItems,
  };
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
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 64_000) {
      return jsonResponse({ error: "Request is too large" }, 413, cors);
    }

    const body = await request.json() as Record<string, unknown>;
    const customer = (body.customer ?? {}) as Record<string, unknown>;
    const deliveryInput = (body.delivery ?? {}) as Record<string, unknown>;
    const cart = validatedCart(body.items);
    const firstName = text(customer.firstName, 80);
    const lastName = text(customer.lastName, 80);
    const phone = normalizePhone(customer.phone);
    const legalConsent = customer.legalConsent === true;
    const marketingConsent = customer.marketingConsent === true;
    const clientRequestId = text(body.clientRequestId, 36);
    const accessToken = text(body.accessToken, 128);

    if (firstName.length < 2 || lastName.length < 2) {
      throw new Error("Укажите имя и фамилию получателя");
    }
    if (!legalConsent) {
      throw new Error("Необходимо принять оферту и согласие на обработку данных");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(clientRequestId) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(accessToken)
    ) {
      throw new Error("Не удалось создать безопасный идентификатор заказа");
    }

    const delivery = deliveryPoints.get(text(deliveryInput.code, 24));
    if (!delivery) {
      throw new Error("Выберите доступный пункт выдачи СДЭК");
    }

    const { terminalKey, password, apiUrl } = tbankConfig();
    const admin = createAdminClient();
    const accessTokenHash = await sha256Hex(accessToken);
    const { data: existing } = await admin
      .from("merch_customer_orders")
      .select("id, order_number, access_token_hash, total_amount, status")
      .eq("client_request_id", clientRequestId)
      .maybeSingle();

    if (existing) {
      if (existing.access_token_hash !== accessTokenHash) {
        return jsonResponse({ error: "Request conflict" }, 409, cors);
      }
      const { data: attempt } = await admin
        .from("merch_payment_attempts")
        .select("payment_url, external_payment_id, provider_status")
        .eq("order_id", existing.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (attempt?.payment_url) {
        return jsonResponse({
          orderNumber: existing.order_number,
          accessToken,
          paymentId: attempt.external_payment_id,
          paymentUrl: attempt.payment_url,
          amount: existing.total_amount,
        }, 200, cors);
      }
      if (existing.status === "payment_failed") {
        return jsonResponse({
          error: "Предыдущую попытку оплаты завершить не удалось. Создайте новый платёж.",
          retryAllowed: true,
        }, 409, cors);
      }
      return jsonResponse(
        { error: "Платёж для этого заказа ещё создаётся. Повторите через минуту." },
        409,
        cors,
      );
    }

    const productIds = [...new Set(cart.map((item) => item.id))];
    const { data: products, error: productsError } = await admin
      .from("merch_storefront_products")
      .select(
        "id,name,price_min,is_active,sizes,offers,main_image_path,primary_image_url",
      )
      .in("id", productIds)
      .eq("is_active", true);
    if (productsError) throw productsError;

    const productMap = new Map(
      ((products ?? []) as ProductRow[]).map((product) => [product.id, product]),
    );
    const orderItems: OrderItem[] = cart.map((cartItem) => {
      const product = productMap.get(cartItem.id);
      if (!product) throw new Error("Один из товаров больше недоступен");
      if (!(product.sizes ?? []).map(String).includes(cartItem.size)) {
        throw new Error(`Размер ${cartItem.size} товара «${product.name}» недоступен`);
      }

      const priceRub = Number(product.price_min);
      if (!Number.isFinite(priceRub) || priceRub <= 0) {
        throw new Error(`Для товара «${product.name}» не задана цена`);
      }
      const unitPrice = Math.round(priceRub * 100);
      const offer = offerForSize(product, cartItem.size);

      return {
        product_id: product.id,
        offer_id: offer ? text(offer.offer_id, 120) || null : null,
        sku: offer ? text(offer.sku, 120) || null : null,
        product_name: product.name.slice(0, 128),
        size: cartItem.size,
        quantity: cartItem.qty,
        unit_price_amount: unitPrice,
        line_total_amount: unitPrice * cartItem.qty,
        image_url: product.main_image_path ?? product.primary_image_url,
        product_snapshot: {
          storefront_product_id: product.id,
          offer_id: offer?.offer_id ?? null,
          sku: offer?.sku ?? null,
        },
      };
    });

    const subtotal = orderItems.reduce(
      (sum, item) => sum + item.line_total_amount,
      0,
    );
    const promoCode = text(body.promoCode, 32).toUpperCase();
    const discount = promoCode === "KOMUI10" ? Math.round(subtotal * 0.1) : 0;
    const total = subtotal - discount + delivery.amount;
    const number = orderNumber();
    const legalAcceptedAt = new Date().toISOString();

    const { data: createdOrderId, error: createOrderError } = await admin.rpc(
      "merch_create_checkout_order",
      {
        p_order: {
          client_request_id: clientRequestId,
          order_number: number,
          access_token_hash: accessTokenHash,
          status: "created",
          customer_first_name: firstName,
          customer_last_name: lastName,
          customer_phone: phone,
          marketing_consent: marketingConsent,
          legal_accepted_at: legalAcceptedAt,
          delivery_provider: "cdek",
          delivery_point_code: delivery.code,
          delivery_city: delivery.city,
          delivery_address: delivery.address,
          delivery_hours: delivery.hours,
          delivery_eta: delivery.eta,
          delivery_amount: delivery.amount,
          currency: "RUB",
          subtotal_amount: subtotal,
          discount_amount: discount,
          total_amount: total,
          promo_code: promoCode === "KOMUI10" ? promoCode : null,
          source: "storefront",
          metadata: {
            user_agent: text(request.headers.get("user-agent"), 300),
          },
        },
        p_items: orderItems,
      },
    );
    if (createOrderError) throw createOrderError;

    const orderId = String(createdOrderId);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://komui.ru")
      .split(",")[0]
      .replace(/\/$/, "");

    const initPayload: Record<string, unknown> = {
      TerminalKey: terminalKey,
      Amount: total,
      OrderId: number,
      Description: `Заказ KOMUI ${number}`.slice(0, 140),
      PayType: "O",
      Language: "ru",
      NotificationURL: `${supabaseUrl}/functions/v1/tbank-webhook`,
      SuccessURL:
        `${siteUrl}/payment-result.html?status=success&order=${encodeURIComponent(number)}`,
      FailURL:
        `${siteUrl}/payment-result.html?status=fail&order=${encodeURIComponent(number)}`,
      DATA: {
        Phone: phone,
        name: `${lastName} ${firstName}`.slice(0, 100),
        order_number: number,
      },
    };
    const receipt = buildReceipt(orderItems, discount, delivery, phone);
    if (receipt) initPayload.Receipt = receipt;
    initPayload.Token = await createTbankToken(initPayload, password);

    const { data: attempt, error: attemptError } = await admin
      .from("merch_payment_attempts")
      .insert({
        order_id: orderId,
        terminal_key: terminalKey,
        provider_status: "INITIATING",
        amount: total,
        request_payload: sanitizedTbankPayload(initPayload),
      })
      .select("id")
      .single();
    if (attemptError) throw attemptError;

    let providerResponse: Record<string, unknown>;
    try {
      const providerRequest = await fetch(`${apiUrl}/Init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initPayload),
      });
      const providerText = await providerRequest.text();
      try {
        providerResponse = JSON.parse(providerText);
      } catch {
        throw new Error(
          `Т‑Банк вернул некорректный ответ (${providerRequest.status})`,
        );
      }
    } catch (error) {
      await admin.from("merch_payment_attempts").update({
        provider_status: "NETWORK_ERROR",
        error_message: errorMessage(error).slice(0, 500),
      }).eq("id", attempt.id);
      await admin.from("merch_customer_orders").update({
        status: "payment_failed",
      }).eq("id", orderId);
      return jsonResponse({
        error: "Т‑Банк временно не отвечает. Попробуйте ещё раз.",
        retryAllowed: true,
      }, 502, cors);
    }

    const providerSuccess = providerResponse.Success === true ||
      providerResponse.Success === "true";
    const paymentUrl = text(providerResponse.PaymentURL, 2000);
    const paymentId = text(providerResponse.PaymentId, 120);
    const providerStatus = text(providerResponse.Status, 80) || "INIT_ERROR";
    const errorCode = text(providerResponse.ErrorCode, 80);
    const errorText = text(
      providerResponse.Message ?? providerResponse.Details,
      500,
    );

    await admin.from("merch_payment_attempts").update({
      external_payment_id: paymentId || null,
      provider_status: providerStatus,
      payment_url: paymentUrl || null,
      error_code: errorCode || null,
      error_message: errorText || null,
      response_payload: sanitizedTbankPayload(providerResponse),
    }).eq("id", attempt.id);

    if (!providerSuccess || !paymentUrl || !paymentId) {
      await admin.from("merch_customer_orders").update({
        status: "payment_failed",
      }).eq("id", orderId);
      return jsonResponse({
        error: errorText || "Т‑Банк не создал платёж",
        code: errorCode || "TBANK_INIT_FAILED",
        retryAllowed: true,
      }, 502, cors);
    }

    await admin.from("merch_customer_orders").update({
      status: "pending_payment",
    }).eq("id", orderId);

    return jsonResponse({
      orderNumber: number,
      accessToken,
      paymentId,
      paymentUrl,
      amount: total,
    }, 200, cors);
  } catch (error) {
    console.error("tbank-create-payment", error);
    return jsonResponse({ error: errorMessage(error) }, 400, cors);
  }
});
