import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { cdekProfileForProduct, type CdekPackageInput } from "./cdek";

export type CartItemInput = {
  id: string;
  size: string;
  qty: number;
  offerId?: string;
};

export type ProductRow = {
  id: string;
  name: string;
  price_min: number | string | null;
  is_active: boolean;
  sizes: string[];
  offers: Array<Record<string, unknown>>;
  main_image_path: string | null;
  primary_image_url: string | null;
  product_type_slug: string | null;
  category_slug: string | null;
  source_payload: unknown;
};

export type OrderItemInput = {
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

export const MARKETING_CONSENT_VERSION = "checkout-email-marketing-v1";
export const MARKETING_CONSENT_SOURCE = "checkout";

export function marketingConsentEvidence(
  consent: boolean,
  acceptedAt: string,
) {
  return consent
    ? {
        at: acceptedAt,
        version: MARKETING_CONSENT_VERSION,
        source: MARKETING_CONSENT_SOURCE,
      }
    : { at: null, version: null, source: null };
}

export function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function normalizePhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  const normalized = digits.startsWith("8") ? `7${digits.slice(1)}` : digits;
  if (!/^7\d{10}$/.test(normalized)) {
    throw new HttpError(
      400,
      "invalid_phone",
      "Введите корректный российский номер телефона",
    );
  }
  return `+${normalized}`;
}

export function normalizeEmail(value: unknown): string {
  const email = text(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(
      400,
      "invalid_email",
      "Введите корректный email для электронного чека",
    );
  }
  return email;
}

