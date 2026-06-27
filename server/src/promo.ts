import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { Db } from "./db";
import { sha256Hex } from "./crypto";
import { HttpError } from "./errors";

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
};

type PromoRow = {
  id: string;
  code: string;
  code_normalized: string;
  name: string;
  is_active: boolean;
  discount_type: "percent" | "fixed_amount" | "free_delivery";
  discount_value: number;
  max_discount_amount: number | null;
  min_subtotal_amount: number;
  starts_at: string | null;
  ends_at: string | null;
  global_usage_limit: number | null;
  per_phone_limit: number | null;
  metadata: Record<string, unknown> | null;
};

export type PromoValidation = {
  valid: boolean;
  code: string | null;
  promoCodeId: string | null;
  name: string | null;
  discountType: "percent" | "fixed_amount" | "free_delivery" | null;
  discountAmount: number;
  deliveryDiscountAmount: number;
  totalDiscountAmount: number;
  chargedDeliveryAmount: number;
  message: string;
  startsAt: string | null;
  endsAt: string | null;
  metadata: Record<string, unknown> | null;
};

const activeUsageStatuses = ["reserved", "redeemed"];

export function normalizePromoCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 32);
}

export function promoPhoneHash(phone: string): string {
  return sha256Hex(phone.replace(/\D/g, ""));
}

function invalidPromo(code: string, message = "Промокод не найден"): PromoValidation {
  return {
    valid: false,
    code: code || null,
    promoCodeId: null,
    name: null,
    discountType: null,
    discountAmount: 0,
    deliveryDiscountAmount: 0,
    totalDiscountAmount: 0,
    chargedDeliveryAmount: 0,
    message,
    startsAt: null,
    endsAt: null,
    metadata: null,
  };
}

function nowBetween(now: Date, startsAt: string | null, endsAt: string | null) {
  if (startsAt && now < new Date(startsAt)) return false;
  if (endsAt && now >= new Date(endsAt)) return false;
  return true;
}

export function calculateDiscount(
  promo: Pick<
    PromoRow,
    "discount_type" | "discount_value" | "max_discount_amount"
  >,
  subtotalAmount: number,
  deliveryAmount: number,
) {
  let discountAmount = 0;
  let deliveryDiscountAmount = 0;

  if (promo.discount_type === "percent") {
    discountAmount = Math.round((subtotalAmount * promo.discount_value) / 10_000);
  } else if (promo.discount_type === "fixed_amount") {
    discountAmount = promo.discount_value;
  } else if (promo.discount_type === "free_delivery") {
    deliveryDiscountAmount = deliveryAmount;
  }

  if (promo.max_discount_amount !== null) {
    if (promo.discount_type === "free_delivery") {
      deliveryDiscountAmount = Math.min(
        deliveryDiscountAmount,
        promo.max_discount_amount,
      );
    } else {
      discountAmount = Math.min(discountAmount, promo.max_discount_amount);
    }
  }

  discountAmount = Math.max(0, Math.min(discountAmount, subtotalAmount));
  deliveryDiscountAmount = Math.max(
    0,
    Math.min(deliveryDiscountAmount, deliveryAmount),
  );

  return {
    discountAmount,
    deliveryDiscountAmount,
    totalDiscountAmount: discountAmount + deliveryDiscountAmount,
    chargedDeliveryAmount: Math.max(0, deliveryAmount - deliveryDiscountAmount),
  };
}

async function usageCount(
  db: Queryable,
  promoCodeId: string,
  customerPhoneHash?: string | null,
) {
  const values: unknown[] = [promoCodeId, activeUsageStatuses];
  let phoneFilter = "";
  if (customerPhoneHash) {
    values.push(customerPhoneHash);
    phoneFilter = "and customer_phone_hash = $3";
  }

  const result = await db.query<{ count: string }>(
    `
      select count(*)::text as count
      from public.merch_promo_redemptions
      where promo_code_id = $1::uuid
        and status = any($2::text[])
        ${phoneFilter}
    `,
    values,
  );

  return Number(result.rows[0]?.count ?? 0);
}

