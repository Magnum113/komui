import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import {
  buildCdekPackages,
  findCdekCity,
  findCdekDeliveryPoint,
  listCdekDeliveryPoints,
  normalizePoint,
  quoteCdekDelivery,
} from "./cdek";
import {
  cdekPackageInputsFromOrderItems,
  CheckoutRepository,
  normalizePhone,
  orderNumber,
  subtotalAmount,
  text,
  validateClientIdentity,
  validatedCart,
  type OrderItemInput,
} from "./checkout";
import { createTbankToken, safeEqual, sanitizedTbankPayload, sha256Hex } from "./crypto";
import { HttpError, errorMessage } from "./errors";
import {
  markPromoRedemptionRedeemed,
  promoPhoneHash,
  releasePromoRedemption,
  reservePromoRedemption,
  validatePromoCode,
  type PromoValidation,
} from "./promo";

type HandlerContext = {
  config: AppConfig;
  db: Db;
};

type JsonBody = Record<string, unknown>;

const allowedCompatibilityFunctions = new Set([
  "cdek-delivery-points",
  "cdek-delivery-quote",
  "promo-validate",
  "tbank-create-payment",
  "tbank-payment-status",
]);

function assertPost(request: FastifyRequest) {
  if (request.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
}

function bodyObject(request: FastifyRequest): JsonBody {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as JsonBody;
}

function matchesPoint(point: ReturnType<typeof normalizePoint>, query: string) {
  if (!query) return true;
  const haystack = [point.code, point.title, point.city, point.address, point.metro]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function tbankRuntimeConfig(config: AppConfig) {
  const terminalKey =
    config.TBANK_MODE === "production"
      ? config.TBANK_TERMINAL_KEY
      : config.TBANK_DEMO_TERMINAL_KEY;
  const password =
    config.TBANK_MODE === "production"
      ? config.TBANK_PASSWORD
      : config.TBANK_DEMO_PASSWORD;

  if (config.TBANK_MOCK_PAYMENTS) {
    return {
      terminalKey: terminalKey || "KOMUI_STAGE_MOCK",
      password: password || "komui-stage-mock-password",
      apiUrl: config.TBANK_API_URL,
      mock: true,
    };
  }

  if (!terminalKey || !password) {
    throw new HttpError(
      503,
      "tbank_not_configured",
      "T-Bank credentials are not configured",
    );
  }

  return {
    terminalKey,
    password,
    apiUrl: config.TBANK_API_URL,
    mock: false,
  };
}

function publicApiBaseUrl(config: AppConfig) {
  return (config.PUBLIC_API_BASE_URL || `${config.SITE_URL.replace(/\/$/, "")}/api`).replace(/\/$/, "");
}

function siteUrl(config: AppConfig) {
  return config.SITE_URL.replace(/\/$/, "");
}

function buildReceipt(
  config: AppConfig,
  items: OrderItemInput[],
  discountAmount: number,
  delivery: { amount: number },
  phone: string,
): Record<string, unknown> | undefined {
  const taxation = config.TBANK_TAXATION;
  const tax = config.TBANK_TAX;
  if (!taxation || !tax) return undefined;

  const units = items.flatMap((item) =>
    Array.from({ length: item.quantity }, () => ({
      name: `${item.product_name} · ${item.size}`.slice(0, 128),
      amount: item.unit_price_amount,
      object: "commodity",
    })),
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

  return { Phone: phone, Taxation: taxation, Items: receiptItems };
}

export async function handleCdekDeliveryPoints(
  request: FastifyRequest,
  _reply: FastifyReply,
  { config }: HandlerContext,
) {
  assertPost(request);
  const body = bodyObject(request);
  const cityQuery = text(body.city, 80);
  const pointQuery = text(body.query, 120);
  if (cityQuery.length < 2) {
    return { city: null, points: [], message: "Введите город" };
  }

  const city = await findCdekCity(config, cityQuery);
  if (!city) {
    return { city: null, points: [], message: "Город не найден в CDEK" };
  }

  const points = (await listCdekDeliveryPoints(config, city.code))
    .map(normalizePoint)
    .filter((point) => point.isHandout && matchesPoint(point, pointQuery))
    .slice(0, 120);

  return {
    city: {
      code: city.code,
      name: city.city,
      region: city.region ?? null,
      lat: city.latitude ?? null,
      lng: city.longitude ?? null,
    },
    points,
  };
}

export async function handleCdekDeliveryQuote(
  request: FastifyRequest,
  _reply: FastifyReply,
  { config, db }: HandlerContext,
) {
  assertPost(request);
  const body = bodyObject(request);
  const delivery = (body.delivery ?? {}) as Record<string, unknown>;
  const deliveryPointCode = text(delivery.code, 40);
  const deliveryCityCode = Number(delivery.cityCode);
  if (!deliveryPointCode || !Number.isInteger(deliveryCityCode)) {
    throw new HttpError(400, "delivery_point_required", "Выберите пункт выдачи CDEK");
  }

  const cart = validatedCart(body.items);
  const checkout = new CheckoutRepository(db);
  const orderItems = await checkout.orderItemsFromCart(cart);
  const packages = buildCdekPackages(
    "quote",
    cdekPackageInputsFromOrderItems(orderItems),
    config.CDEK_PACKING_HEIGHT_EXTRA_CM,
  );
  const quote = await quoteCdekDelivery(config, {
    deliveryCityCode,
    packages,
  });

  return {
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
  };
}

export async function handlePromoValidate(
  request: FastifyRequest,
  _reply: FastifyReply,
  { db }: HandlerContext,
) {
  assertPost(request);
  const body = bodyObject(request);
  const cart = validatedCart(body.items);
  const checkout = new CheckoutRepository(db);
  const subtotal = subtotalAmount(await checkout.orderItemsFromCart(cart));
  const delivery = (body.delivery ?? {}) as Record<string, unknown>;
  const deliveryAmount = Math.max(0, Math.round(Number(delivery.amount) || 0));
  const validation = await validatePromoCode(db, {
    code: body.promoCode,
    subtotalAmount: subtotal,
    deliveryAmount,
  });

  return {
    ...validation,
    subtotalAmount: subtotal,
    deliveryAmount,
    totalAmount:
      subtotal - validation.discountAmount + validation.chargedDeliveryAmount,
  };
}

async function latestPaymentAttempt(db: Db, orderId: string) {
  const result = await db.query<{
    payment_url: string | null;
    external_payment_id: string | null;
    provider_status: string;
  }>(
    `
      select payment_url, external_payment_id, provider_status
      from public.merch_payment_attempts
      where order_id = $1::uuid
      order by created_at desc
      limit 1
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

async function insertCheckoutOrder(
  client: PoolClient,
  order: Record<string, unknown>,
  items: OrderItemInput[],
) {
  const orderResult = await client.query<{ id: string }>(
    `
      insert into public.merch_customer_orders (
        client_request_id,
        order_number,
        access_token_hash,
        status,
        customer_first_name,
        customer_last_name,
        customer_phone,
        marketing_consent,
        legal_accepted_at,
        delivery_provider,
        delivery_point_code,
        delivery_city,
        delivery_address,
        delivery_hours,
        delivery_eta,
        delivery_amount,
        currency,
        subtotal_amount,
        discount_amount,
        total_amount,
        promo_code,
        source,
        metadata
      )
      values (
        $1::uuid, $2, $3, $4, $5, $6, $7, $8::boolean, $9::timestamptz,
        'cdek', $10, $11, $12, $13, $14, $15, 'RUB', $16, $17, $18, $19,
        'storefront', $20::jsonb
      )
      returning id
    `,
    [
      order.client_request_id,
      order.order_number,
      order.access_token_hash,
      order.status,
      order.customer_first_name,
      order.customer_last_name,
      order.customer_phone,
      order.marketing_consent,
      order.legal_accepted_at,
      order.delivery_point_code,
      order.delivery_city,
      order.delivery_address,
      order.delivery_hours,
      order.delivery_eta,
      order.delivery_amount,
      order.subtotal_amount,
      order.discount_amount,
      order.total_amount,
      order.promo_code,
      JSON.stringify(order.metadata ?? {}),
    ],
  );

  const orderId = orderResult.rows[0].id;
  for (const item of items) {
    await client.query(
      `
        insert into public.merch_customer_order_items (
          order_id,
          product_id,
          offer_id,
          sku,
          product_name,
          size,
          quantity,
          unit_price_amount,
          line_total_amount,
          image_url,
          product_snapshot
        )
        values (
          $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
        )
      `,
      [
        orderId,
        item.product_id,
        item.offer_id,
        item.sku,
        item.product_name,
        item.size,
        item.quantity,
        item.unit_price_amount,
        item.line_total_amount,
        item.image_url,
        JSON.stringify(item.product_snapshot),
      ],
    );
  }
  return orderId;
}

export async function handleTbankCreatePayment(
  request: FastifyRequest,
  _reply: FastifyReply,
  { config, db }: HandlerContext,
) {
  assertPost(request);
  const body = bodyObject(request);
  const customer = (body.customer ?? {}) as Record<string, unknown>;
  const deliveryInput = (body.delivery ?? {}) as Record<string, unknown>;
  const cart = validatedCart(body.items);
  const firstName = text(customer.firstName, 80);
  const lastName = text(customer.lastName, 80);
  const phone = normalizePhone(customer.phone);
  const legalConsent = customer.legalConsent === true;
  const marketingConsent = customer.marketingConsent === true;
  const { clientRequestId, accessToken } = validateClientIdentity(
    body.clientRequestId,
    body.accessToken,
  );

  if (firstName.length < 2 || lastName.length < 2) {
    throw new HttpError(400, "customer_name_required", "Укажите имя и фамилию получателя");
  }
  if (!legalConsent) {
    throw new HttpError(
      400,
      "legal_consent_required",
      "Необходимо принять оферту и согласие на обработку данных",
    );
  }

  const deliveryPointCode = text(deliveryInput.code, 40).toUpperCase();
  const deliveryCityCode = Number(deliveryInput.cityCode);
  const requestedTariffCode = Number(deliveryInput.tariffCode);
  const tariffCode =
    Number.isInteger(requestedTariffCode) && requestedTariffCode > 0
      ? requestedTariffCode
      : null;
  if (!deliveryPointCode || !Number.isInteger(deliveryCityCode) || deliveryCityCode <= 0) {
    throw new HttpError(
      400,
      "delivery_point_required",
      "Выберите доступный пункт выдачи СДЭК",
    );
  }

  const tbank = tbankRuntimeConfig(config);
  const accessTokenHash = sha256Hex(accessToken);
  const existingResult = await db.query<{
    id: string;
    order_number: string;
    access_token_hash: string;
    total_amount: number;
    status: string;
  }>(
    `
      select id, order_number, access_token_hash, total_amount, status
      from public.merch_customer_orders
      where client_request_id = $1::uuid
      limit 1
    `,
    [clientRequestId],
  );
  const existing = existingResult.rows[0];
  if (existing) {
    if (existing.access_token_hash !== accessTokenHash) {
      throw new HttpError(409, "request_conflict", "Request conflict");
    }
    const attempt = await latestPaymentAttempt(db, existing.id);
    if (attempt?.payment_url) {
      return {
        orderNumber: existing.order_number,
        accessToken,
        paymentId: attempt.external_payment_id,
        paymentUrl: attempt.payment_url,
        amount: existing.total_amount,
      };
    }
    if (existing.status === "payment_failed") {
      throw new HttpError(
        409,
        "payment_retry_required",
        "Предыдущую попытку оплаты завершить не удалось. Создайте новый платёж.",
        { retryAllowed: true },
      );
    }
    throw new HttpError(
      409,
      "payment_still_creating",
      "Платёж для этого заказа ещё создаётся. Повторите через минуту.",
    );
  }

  const checkout = new CheckoutRepository(db);
  const orderItems = await checkout.orderItemsFromCart(cart);
  const subtotal = subtotalAmount(orderItems);
  const number = orderNumber();
  const cdekPackages = buildCdekPackages(
    number,
    cdekPackageInputsFromOrderItems(orderItems),
    config.CDEK_PACKING_HEIGHT_EXTRA_CM,
  );
  const deliveryPoint = await findCdekDeliveryPoint(
    config,
    deliveryCityCode,
    deliveryPointCode,
  );
  if (!deliveryPoint) {
    throw new HttpError(
      400,
      "cdek_point_unavailable",
      "Выбранный пункт выдачи СДЭК недоступен",
    );
  }
  const cdekQuote = await quoteCdekDelivery(config, {
    deliveryCityCode,
    packages: cdekPackages,
    tariffCode,
  });
  const pointLocation = deliveryPoint.location ?? {};
  const phoneHash = promoPhoneHash(phone);
  const promoCode = text(body.promoCode, 32);
  const promoValidation = promoCode
    ? await validatePromoCode(db, {
        code: promoCode,
        subtotalAmount: subtotal,
        deliveryAmount: cdekQuote.amountKopecks,
        customerPhoneHash: phoneHash,
      })
    : null;
  if (promoCode && !promoValidation?.valid) {
    throw new HttpError(
      400,
      "promo_invalid",
      promoValidation?.message || "Промокод недействителен",
    );
  }

  const discount = promoValidation?.discountAmount ?? 0;
  const deliveryDiscount = promoValidation?.deliveryDiscountAmount ?? 0;
  const chargedDeliveryAmount = Math.max(
    0,
    cdekQuote.amountKopecks - deliveryDiscount,
  );
  const total = subtotal - discount + chargedDeliveryAmount;
  const legalAcceptedAt = new Date().toISOString();
  const delivery = {
    code: deliveryPoint.code,
    cityCode: deliveryCityCode,
    city: text(pointLocation.city, 100) || text(deliveryInput.city, 100),
    address:
      text(pointLocation.address_full ?? pointLocation.address, 220) ||
      text(deliveryInput.address, 220),
    title: text(deliveryPoint.name, 160) || text(deliveryInput.title, 160),
    hours: text(deliveryPoint.work_time, 160) || text(deliveryInput.hours, 160),
    eta: cdekQuote.eta,
    amount: chargedDeliveryAmount,
    originalAmount: cdekQuote.amountKopecks,
    discountAmount: deliveryDiscount,
    tariffCode: cdekQuote.tariffCode,
    tariffName: cdekQuote.tariffName,
    deliveryMode: cdekQuote.deliveryMode,
    periodMin: cdekQuote.periodMin,
    periodMax: cdekQuote.periodMax,
    pointType: deliveryPoint.type ?? null,
    pointLat: Number(pointLocation.latitude) || null,
    pointLng: Number(pointLocation.longitude) || null,
  };

  let attemptId = 0;
  const orderId = await db.withTransaction(async (client) => {
    const createdOrderId = await insertCheckoutOrder(
      client,
      {
        client_request_id: clientRequestId,
        order_number: number,
        access_token_hash: accessTokenHash,
        status: "created",
        customer_first_name: firstName,
        customer_last_name: lastName,
        customer_phone: phone,
        marketing_consent: marketingConsent,
        legal_accepted_at: legalAcceptedAt,
        delivery_point_code: delivery.code,
        delivery_city: delivery.city || "СДЭК",
        delivery_address: delivery.address || delivery.title || delivery.code,
        delivery_hours: delivery.hours || null,
        delivery_eta: delivery.eta,
        delivery_amount: delivery.amount,
        subtotal_amount: subtotal,
        discount_amount: discount,
        total_amount: total,
        promo_code: promoValidation?.valid ? promoValidation.code : null,
        metadata: {
          user_agent: text(request.headers["user-agent"], 300),
          promo: promoValidation?.valid
            ? {
                code: promoValidation.code,
                promo_code_id: promoValidation.promoCodeId,
                discount_type: promoValidation.discountType,
                discount_amount: promoValidation.discountAmount,
                delivery_discount_amount: promoValidation.deliveryDiscountAmount,
                original_delivery_amount: cdekQuote.amountKopecks,
              }
            : null,
          cdek: {
            mock: config.CDEK_MOCK,
            shipment_point: config.CDEK_SHIPMENT_POINT,
            delivery_point: delivery.code,
            delivery_city_code: delivery.cityCode,
            delivery_point_name: delivery.title,
            delivery_point_type: delivery.pointType,
            delivery_point_lat: delivery.pointLat,
            delivery_point_lng: delivery.pointLng,
            tariff_code: delivery.tariffCode,
            tariff_name: delivery.tariffName,
            delivery_mode: delivery.deliveryMode,
            period_min: delivery.periodMin,
            period_max: delivery.periodMax,
            package_snapshot: cdekPackages,
            quote: cdekQuote.raw,
          },
        },
      },
      orderItems,
    );

    await reservePromoRedemption(client, {
      validation: promoValidation ?? invalidPromoValidation(delivery.amount),
      orderId: createdOrderId,
      orderNumber: number,
      clientRequestId,
      customerPhoneHash: phoneHash,
      subtotalAmount: subtotal,
      deliveryAmount: cdekQuote.amountKopecks,
    });

    const attempt = await client.query<{ id: number }>(
      `
        insert into public.merch_payment_attempts (
          order_id,
          terminal_key,
          provider_status,
          amount,
          request_payload
        )
        values ($1::uuid, $2, 'INITIATING', $3, $4::jsonb)
        returning id
      `,
      [
        createdOrderId,
        tbank.terminalKey,
        total,
        JSON.stringify({ mock: tbank.mock, created_before_provider_call: true }),
      ],
    );
    attemptId = attempt.rows[0].id;
    return createdOrderId;
  });

  if (tbank.mock) {
    const paymentId = `mock-${number}`;
    const paymentUrl = `${siteUrl(config)}/payment-result?status=success&order=${encodeURIComponent(number)}`;
    await db.query(
      `
        update public.merch_payment_attempts
        set external_payment_id = $2,
            provider_status = 'MOCK_INIT',
            payment_url = $3,
            response_payload = $4::jsonb
        where id = $1
      `,
      [attemptId, paymentId, paymentUrl, JSON.stringify({ Success: true, mock: true })],
    );
    await db.query(
      `update public.merch_customer_orders set status = 'pending_payment' where id = $1::uuid`,
      [orderId],
    );
    return { orderNumber: number, accessToken, paymentId, paymentUrl, amount: total };
  }

  const initPayload: Record<string, unknown> = {
    TerminalKey: tbank.terminalKey,
    Amount: total,
    OrderId: number,
    Description: `Заказ KOMUI ${number}`.slice(0, 140),
    PayType: "O",
    Language: "ru",
    NotificationURL: `${publicApiBaseUrl(config)}/v1/webhooks/tbank`,
    SuccessURL: `${siteUrl(config)}/payment-result?status=success&order=${encodeURIComponent(number)}`,
    FailURL: `${siteUrl(config)}/payment-result?status=fail&order=${encodeURIComponent(number)}`,
    DATA: {
      Phone: phone,
      name: `${lastName} ${firstName}`.slice(0, 100),
      order_number: number,
    },
  };
  const receipt = buildReceipt(config, orderItems, discount, delivery, phone);
  if (receipt) initPayload.Receipt = receipt;
  initPayload.Token = createTbankToken(initPayload, tbank.password);

  let providerResponse: Record<string, unknown>;
  try {
    const providerRequest = await fetch(`${tbank.apiUrl.replace(/\/$/, "")}/Init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initPayload),
      signal: AbortSignal.timeout(15_000),
    });
    const providerText = await providerRequest.text();
    providerResponse = JSON.parse(providerText) as Record<string, unknown>;
  } catch (error) {
    await db.query(
      `
        update public.merch_payment_attempts
        set provider_status = 'NETWORK_ERROR',
            error_message = $2
        where id = $1
      `,
      [attemptId, errorMessage(error).slice(0, 500)],
    );
    await db.query(
      `update public.merch_customer_orders set status = 'payment_failed' where id = $1::uuid`,
      [orderId],
    );
    await releasePromoRedemption(db, orderId);
    throw new HttpError(
      502,
      "tbank_network_error",
      "Т‑Банк временно не отвечает. Попробуйте ещё раз.",
      { retryAllowed: true },
    );
  }

  const providerSuccess =
    providerResponse.Success === true || providerResponse.Success === "true";
  const paymentUrl = text(providerResponse.PaymentURL, 2000);
  const paymentId = text(providerResponse.PaymentId, 120);
  const providerStatus = text(providerResponse.Status, 80) || "INIT_ERROR";
  const errorCode = text(providerResponse.ErrorCode, 80);
  const errorText = text(providerResponse.Message ?? providerResponse.Details, 500);

  await db.query(
    `
      update public.merch_payment_attempts
      set external_payment_id = $2,
          provider_status = $3,
          payment_url = $4,
          error_code = $5,
          error_message = $6,
          request_payload = $7::jsonb,
          response_payload = $8::jsonb
      where id = $1
    `,
    [
      attemptId,
      paymentId || null,
      providerStatus,
      paymentUrl || null,
      errorCode || null,
      errorText || null,
      JSON.stringify(sanitizedTbankPayload(initPayload)),
      JSON.stringify(sanitizedTbankPayload(providerResponse)),
    ],
  );

  if (!providerSuccess || !paymentUrl || !paymentId) {
    await db.query(
      `update public.merch_customer_orders set status = 'payment_failed' where id = $1::uuid`,
      [orderId],
    );
    await releasePromoRedemption(db, orderId);
    throw new HttpError(
      502,
      errorCode || "tbank_init_failed",
      errorText || "Т‑Банк не создал платёж",
      { retryAllowed: true },
    );
  }

  await db.query(
    `update public.merch_customer_orders set status = 'pending_payment' where id = $1::uuid`,
    [orderId],
  );

  return { orderNumber: number, accessToken, paymentId, paymentUrl, amount: total };
}

