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
  MARKETING_CONSENT_SOURCE,
  MARKETING_CONSENT_VERSION,
  marketingConsentEvidence,
  normalizeEmail,
  normalizePhone,
  orderNumber,
  subtotalAmount,
  text,
  validateClientIdentity,
  validatedCart,
  type OrderItemInput,
} from "./checkout";
import { createTbankToken, safeEqual, sanitizedTbankPayload, sha256Hex } from "./crypto";
import { HttpError, errorDiagnostic } from "./errors";
import {
  promoPhoneHash,
  reservePromoRedemption,
  validatePromoCode,
  type PromoValidation,
} from "./promo";
import { enqueueCdekEffect } from "./cdekEffects";
import {
  processTbankWebhookEvent,
  TbankWebhookOrderMismatchError,
  TbankWebhookOrderNotFoundError,
} from "./tbankWebhook";
import { enqueueOrderPaidEmail } from "./email/orderPaidOutbox";
import {
  emailRequestEvidence,
  upsertCheckoutEmailContact,
} from "./email/contacts";
import {
  markTbankInitUnknown,
  persistTbankInitSuccess,
  reconcileTbankInitForOrder,
  isResumableTbankPaymentStatus,
  tbankInitResponseMatchesBoundary,
  tbankRuntimeConfig,
  validTbankPaymentUrl,
  type PersistTbankInitSuccessResult,
} from "./tbankReconciliation";

type HandlerContext = {
  config: AppConfig;
  db: Db;
};

