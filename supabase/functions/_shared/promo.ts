import { sha256Hex } from "./tbank.ts";

type AdminClient = {
  from: (table: string) => any;
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
  return String(value ?? "").trim().replace(/\s+/g, "").toUpperCase().slice(0, 32);
}

export async function promoPhoneHash(phone: string): Promise<string> {
  return await sha256Hex(phone.replace(/\D/g, ""));
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

function nowBetween(now: Date, startsAt: string | null, endsAt: string | null): boolean {
  if (startsAt && now < new Date(startsAt)) return false;
  if (endsAt && now >= new Date(endsAt)) return false;
  return true;
}

function calculateDiscount(
  promo: PromoRow,
  subtotalAmount: number,
  deliveryAmount: number,
): Pick<PromoValidation, "discountAmount" | "deliveryDiscountAmount" | "totalDiscountAmount" | "chargedDeliveryAmount"> {
  let discountAmount = 0;
  let deliveryDiscountAmount = 0;

  if (promo.discount_type === "percent") {
    discountAmount = Math.round((subtotalAmount * promo.discount_value) / 10000);
  } else if (promo.discount_type === "fixed_amount") {
    discountAmount = promo.discount_value;
  } else if (promo.discount_type === "free_delivery") {
    deliveryDiscountAmount = deliveryAmount;
  }

  if (promo.max_discount_amount !== null) {
    if (promo.discount_type === "free_delivery") {
      deliveryDiscountAmount = Math.min(deliveryDiscountAmount, promo.max_discount_amount);
    } else {
      discountAmount = Math.min(discountAmount, promo.max_discount_amount);
    }
  }

  discountAmount = Math.max(0, Math.min(discountAmount, subtotalAmount));
  deliveryDiscountAmount = Math.max(0, Math.min(deliveryDiscountAmount, deliveryAmount));

  return {
    discountAmount,
    deliveryDiscountAmount,
    totalDiscountAmount: discountAmount + deliveryDiscountAmount,
    chargedDeliveryAmount: Math.max(0, deliveryAmount - deliveryDiscountAmount),
  };
}

async function usageCount(
  admin: AdminClient,
  promoCodeId: string,
  customerPhoneHash?: string | null,
): Promise<number> {
  let query = admin
    .from("merch_promo_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("promo_code_id", promoCodeId)
    .in("status", activeUsageStatuses);

  if (customerPhoneHash) {
    query = query.eq("customer_phone_hash", customerPhoneHash);
  }

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function validatePromoCode(
  admin: AdminClient,
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

  const { data, error } = await admin
    .from("merch_promo_codes")
    .select("*")
    .eq("code_normalized", code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return invalidPromo(code);

  const promo = data as PromoRow;
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
    const used = await usageCount(admin, promo.id);
    if (used >= promo.global_usage_limit) {
      return invalidPromo(code, "Лимит промокода исчерпан");
    }
  }

  if (promo.per_phone_limit !== null && options.customerPhoneHash) {
    const usedByPhone = await usageCount(admin, promo.id, options.customerPhoneHash);
    if (usedByPhone >= promo.per_phone_limit) {
      return invalidPromo(code, "Промокод уже использован для этого номера");
    }
  }

  const discount = calculateDiscount(promo, subtotalAmount, deliveryAmount);
  const hasDiscount = discount.totalDiscountAmount > 0 || promo.discount_type === "free_delivery";
  if (!hasDiscount) return invalidPromo(code, "Промокод не даёт скидку для этого заказа");

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
    message: discount.totalDiscountAmount > 0
      ? "Промокод применён"
      : "Промокод применится после выбора доставки",
    startsAt: promo.starts_at,
    endsAt: promo.ends_at,
    metadata: promo.metadata ?? null,
  };
}

export async function reservePromoRedemption(
  admin: AdminClient,
  options: {
    validation: PromoValidation;
    orderId: string;
    orderNumber: string;
    clientRequestId: string;
    customerPhoneHash: string;
    subtotalAmount: number;
    deliveryAmount: number;
  },
): Promise<void> {
  if (!options.validation.valid || !options.validation.promoCodeId) return;

  const { error } = await admin.from("merch_promo_redemptions").upsert({
    promo_code_id: options.validation.promoCodeId,
    order_id: options.orderId,
    order_number: options.orderNumber,
    client_request_id: options.clientRequestId,
    customer_phone_hash: options.customerPhoneHash,
    status: "reserved",
    subtotal_amount: options.subtotalAmount,
    delivery_amount: options.deliveryAmount,
    delivery_discount_amount: options.validation.deliveryDiscountAmount,
    discount_amount: options.validation.discountAmount,
    reserved_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    redeemed_at: null,
    released_at: null,
  }, { onConflict: "order_id" });

  if (error) throw error;
}

export async function markPromoRedemptionRedeemed(
  admin: AdminClient,
  orderId: string,
): Promise<void> {
  const { error } = await admin.from("merch_promo_redemptions").update({
    status: "redeemed",
    redeemed_at: new Date().toISOString(),
    released_at: null,
  }).eq("order_id", orderId).in("status", ["reserved", "redeemed"]);
  if (error) throw error;
}

export async function releasePromoRedemption(
  admin: AdminClient,
  orderId: string,
  status: "released" | "expired" | "canceled" = "released",
): Promise<void> {
  const { error } = await admin.from("merch_promo_redemptions").update({
    status,
    released_at: new Date().toISOString(),
  }).eq("order_id", orderId).eq("status", "reserved");
  if (error) throw error;
}
