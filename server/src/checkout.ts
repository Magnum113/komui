import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { cdekProfileForProduct, type CdekPackageInput } from "./cdek";

export type CartItemInput = {
  id: string;
  size: string;
  qty: number;
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
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      ) ||
      !size ||
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
    return { id, size, qty };
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

function offerForSize(
  product: ProductRow,
  size: string,
): Record<string, unknown> | null {
  return (
    (product.offers ?? []).find(
      (offer) => String(offer.size ?? "").toUpperCase() === size,
    ) ?? null
  );
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
          category_slug
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

      const priceRub = Number(product.price_min);
      if (!Number.isFinite(priceRub) || priceRub <= 0) {
        throw new HttpError(
          400,
          "price_missing",
          `Для товара «${product.name}» не задана цена`,
        );
      }

      const unitPrice = Math.round(priceRub * 100);
      const offer = offerForSize(product, cartItem.size);
      const cdekProfile = cdekProfileForProduct(product);

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