type JsonBody = Record<string, unknown>;

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
  email: string,
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

  return { Phone: phone, Email: email, Taxation: taxation, Items: receiptItems };
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
    id: number;
    payment_url: string | null;
    external_payment_id: string | null;
    provider_status: string;
  }>(
    `
      select id, payment_url, external_payment_id, provider_status
      from public.merch_payment_attempts
      where order_id = $1::uuid
      order by created_at desc
      limit 1
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

function hasResumableTbankPaymentUrl(
  attempt: Awaited<ReturnType<typeof latestPaymentAttempt>>,
): boolean {
  return Boolean(
    attempt?.payment_url &&
      isResumableTbankPaymentStatus(attempt.provider_status),
  );
}

type ExistingPaymentOrder = {
  id: string;
  order_number: string;
  access_token_hash: string;
  total_amount: number;
  status: string;
};

async function paymentOrderById(
  db: Db,
  orderId: string,
): Promise<ExistingPaymentOrder | null> {
  const result = await db.query<ExistingPaymentOrder>(
    `
      select id, order_number, access_token_hash, total_amount, status
      from public.merch_customer_orders
      where id = $1::uuid
      limit 1
    `,
    [orderId],
  );
  return result.rows[0] ?? null;
}

function paymentReconciliationPending(
  order: ExistingPaymentOrder,
  config: AppConfig,
  reason = "Проверяем, был ли создан платёж. Повторите через несколько секунд.",
): HttpError {
  return new HttpError(409, "payment_reconciliation_pending", reason, {
    retryAllowed: false,
    retryMode: "same_request",
    retryAfterMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
    orderNumber: order.order_number,
  });
}

async function resolveExistingPayment(
  config: AppConfig,
  db: Db,
  tbank: ReturnType<typeof tbankRuntimeConfig>,
  order: ExistingPaymentOrder,
  accessToken: string,
  accessTokenHash: string,
) {
  if (order.access_token_hash !== accessTokenHash) {
    throw new HttpError(409, "request_conflict", "Request conflict");
  }
  if (["payment_failed", "canceled", "refunded"].includes(order.status)) {
    throw new HttpError(
      409,
      "payment_retry_required",
      "Предыдущая попытка оплаты завершилась достоверной ошибкой. Создайте новый платёж.",
      { retryAllowed: true },
    );
  }
  if (["authorized", "paid", "partially_refunded"].includes(order.status)) {
    throw new HttpError(
      409,
      "payment_already_processed",
      "Платёж уже обрабатывается или обработан банком. Новый заказ создавать не нужно.",
      { retryAllowed: false, orderNumber: order.order_number },
    );
  }
  if (order.status === "payment_review") {
    throw new HttpError(
      409,
      "payment_requires_review",
      "Платёж требует ручной проверки. Новый заказ создавать не нужно.",
      { retryAllowed: false, orderNumber: order.order_number },
    );
  }

  let attempt = await latestPaymentAttempt(db, order.id);
  if (
    attempt &&
    ["REJECTED", "CANCELED", "REVERSED", "DEADLINE_EXPIRED"].includes(
      attempt.provider_status,
    )
  ) {
    throw new HttpError(
      409,
      "payment_retry_required",
      "Предыдущая попытка оплаты завершилась достоверной ошибкой. Создайте новый платёж.",
      { retryAllowed: true },
    );
  }
  if (hasResumableTbankPaymentUrl(attempt)) {
    return {
      orderNumber: order.order_number,
      accessToken,
      paymentId: attempt.external_payment_id,
      paymentUrl: attempt.payment_url,
      amount: order.total_amount,
    };
  }

  const needsReconciliation = Boolean(
    attempt &&
      (["created", "payment_unknown"].includes(order.status) ||
        ["INITIATING", "INIT_UNKNOWN", "RECONCILING_INIT", "AUTH_FAIL"].includes(
          attempt.provider_status,
        )),
  );
  if (needsReconciliation && !tbank.mock) {
    await reconcileTbankInitForOrder(db, tbank, order.id, {
      staleMs: config.TBANK_RECONCILIATION_STALE_MS,
      leaseMs: config.TBANK_RECONCILIATION_LEASE_MS,
      intervalMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
      maxAttempts: config.TBANK_RECONCILIATION_MAX_ATTEMPTS,
      createCdekShipments: config.CDEK_CREATE_SHIPMENTS,
    });

    // Provider I/O happens outside the database transaction. A webhook or a
    // newer reconciliation lease may therefore supersede that result. Make
    // the retry decision only from the committed order/attempt state.
    const refreshedOrder = await paymentOrderById(db, order.id);
    attempt = await latestPaymentAttempt(db, order.id);
    if (!refreshedOrder) {
      throw paymentReconciliationPending(order, config);
    }
    if (
      ["authorized", "paid", "partially_refunded"].includes(
        refreshedOrder.status,
      )
    ) {
      throw new HttpError(
        409,
        "payment_already_processed",
        "Платёж уже обработан банком. Новый заказ создавать не нужно.",
        { retryAllowed: false, orderNumber: refreshedOrder.order_number },
      );
    }
    if (refreshedOrder.status === "payment_review") {
      throw new HttpError(
        409,
        "payment_requires_review",
        "Платёж требует ручной проверки. Новый заказ создавать не нужно.",
        { retryAllowed: false, orderNumber: refreshedOrder.order_number },
      );
    }
    if (
      ["payment_failed", "canceled", "refunded"].includes(
        refreshedOrder.status,
      ) ||
      (attempt &&
        ["REJECTED", "CANCELED", "REVERSED", "DEADLINE_EXPIRED"].includes(
          attempt.provider_status,
        ))
    ) {
      throw new HttpError(
        409,
        "payment_retry_required",
        "Т‑Банк подтвердил, что предыдущий платёж завершился ошибкой.",
        { retryAllowed: true },
      );
    }

    if (hasResumableTbankPaymentUrl(attempt)) {
      return {
        orderNumber: refreshedOrder.order_number,
        accessToken,
        paymentId: attempt.external_payment_id,
        paymentUrl: attempt.payment_url,
        amount: refreshedOrder.total_amount,
        recovered: true,
      };
    }
    throw paymentReconciliationPending(refreshedOrder, config);
  }

  throw new HttpError(
    409,
    "payment_still_creating",
    "Платёж для этого заказа ещё создаётся. Повторите через несколько секунд.",
    {
      retryAllowed: false,
      retryMode: "same_request",
      retryAfterMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
      orderNumber: order.order_number,
    },
  );
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
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
        customer_email,
        marketing_consent,
        marketing_consent_at,
        marketing_consent_version,
        marketing_consent_source,
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
        $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::boolean,
        $10::timestamptz, $11, $12, $13::timestamptz,
        'cdek', $14, $15, $16, $17, $18, $19, 'RUB', $20, $21, $22, $23,
        'storefront', $24::jsonb
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
      order.customer_email,
      order.marketing_consent,
      order.marketing_consent_at,
      order.marketing_consent_version,
      order.marketing_consent_source,
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

export function assertTbankInitPersistenceAllowsRedirect(
  result: PersistTbankInitSuccessResult,
  orderNumberValue: string,
  retryAfterMs: number,
): asserts result is {
  kind: "persisted";
  attemptStatus: string;
  orderStatus: string;
} {
  if (result.kind === "persisted") return;
  if (result.kind === "reconciling") {
    throw new HttpError(
      503,
      "payment_reconciliation_pending",
      "Проверка платежа уже выполняется. Новый заказ создавать не нужно.",
      {
        retryAllowed: false,
        retryMode: "same_request",
        retryAfterMs,
        orderNumber: orderNumberValue,
      },
    );
  }
  if (result.kind === "processed") {
    throw new HttpError(
      409,
      "payment_already_processed",
      "Платёж уже обрабатывается или обработан банком. Новый заказ создавать не нужно.",
      { retryAllowed: false, orderNumber: orderNumberValue },
    );
  }
  if (result.kind === "retry") {
    throw new HttpError(
      409,
      "payment_retry_required",
      "Предыдущая попытка оплаты завершилась достоверной ошибкой. Создайте новый платёж.",
      { retryAllowed: true, orderNumber: orderNumberValue },
    );
  }
  throw new HttpError(
    409,
    "payment_requires_review",
    "Платёж требует ручной проверки. Новый заказ создавать не нужно.",
    { retryAllowed: false, orderNumber: orderNumberValue },
  );
}

export function tbankInitResponseAllowsPersistence(
  httpOk: boolean,
  response: Record<string, unknown>,
  expected: { terminalKey: string; orderNumber: string; amount: number },
): boolean {
  return Boolean(
    httpOk &&
      (response.Success === true || response.Success === "true") &&
      validTbankPaymentUrl(response.PaymentURL) &&
      text(response.PaymentId, 120) &&
      tbankInitResponseMatchesBoundary(response, expected),
  );
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
  const email = normalizeEmail(customer.email);
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
  const existingResult = await db.query<ExistingPaymentOrder>(
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
    return resolveExistingPayment(
      config,
      db,
      tbank,
      existing,
      accessToken,
      accessTokenHash,
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
  const consentEvidence = marketingConsentEvidence(
    marketingConsent,
    legalAcceptedAt,
  );
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
  // Persist the exact signed provider boundary before the external call. If
  // the process dies after sending Init, the reconciler still has OrderId,
  // amount and receipt facts needed to resolve the orphan safely.
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
      Email: email,
      name: `${lastName} ${firstName}`.slice(0, 100),
      order_number: number,
    },
  };
  const receipt = buildReceipt(config, orderItems, discount, delivery, phone, email);
  if (receipt) initPayload.Receipt = receipt;
  initPayload.Token = createTbankToken(initPayload, tbank.password);

  let attemptId = 0;
  let orderId: string;
  try {
    orderId = await db.withTransaction(async (client) => {
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
          customer_email: email,
          marketing_consent: marketingConsent,
          marketing_consent_at: consentEvidence.at,
          marketing_consent_version: consentEvidence.version,
          marketing_consent_source: consentEvidence.source,
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

      await upsertCheckoutEmailContact(client, {
        orderId: createdOrderId,
        email,
        displayName: `${firstName} ${lastName}`,
        marketingConsent,
        consentAt: legalAcceptedAt,
        consentVersion: MARKETING_CONSENT_VERSION,
        consentSource: MARKETING_CONSENT_SOURCE,
        evidence: emailRequestEvidence(request),
      });

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
          JSON.stringify(sanitizedTbankPayload(initPayload)),
        ],
      );
      attemptId = attempt.rows[0].id;
      return createdOrderId;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Concurrent calls using one idempotency key converge on the committed
    // order instead of leaking a database 500 or creating another provider call.
    const concurrentResult = await db.query<ExistingPaymentOrder>(
      `
        select id, order_number, access_token_hash, total_amount, status
        from public.merch_customer_orders
        where client_request_id = $1::uuid
        limit 1
      `,
      [clientRequestId],
    );
    const concurrentOrder = concurrentResult.rows[0];
    if (!concurrentOrder) throw error;
    return resolveExistingPayment(
      config,
      db,
      tbank,
      concurrentOrder,
      accessToken,
      accessTokenHash,
    );
  }

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

  let providerResponse: Record<string, unknown>;
  let providerHttpOk = false;
  let providerHttpStatus = 0;
  try {
    const providerRequest = await fetch(`${tbank.apiUrl.replace(/\/$/, "")}/Init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initPayload),
      signal: AbortSignal.timeout(tbank.requestTimeoutMs),
    });
    providerHttpOk = providerRequest.ok;
    providerHttpStatus = providerRequest.status;
    const providerText = await providerRequest.text();
    const parsedResponse = JSON.parse(providerText) as unknown;
    if (
      !parsedResponse ||
      typeof parsedResponse !== "object" ||
      Array.isArray(parsedResponse)
    ) {
      throw new Error(`T-Bank Init returned an invalid payload (${providerRequest.status})`);
    }
    providerResponse = parsedResponse as Record<string, unknown>;
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    request.log.error(
      {
        err: error,
        provider: "tbank",
        operation: "Init",
        orderId,
        orderNumber: number,
        paymentAttemptId: attemptId,
        upstreamErrorCode: diagnostic.code,
        upstreamErrorMessage: diagnostic.message,
      },
      "T-Bank payment initialization failed before a provider response",
    );
    await markTbankInitUnknown(db, {
      orderId,
      attemptId,
      errorCode: diagnostic.code,
      errorMessage: diagnostic.message,
      retryAtMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
      requestPayload: initPayload,
    }).catch((persistenceError) => {
      request.log.error(
        { err: persistenceError, orderId, orderNumber: number, paymentAttemptId: attemptId },
        "Failed to persist ambiguous T-Bank Init state; stale INITIATING recovery remains active",
      );
    });
    throw new HttpError(
      503,
      "payment_reconciliation_pending",
      "Банк не подтвердил создание платежа. Проверяем статус; новый заказ создавать не нужно.",
      {
        retryAllowed: false,
        retryMode: "same_request",
        retryAfterMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
        orderNumber: number,
      },
    );
  }

  const providerSuccess =
    providerResponse.Success === true || providerResponse.Success === "true";
  const paymentUrl = validTbankPaymentUrl(providerResponse.PaymentURL);
  const paymentId = text(providerResponse.PaymentId, 120);
  const providerStatus = text(providerResponse.Status, 80).toUpperCase() || "INIT_ERROR";
  const errorCode = text(providerResponse.ErrorCode, 80);
  const errorText = text(providerResponse.Message ?? providerResponse.Details, 500);
  const responseMatchesBoundary = tbankInitResponseMatchesBoundary(
    providerResponse,
    { terminalKey: tbank.terminalKey, orderNumber: number, amount: total },
  );
  const responseAllowsPersistence = tbankInitResponseAllowsPersistence(
    providerHttpOk,
    providerResponse,
    { terminalKey: tbank.terminalKey, orderNumber: number, amount: total },
  );

  if (!responseAllowsPersistence) {
    const ambiguousCode = !providerHttpOk
      ? `tbank_init_http_${providerHttpStatus || "unknown"}`
      : providerStatus !== "NEW"
      ? "tbank_init_status_mismatch"
      : !responseMatchesBoundary
        ? "tbank_init_boundary_mismatch"
      : errorCode || "tbank_init_unconfirmed";
    const ambiguousMessage = !providerHttpOk
      ? `T-Bank Init returned HTTP ${providerHttpStatus || "unknown"}`
      : providerStatus !== "NEW"
      ? "T-Bank Init response did not confirm the documented NEW status"
      : !responseMatchesBoundary
        ? "T-Bank Init response did not match terminal, order or amount"
      : errorText || "T-Bank did not return a complete successful Init response";
    await markTbankInitUnknown(db, {
      orderId,
      attemptId,
      errorCode: ambiguousCode,
      errorMessage: ambiguousMessage,
      retryAtMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
      requestPayload: initPayload,
      responsePayload: providerHttpOk
        ? providerResponse
        : {
            ...providerResponse,
            PaymentURL: null,
            HttpStatus: providerHttpStatus || null,
          },
    });
    throw new HttpError(
      503,
      "payment_reconciliation_pending",
      "Банк не подтвердил результат создания платежа. Проверяем статус; новый заказ создавать не нужно.",
      {
        retryAllowed: false,
        retryMode: "same_request",
        retryAfterMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
        orderNumber: number,
        providerErrorCode: ambiguousCode,
      },
    );
  }

  let persistenceResult: Awaited<ReturnType<typeof persistTbankInitSuccess>>;
  try {
    persistenceResult = await persistTbankInitSuccess(db, {
      orderId,
      attemptId,
      paymentId,
      paymentUrl,
      providerStatus,
      errorCode: errorCode || null,
      errorMessage: errorText || null,
      requestPayload: initPayload,
      responsePayload: providerResponse,
    });
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    request.log.error(
      { err: error, orderId, orderNumber: number, paymentAttemptId: attemptId },
      "T-Bank Init succeeded but its response could not be persisted atomically",
    );
    await markTbankInitUnknown(db, {
      orderId,
      attemptId,
      errorCode: diagnostic.code || "init_persistence_failed",
      errorMessage: diagnostic.message,
      retryAtMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
      requestPayload: initPayload,
      responsePayload: providerResponse,
    }).catch(() => undefined);
    throw new HttpError(
      503,
      "payment_reconciliation_pending",
      "Платёж создан, но подтверждение сохраняется. Новый заказ создавать не нужно.",
      {
        retryAllowed: false,
        retryMode: "same_request",
        retryAfterMs: config.TBANK_RECONCILIATION_INTERVAL_MS,
        orderNumber: number,
      },
    );
  }

  if (persistenceResult.kind === "conflict") {
    request.log.error(
      {
        orderId,
        orderNumber: number,
        paymentAttemptId: attemptId,
        storedPaymentId: persistenceResult.storedPaymentId,
        receivedPaymentId: persistenceResult.receivedPaymentId,
      },
      "T-Bank Init PaymentId conflicts with an earlier webhook",
    );
  }

  assertTbankInitPersistenceAllowsRedirect(
    persistenceResult,
    number,
    config.TBANK_RECONCILIATION_INTERVAL_MS,
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
  const providerStatus = text(body.Status, 80).toUpperCase();
  const parsedAmount = Number(body.Amount);
  const amount =
    Number.isSafeInteger(parsedAmount) && parsedAmount > 0
      ? parsedAmount
      : null;
  const tbank = tbankRuntimeConfig(config);

  if (text(body.TerminalKey, 80) !== tbank.terminalKey || !token) {
    return reply.status(403).send("Invalid terminal");
  }

  const expectedToken = createTbankToken(body, tbank.password);
  if (!safeEqual(token, expectedToken)) {
    request.log.warn({ paymentId, number }, "T-Bank webhook signature mismatch");
    return reply.status(403).send("Invalid token");
  }

  if (!paymentId || !number || !providerStatus || amount === null) {
    request.log.warn(
      {
        hasPaymentId: Boolean(paymentId),
        hasOrderId: Boolean(number),
        hasStatus: Boolean(providerStatus),
        validAmount: amount !== null,
      },
      "T-Bank webhook required fields are invalid",
    );
    return reply.status(400).send("Invalid payload");
  }

  const canonicalPayload = sanitizedTbankPayload(body);
  const sortedPayload = Object.fromEntries(
    Object.entries(canonicalPayload).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const eventHash = sha256Hex(JSON.stringify(sortedPayload));

  let outcome: Awaited<ReturnType<typeof processTbankWebhookEvent>>;
  try {
    outcome = await processTbankWebhookEvent(
      db,
      {
        terminalKey: tbank.terminalKey,
        paymentId,
        orderNumber: number,
        providerStatus,
        amount,
        eventHash,
        payload: canonicalPayload,
      },
      {
        onTransition: async (client, transition) => {
          const effectPayload = {
            payment_event_id: transition.eventId,
            payment_event_hash: transition.eventHash,
            provider_status: transition.providerStatus,
          };
          if (transition.becamePaid) {
            await enqueueOrderPaidEmail(client, transition.orderId, {
              source: "tbank_webhook",
              payment_event_id: transition.eventId,
              payment_event_hash: transition.eventHash,
              provider_status: transition.providerStatus,
            });
          }
          if (transition.becamePaid && config.CDEK_CREATE_SHIPMENTS) {
            await enqueueCdekEffect(
              client,
              "cdek_create",
              transition.orderId,
              effectPayload,
            );
          }
          const stateActuallyChanged =
            transition.providerStatusApplied ||
            transition.previousOrderStatus !== transition.resultingOrderStatus ||
            transition.paymentStateConflict;
          let reviewCancellationReason:
            | "payment_state_conflict"
            | "payment_identity_conflict"
            | "amount_mismatch"
            | "partial_reversed"
            | null = null;
          const enteredPaymentReview =
            transition.resultingOrderStatus === "payment_review" &&
            transition.previousOrderStatus !== transition.resultingOrderStatus;
          if (
            transition.resultingOrderStatus === "payment_review" &&
            (transition.paymentIdentityMismatch || transition.terminalMismatch) &&
            (transition.paymentStateConflict ||
              (enteredPaymentReview &&
                ["paid", "partially_refunded", "refunded"].includes(
                  transition.previousOrderStatus,
                )))
          ) {
            reviewCancellationReason = "payment_identity_conflict";
          } else if (
            transition.resultingOrderStatus === "payment_review" &&
            transition.paymentStateConflict
          ) {
            reviewCancellationReason = "payment_state_conflict";
          } else if (
            enteredPaymentReview &&
            transition.amountMismatch &&
            ["paid", "partially_refunded"].includes(
              transition.previousOrderStatus,
            )
          ) {
            reviewCancellationReason = "amount_mismatch";
          } else if (
            enteredPaymentReview &&
            transition.providerStatus === "PARTIAL_REVERSED"
          ) {
            reviewCancellationReason = "partial_reversed";
          }
          const shouldCancelCdek =
            stateActuallyChanged &&
            ((transition.providerStatus === "REFUNDED" &&
              transition.resultingOrderStatus === "refunded") ||
              (transition.providerStatus === "REVERSED" &&
                transition.resultingOrderStatus === "payment_failed") ||
              reviewCancellationReason !== null);
          if (shouldCancelCdek) {
            await enqueueCdekEffect(
              client,
              "cdek_cancel",
              transition.orderId,
              reviewCancellationReason
                ? { ...effectPayload, reason: reviewCancellationReason }
                : effectPayload,
            );
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof TbankWebhookOrderNotFoundError) {
      return reply.status(404).send("Order not found");
    }
    if (error instanceof TbankWebhookOrderMismatchError) {
      request.log.error(
        { paymentId, orderNumber: number, providerStatus },
        "T-Bank webhook identifiers do not match a local payment attempt",
      );
      return reply.status(409).send("Payment does not match order");
    }
    throw error;
  }

  const transition = outcome.transition;
  request.log.info(
    {
      paymentId,
      orderId: transition.orderId,
      orderNumber: transition.orderNumber,
      providerStatus,
      resultingOrderStatus: transition.resultingOrderStatus,
      previousOrderStatus: transition.previousOrderStatus,
      duplicate: outcome.duplicate,
      providerStatusApplied: outcome.providerStatusApplied,
      orderStatusChanged: outcome.orderStatusChanged,
      amount,
      expectedAmount: transition.expectedAmount,
      cdekCreateShipments: config.CDEK_CREATE_SHIPMENTS,
      cdekMock: config.CDEK_MOCK,
    },
    "T-Bank webhook processed transactionally",
  );

  if (transition.amountMismatch) {
    const movedToReview =
      transition.resultingOrderStatus === "payment_review" &&
      transition.previousOrderStatus !== transition.resultingOrderStatus;
    request.log.warn(
      {
        paymentId,
        orderId: transition.orderId,
        orderNumber: transition.orderNumber,
        providerStatus,
        amount,
        expectedAmount: transition.expectedAmount,
        previousOrderStatus: transition.previousOrderStatus,
        resultingOrderStatus: transition.resultingOrderStatus,
      },
      movedToReview
        ? "T-Bank webhook amount mismatch; payment moved to review"
        : "T-Bank webhook amount mismatch audited; terminal order state preserved",
    );
  }

  if (transition.terminalMismatch) {
    request.log.warn(
      {
        paymentId,
        orderId: transition.orderId,
        orderNumber: transition.orderNumber,
        providerStatus,
        previousOrderStatus: transition.previousOrderStatus,
        resultingOrderStatus: transition.resultingOrderStatus,
      },
      "T-Bank webhook terminal boundary mismatch; payment kept unbound for review",
    );
  }

  if (transition.paymentIdentityMismatch) {
    request.log.warn(
      {
        paymentId,
        orderId: transition.orderId,
        orderNumber: transition.orderNumber,
        providerStatus,
        previousOrderStatus: transition.previousOrderStatus,
        resultingOrderStatus: transition.resultingOrderStatus,
      },
      "T-Bank webhook PaymentId boundary mismatch; payment quarantined for review",
    );
  }

  if (transition.becamePaid && !config.CDEK_CREATE_SHIPMENTS) {
    request.log.warn(
      {
        orderId: transition.orderId,
        orderNumber: transition.orderNumber,
        paymentId,
        providerStatus,
        reason: "cdek_create_shipments_disabled",
        cdekCreateShipments: config.CDEK_CREATE_SHIPMENTS,
        cdekMock: config.CDEK_MOCK,
      },
      "CDEK shipment creation skipped after paid webhook",
    );
  } else if (transition.becamePaid) {
    request.log.info(
      {
        orderId: transition.orderId,
        orderNumber: transition.orderNumber,
        paymentId,
        providerStatus,
      },
      "CDEK shipment creation queued after paid webhook",
    );
  }

  return reply.type("text/plain; charset=utf-8").send("OK");
}
