export type CartItemInput = {
  id: string;
  size: string;
  qty: number;
  offerId?: string;
};

export type CheckoutProductRow = {
  id: string;
  name: string;
  price_min: number | string | null;
  is_active: boolean;
  sizes: string[];
  offers: Array<Record<string, unknown>>;
  source_payload?: unknown;
};

export type ResolvedCartItem<
  T extends CheckoutProductRow = CheckoutProductRow,
> = {
  cartItem: CartItemInput;
  product: T;
  offer: Record<string, unknown>;
  offerId: string;
  sku: string | null;
  unitPriceAmount: number;
  lineTotalAmount: number;
};

export class CheckoutCartError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutCartError";
  }
}

export function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function validatedCart(value: unknown): CartItemInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new CheckoutCartError(
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
    const offerId = rawOfferId === undefined || rawOfferId === null
      ? undefined
      : typeof rawOfferId === "string"
      ? rawOfferId.trim()
      : "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(id) ||
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
      throw new CheckoutCartError(
        400,
        "invalid_cart_item",
        "В корзине есть некорректная позиция",
      );
    }
    return { id, size, qty, ...(offerId ? { offerId } : {}) };
  });

  const units = items.reduce((sum, item) => sum + item.qty, 0);
  if (units > 50) {
    throw new CheckoutCartError(
      400,
      "too_many_units",
      "В одном заказе может быть не более 50 вещей",
    );
  }
  return items;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function legacyAmbiguousSizes(product: CheckoutProductRow): Set<string> {
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
  return offer.archived !== true &&
    offer.visible !== false &&
    text(offer.size, 12).toUpperCase() === size;
}

function offerIdOf(offer: Record<string, unknown>): string {
  if (typeof offer.offer_id !== "string") return "";
  const offerId = offer.offer_id.trim();
  return offerId.length <= 120 ? offerId : "";
}

export function resolveCartOffer(
  product: CheckoutProductRow,
  cartItem: Pick<CartItemInput, "size" | "offerId">,
): Record<string, unknown> {
  const size = text(cartItem.size, 12).toUpperCase();
  const candidates = (Array.isArray(product.offers) ? product.offers : [])
    .filter((offer): offer is Record<string, unknown> =>
      Boolean(offer) && typeof offer === "object" && !Array.isArray(offer)
    )
    .filter((offer) => selectableOfferForSize(offer, size));

  if (cartItem.offerId) {
    const exactMatches = candidates.filter((offer) =>
      offerIdOf(offer) === cartItem.offerId
    );
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) {
      throw new CheckoutCartError(
        409,
        "ambiguous_offer",
        `Вариант размера ${size} товара «${product.name}» определён неоднозначно`,
      );
    }
    throw new CheckoutCartError(
      409,
      "offer_unavailable",
      `Выбранный вариант размера ${size} товара «${product.name}» больше недоступен`,
    );
  }

  if (legacyAmbiguousSizes(product).has(size) || candidates.length > 1) {
    throw new CheckoutCartError(
      409,
      "ambiguous_offer",
      `Выберите вариант товара «${product.name}» заново`,
    );
  }
  if (candidates.length === 0 || !offerIdOf(candidates[0])) {
    throw new CheckoutCartError(
      409,
      "offer_unavailable",
      `Вариант размера ${size} товара «${product.name}» больше недоступен`,
    );
  }
  return candidates[0];
}

export function resolveCartItems<T extends CheckoutProductRow>(
  cart: CartItemInput[],
  products: T[],
): ResolvedCartItem<T>[] {
  const productMap = new Map(products.map((product) => [product.id, product]));
  return cart.map((cartItem) => {
    const product = productMap.get(cartItem.id);
    if (!product || product.is_active !== true) {
      throw new CheckoutCartError(
        400,
        "product_unavailable",
        "Один из товаров больше недоступен",
      );
    }
    if (
      !(product.sizes ?? []).map((size) => String(size).toUpperCase()).includes(
        cartItem.size,
      )
    ) {
      throw new CheckoutCartError(
        400,
        "size_unavailable",
        `Размер ${cartItem.size} товара «${product.name}» недоступен`,
      );
    }

    const offer = resolveCartOffer(product, cartItem);
    const offerPriceRub = Number(offer.price);
    const productPriceRub = Number(product.price_min);
    const priceRub = Number.isFinite(offerPriceRub) && offerPriceRub > 0
      ? offerPriceRub
      : productPriceRub;
    if (!Number.isFinite(priceRub) || priceRub <= 0) {
      throw new CheckoutCartError(
        400,
        "price_missing",
        `Для товара «${product.name}» не задана цена`,
      );
    }

    const offerId = offerIdOf(offer);
    const unitPriceAmount = Math.round(priceRub * 100);
    return {
      cartItem,
      product,
      offer,
      offerId,
      sku: text(offer.sku, 120) || null,
      unitPriceAmount,
      lineTotalAmount: unitPriceAmount * cartItem.qty,
    };
  });
}