function invalidPromoValidation(deliveryAmount: number): PromoValidation {
  return {
    valid: false,
    code: null,
    promoCodeId: null,
    name: null,
    discountType: null,
    discountAmount: 0,
    deliveryDiscountAmount: 0,
    totalDiscountAmount: 0,
    chargedDeliveryAmount: deliveryAmount,
    message: "",
    startsAt: null,
    endsAt: null,
    metadata: null,
  };
}

export async function handleTbankPaymentStatus(
  request: FastifyRequest,
  _reply: FastifyReply,
  { db }: HandlerContext,
) {
  assertPost(request);
  const body = bodyObject(request);
  const number = text(body.orderNumber, 36);
  const accessToken = text(body.accessToken, 128);
  if (!number || !/^[A-Za-z0-9_-]{32,128}$/.test(accessToken)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }

  const orderResult = await db.query<{
    id: string;
    order_number: string;
    access_token_hash: string;
    status: string;
    total_amount: number;
    currency: string;
    delivery_point_code: string;
    created_at: string;
    paid_at: string | null;
  }>(
    `
      select id, order_number, access_token_hash, status, total_amount, currency,
             delivery_point_code, created_at, paid_at
      from public.merch_customer_orders
      where order_number = $1
      limit 1
    `,
    [number],
  );
  const order = orderResult.rows[0];
  if (!order || !safeEqual(sha256Hex(accessToken), order.access_token_hash)) {
    throw new HttpError(404, "order_not_found", "Order not found");
  }

  const attemptResult = await db.query<{
    provider_status: string | null;
    error_code: string | null;
    error_message: string | null;
    updated_at: string;
  }>(
    `
      select provider_status, error_code, error_message, updated_at
      from public.merch_payment_attempts
      where order_id = $1::uuid
      order by created_at desc
      limit 1
    `,
    [order.id],
  );

  const shipmentResult = await db.query<{
    status: string;
    cdek_uuid: string | null;
    cdek_number: string | null;
    error_message: string | null;
    updated_at: string;
  }>(
    `
      select status, cdek_uuid, cdek_number, error_message, updated_at
      from public.merch_cdek_shipments
      where order_id = $1::uuid
      limit 1
    `,
    [order.id],
  );
  const attempt = attemptResult.rows[0];
  const shipment = shipmentResult.rows[0];

  return {
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
    cdek: shipment
      ? {
          status: shipment.status,
          uuid: shipment.cdek_uuid,
          number: shipment.cdek_number,
          errorMessage: shipment.error_message,
          updatedAt: shipment.updated_at,
        }
      : null,
  };
}