export function randomBase64Url(bytesLength = 18): string {
  return randomBytes(bytesLength)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function orderNumber(): string {
  return `KOM-${randomInt(100_000_000, 1_000_000_000)}`;
}

export function validatedCart(value: unknown): CartItemInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new HttpError(
      400,
      "invalid_cart",
      "Корзина пуста или содержит слишком много позиций",
    );
  }

  const items = value.map((item) => {
    const raw = item as Record<string, unknown>;
    const id = text(raw.id, 36);
    const size = text(raw.size, 12).toUpperCase();
    const qty = Number(raw.qty);
    const rawOfferId = raw.offerId;
    const offerId =
      rawOfferId === undefined || rawOfferId === null
        ? undefined
        : typeof rawOfferId === "string"
          ? rawOfferId.trim()
          : "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      ) ||
      !size ||
      (rawOfferId !== undefined &&
        rawOfferId !== null &&
        (!offerId ||
          offerId.length > 120 ||
          /[\u0000-\u001f\u007f]/.test(offerId))) ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 10
    ) {
      throw new HttpError(
        400,
        "invalid_cart_item",
        "В корзине есть некорректная позиция",
      );
    }
    return { id, size, qty, ...(offerId ? { offerId } : {}) };
  });

  const units = items.reduce((sum, item) => sum + item.qty, 0);
  if (units > 50) {
    throw new HttpError(
      400,
      "too_many_units",
      "В одном заказе может быть не более 50 вещей",
    );
  }
  return items;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function legacyAmbiguousSizes(product: ProductRow): Set<string> {
  const sourcePayload = objectValue(product.source_payload);
  const checkout = objectValue(sourcePayload?.checkout);
  const sizes = checkout?.legacy_ambiguous_sizes;
  return new Set(
    (Array.isArray(sizes) ? sizes : [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
}

function selectableOfferForSize(
  offer: Record<string, unknown>,
  size: string,
): boolean {
  return (
    offer.archived !== true &&
    offer.visible !== false &&
    text(offer.size, 12).toUpperCase() === size
  );
}

function offerIdOf(offer: Record<string, unknown>): string {
  if (typeof offer.offer_id !== "string") return "";
  const offerId = offer.offer_id.trim();
  return offerId.length <= 120 ? offerId : "";
}

export function resolveCartOffer(
  product: ProductRow,
  cartItem: Pick<CartItemInput, "size" | "offerId">,
): Record<string, unknown> {
  const size = text(cartItem.size, 12).toUpperCase();
  const candidates = (product.offers ?? []).filter((offer) =>
    selectableOfferForSize(offer, size),
  );

  if (cartItem.offerId) {
    const exactMatches = candidates.filter(
      (offer) => offerIdOf(offer) === cartItem.offerId,
    );
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) {
      throw new HttpError(
        409,
        "ambiguous_offer",
        `Вариант размера ${size} товара «${product.name}» определён неоднозначно`,
      );
    }
    throw new HttpError(
      409,
      "offer_unavailable",
      `Выбранный вариант размера ${size} товара «${product.name}» больше недоступен`,
    );
  }

  if (legacyAmbiguousSizes(product).has(size) || candidates.length > 1) {
    throw new HttpError(
      409,
      "ambiguous_offer",
      `Выберите вариант товара «${product.name}» заново`,
    );
  }
  if (candidates.length === 0 || !offerIdOf(candidates[0])) {
    throw new HttpError(
      409,
      "offer_unavailable",
      `Вариант размера ${size} товара «${product.name}» больше недоступен`,
    );
  }
  return candidates[0];
}

export class CheckoutRepository {
  constructor(private readonly db: Db) {}

  async productsForCart(cart: CartItemInput[]) {
    const productIds = [...new Set(cart.map((item) => item.id))];
    const result = await this.db.query<ProductRow>(
      `
        select
          id,
          name,
          price_min,
          is_active,
          sizes,
          offers,
          main_image_path,
          primary_image_url,
          product_type_slug,
          category_slug,
          source_payload
        from public.merch_storefront_products
        where id = any($1::uuid[])
          and is_active is true
      `,
      [productIds],
    );

    return new Map(result.rows.map((product) => [product.id, product]));
  }

  async orderItemsFromCart(cart: CartItemInput[]) {
    const productMap = await this.productsForCart(cart);
    return cart.map((cartItem): OrderItemInput => {
      const product = productMap.get(cartItem.id);
      if (!product) {
        throw new HttpError(
          400,
          "product_unavailable",
          "Один из товаров больше недоступен",
        );
      }
      if (!(product.sizes ?? []).map(String).includes(cartItem.size)) {
        throw new HttpError(
          400,
          "size_unavailable",
          `Размер ${cartItem.size} товара «${product.name}» недоступен`,
        );
      }

      const offer = resolveCartOffer(product, cartItem);
      const offerPriceRub = Number(offer.price);
      const productPriceRub = Number(product.price_min);
      const priceRub =
        Number.isFinite(offerPriceRub) && offerPriceRub > 0
          ? offerPriceRub
          : productPriceRub;
      if (!Number.isFinite(priceRub) || priceRub <= 0) {
        throw new HttpError(
          400,
          "price_missing",
          `Для товара «${product.name}» не задана цена`,
        );
      }

      const unitPrice = Math.round(priceRub * 100);
      const offerId = offerIdOf(offer);
      const cdekProfile = cdekProfileForProduct(product);

      return {
        product_id: product.id,
        offer_id: offerId,
        sku: text(offer.sku, 120) || null,
        product_name: product.name.slice(0, 128),
        size: cartItem.size,
        quantity: cartItem.qty,
        unit_price_amount: unitPrice,
        line_total_amount: unitPrice * cartItem.qty,
        image_url: product.main_image_path ?? product.primary_image_url,
        product_snapshot: {
          storefront_product_id: product.id,
          offer_id: offerId,
          sku: offer.sku ?? null,
          product_type_slug: product.product_type_slug,
          category_slug: product.category_slug,
          cdek_profile: cdekProfile.key,
          cdek_package_profile: cdekProfile,
        },
      };
    });
  }
}

export function subtotalAmount(items: OrderItemInput[]) {
  return items.reduce((sum, item) => sum + item.line_total_amount, 0);
}

export function cdekPackageInputsFromOrderItems(
  items: OrderItemInput[],
): CdekPackageInput[] {
  return items.map((item) => ({
    productId: item.product_id,
    offerId: item.offer_id,
    sku: item.sku,
    productName: item.product_name,
    size: item.size,
    quantity: item.quantity,
    unitPriceAmount: item.unit_price_amount,
    productTypeSlug: text(item.product_snapshot.product_type_slug, 80),
    categorySlug: text(item.product_snapshot.category_slug, 80),
    profileKey: text(item.product_snapshot.cdek_profile, 40),
  }));
}

export function validateClientIdentity(
  clientRequestId: unknown,
  accessToken: unknown,
) {
  const requestId = text(clientRequestId, 36);
  const token = text(accessToken, 128);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    ) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(token)
  ) {
    throw new HttpError(
      400,
      "invalid_client_identity",
      "Не удалось создать безопасный идентификатор заказа",
    );
  }
  return { clientRequestId: requestId || randomUUID(), accessToken: token };
}