export async function validatePromoCode(
  db: Queryable,
  options: {
    code: unknown;
    subtotalAmount: number;
    deliveryAmount?: number;
    customerPhoneHash?: string | null;
    now?: Date;
  },
): Promise<PromoValidation> {
  const code = normalizePromoCode(options.code);
  if (!code) return invalidPromo("", "Введите промокод");

  const subtotalAmount = Math.max(0, Math.round(Number(options.subtotalAmount) || 0));
  const deliveryAmount = Math.max(0, Math.round(Number(options.deliveryAmount) || 0));
  const now = options.now ?? new Date();

  const result = await db.query<PromoRow>(
    `
      select *
      from public.merch_promo_codes
      where code_normalized = $1
      limit 1
    `,
    [code],
  );
  const promo = result.rows[0];
  if (!promo) return invalidPromo(code);
  if (!promo.is_active) return invalidPromo(code, "Промокод отключён");
  if (!nowBetween(now, promo.starts_at, promo.ends_at)) {
    return invalidPromo(code, "Срок действия промокода истёк");
  }
  if (subtotalAmount < promo.min_subtotal_amount) {
    return invalidPromo(
      code,
      `Промокод действует от ${(promo.min_subtotal_amount / 100).toLocaleString("ru-RU")} ₽`,
    );
  }

  if (promo.global_usage_limit !== null) {
    const used = await usageCount(db, promo.id);
    if (used >= promo.global_usage_limit) {
      return invalidPromo(code, "Лимит промокода исчерпан");
    }
  }

  if (promo.per_phone_limit !== null && options.customerPhoneHash) {
    const usedByPhone = await usageCount(db, promo.id, options.customerPhoneHash);
    if (usedByPhone >= promo.per_phone_limit) {
      return invalidPromo(code, "Промокод уже использован для этого номера");
    }
  }

  const discount = calculateDiscount(promo, subtotalAmount, deliveryAmount);
  const hasDiscount =
    discount.totalDiscountAmount > 0 || promo.discount_type === "free_delivery";
  if (!hasDiscount) {
    return invalidPromo(code, "Промокод не даёт скидку для этого заказа");
  }

  return {
    valid: true,
    code: promo.code_normalized,
    promoCodeId: promo.id,
    name: promo.name,
    discountType: promo.discount_type,
    discountAmount: discount.discountAmount,
    deliveryDiscountAmount: discount.deliveryDiscountAmount,
    totalDiscountAmount: discount.totalDiscountAmount,
    chargedDeliveryAmount: discount.chargedDeliveryAmount,
    message:
      discount.totalDiscountAmount > 0
        ? "Промокод применён"
        : "Промокод применится после выбора доставки",
    startsAt: promo.starts_at,
    endsAt: promo.ends_at,
    metadata: promo.metadata ?? null,
  };
}

export async function reservePromoRedemption(
  db: Queryable,
  options: {
    validation: PromoValidation;
    orderId: string;
    orderNumber: string;
    clientRequestId: string;
    customerPhoneHash: string;
    subtotalAmount: number;
    deliveryAmount: number;
  },
) {
  if (!options.validation.valid || !options.validation.promoCodeId) return;

  await db.query(
    `
      insert into public.merch_promo_redemptions (
        promo_code_id,
        order_id,
        order_number,
        client_request_id,
        customer_phone_hash,
        status,
        subtotal_amount,
        delivery_amount,
        delivery_discount_amount,
        discount_amount,
        reserved_until,
        redeemed_at,
        released_at
      )
      values (
        $1::uuid,
        $2::uuid,
        $3,
        $4::uuid,
        $5,
        'reserved',
        $6,
        $7,
        $8,
        $9,
        now() + interval '1 hour',
        null,
        null
      )
      on conflict (order_id) do update
      set
        promo_code_id = excluded.promo_code_id,
        order_number = excluded.order_number,
        client_request_id = excluded.client_request_id,
        customer_phone_hash = excluded.customer_phone_hash,
        status = 'reserved',
        subtotal_amount = excluded.subtotal_amount,
        delivery_amount = excluded.delivery_amount,
        delivery_discount_amount = excluded.delivery_discount_amount,
        discount_amount = excluded.discount_amount,
        reserved_until = excluded.reserved_until,
        redeemed_at = null,
        released_at = null,
        updated_at = now()
    `,
    [
      options.validation.promoCodeId,
      options.orderId,
      options.orderNumber,
      options.clientRequestId,
      options.customerPhoneHash,
      options.subtotalAmount,
      options.deliveryAmount,
      options.validation.deliveryDiscountAmount,
      options.validation.discountAmount,
    ],
  );
}

export async function markPromoRedemptionRedeemed(
  db: Queryable,
  orderId: string,
) {
  await db.query(
    `
      update public.merch_promo_redemptions
      set status = 'redeemed',
          redeemed_at = now(),
          released_at = null,
          updated_at = now()
      where order_id = $1::uuid
        and status = any($2::text[])
    `,
    [orderId, ["reserved", "redeemed"]],
  );
}

export async function releasePromoRedemption(
  db: Queryable,
  orderId: string,
  status: "released" | "expired" | "canceled" = "released",
) {
  if (!["released", "expired", "canceled"].includes(status)) {
    throw new HttpError(400, "invalid_promo_release_status", "Invalid promo status");
  }

  await db.query(
    `
      update public.merch_promo_redemptions
      set status = $2,
          released_at = now(),
          updated_at = now()
      where order_id = $1::uuid
        and status = 'reserved'
    `,
    [orderId, status],
  );
}