function orderStatus(providerStatus: string): string | null {
  switch (providerStatus) {
    case "CONFIRMED":
      return "paid";
    case "AUTHORIZED":
      return "authorized";
    case "REFUNDED":
      return "refunded";
    case "PARTIAL_REFUNDED":
      return "partially_refunded";
    case "REJECTED":
    case "CANCELED":
    case "REVERSED":
    case "DEADLINE_EXPIRED":
      return "payment_failed";
    default:
      return null;
  }
}

function canApplyStatus(currentStatus: string, nextStatus: string): boolean {
  switch (currentStatus) {
    case "paid":
      return ["paid", "partially_refunded", "refunded"].includes(nextStatus);
    case "partially_refunded":
      return ["partially_refunded", "refunded"].includes(nextStatus);
    case "refunded":
      return nextStatus === "refunded";
    case "payment_review":
      return ["paid", "partially_refunded", "refunded"].includes(nextStatus);
    default:
      return true;
  }
}

export async function handleTbankWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  { config, db }: HandlerContext,
) {
  assertPost(request);
  const body = bodyObject(request);
  const token = text(body.Token, 128);
  const paymentId = text(body.PaymentId, 120);
  const number = text(body.OrderId, 36);
  const providerStatus = text(body.Status, 80);
  const amount = Number.isInteger(Number(body.Amount)) ? Number(body.Amount) : null;
  const tbank = tbankRuntimeConfig(config);

  if (text(body.TerminalKey, 80) !== tbank.terminalKey || !token) {
    return reply.status(403).send("Invalid terminal");
  }

  const expectedToken = createTbankToken(body, tbank.password);
  if (!safeEqual(token, expectedToken)) {
    request.log.warn({ paymentId, number }, "T-Bank webhook signature mismatch");
    return reply.status(403).send("Invalid token");
  }

  const attemptResult = await db.query<{
    id: number;
    order_id: string;
    amount: number;
  }>(
    `
      select id, order_id, amount
      from public.merch_payment_attempts
      where external_payment_id = $1
      limit 1
    `,
    [paymentId || "__no_payment_id__"],
  );
  const attempt = attemptResult.rows[0] ?? null;

  const orderResult = attempt?.order_id
    ? await db.query<{
        id: string;
        order_number: string;
        total_amount: number;
        status: string;
        paid_at: string | null;
      }>(
        `
          select id, order_number, total_amount, status, paid_at
          from public.merch_customer_orders
          where id = $1::uuid
          limit 1
        `,
        [attempt.order_id],
      )
    : await db.query<{
        id: string;
        order_number: string;
        total_amount: number;
        status: string;
        paid_at: string | null;
      }>(
        `
          select id, order_number, total_amount, status, paid_at
          from public.merch_customer_orders
          where order_number = $1
          limit 1
        `,
        [number],
      );
  const order = orderResult.rows[0];
  if (!order) return reply.status(404).send("Order not found");

  const canonicalPayload = sanitizedTbankPayload(body);
  const sortedPayload = Object.fromEntries(
    Object.entries(canonicalPayload).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const eventHash = sha256Hex(JSON.stringify(sortedPayload));

  await db.query(
    `
      insert into public.merch_payment_events (
        payment_attempt_id,
        order_id,
        external_payment_id,
        provider_status,
        event_hash,
        signature_valid,
        amount,
        payload
      )
      values ($1, $2::uuid, $3, $4, $5, true, $6, $7::jsonb)
      on conflict (event_hash) do nothing
    `,
    [
      attempt?.id ?? null,
      order.id,
      paymentId || null,
      providerStatus || null,
      eventHash,
      amount,
      JSON.stringify(canonicalPayload),
    ],
  );

  if (attempt?.id) {
    await db.query(
      `
        update public.merch_payment_attempts
        set provider_status = $2,
            confirmed_at = case when $2 = 'CONFIRMED' then coalesce(confirmed_at, now()) else confirmed_at end
        where id = $1
      `,
      [attempt.id, providerStatus || "UNKNOWN"],
    );
  }

  const nextStatus = orderStatus(providerStatus);
  if (nextStatus) {
    if (
      providerStatus === "CONFIRMED" &&
      (amount === null || amount !== order.total_amount)
    ) {
      if (!["paid", "partially_refunded", "refunded"].includes(order.status)) {
        await db.query(
          `
            update public.merch_customer_orders
            set status = 'payment_review',
                metadata = metadata || $2::jsonb
            where id = $1::uuid
          `,
          [
            order.id,
            JSON.stringify({
              payment_review_reason: "amount_mismatch",
              expected_amount: order.total_amount,
              received_amount: amount,
            }),
          ],
        );
      }
    } else if (canApplyStatus(order.status, nextStatus)) {
      await db.query(
        `
          update public.merch_customer_orders
          set status = $2,
              paid_at = case when $2 = 'paid' then coalesce(paid_at, now()) else paid_at end
          where id = $1::uuid
        `,
        [order.id, nextStatus],
      );

      if (nextStatus === "paid") {
        await markPromoRedemptionRedeemed(db, order.id);
        if (!config.CDEK_CREATE_SHIPMENTS) {
          request.log.info({ orderId: order.id }, "CDEK shipment creation disabled");
        }
      } else if (nextStatus === "payment_failed") {
        await releasePromoRedemption(db, order.id);
      } else if (nextStatus === "refunded") {
        await releasePromoRedemption(db, order.id, "canceled");
      }
    }
  }

  return reply.type("text/plain; charset=utf-8").send("OK");
}

export async function handleCompatibilityFunction(
  request: FastifyRequest,
  reply: FastifyReply,
  context: HandlerContext,
) {
  assertPost(request);
  const functionName = text((request.query as Record<string, unknown>).name, 80);
  if (!allowedCompatibilityFunctions.has(functionName)) {
    throw new HttpError(404, "function_not_found", "Function not found");
  }

  const apiKey = text(request.headers.apikey, 256);
  if (
    !apiKey ||
    !apiKey.startsWith(context.config.LEGACY_FUNCTION_API_KEY_PREFIX)
  ) {
    throw new HttpError(401, "invalid_api_key", "Missing or invalid API key");
  }

  switch (functionName) {
    case "cdek-delivery-points":
      return handleCdekDeliveryPoints(request, reply, context);
    case "cdek-delivery-quote":
      return handleCdekDeliveryQuote(request, reply, context);
    case "promo-validate":
      return handlePromoValidate(request, reply, context);
    case "tbank-create-payment":
      return handleTbankCreatePayment(request, reply, context);
    case "tbank-payment-status":
      return handleTbankPaymentStatus(request, reply, context);
    default:
      throw new HttpError(404, "function_not_found", "Function not found");
  }
}
