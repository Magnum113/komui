import type { YandexFeedProduct } from "./catalog";
import {
  mediaMetadataForPublicUrl,
  type PublicMediaMetadata,
} from "./mediaManifest";

const MAX_OFFER_ID_LENGTH = 100;
const MIN_IMAGE_SIDE = 450;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PICTURES = 5;
const ALLOWED_IMAGE_FORMATS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

type FeedCategory = {
  id: string;
  name: string;
  slug?: string;
  parentId?: string;
};

type FeedCollection = {
  id: string;
  name: string;
  slug: string;
  titleSlug: string;
};

type PreparedOffer = {
  product: YandexFeedProduct;
  categoryId: string;
  pictures: string[];
  price: number;
  oldPrice?: number;
  sizes: string[];
  collectionId?: string;
};

export type YandexDirectFeedIssue = {
  code: string;
  message: string;
  productId?: string;
  slug?: string;
};

export type YandexDirectFeedOptions = {
  siteUrl: string;
  generatedAt?: Date;
  timeZone?: string;
  mediaMetadata?: (url: string) => PublicMediaMetadata | undefined;
};

export class YandexDirectFeedError extends Error {
  constructor(public readonly issues: YandexDirectFeedIssue[]) {
    super(`Yandex Direct feed validation failed with ${issues.length} issue(s)`);
    this.name = "YandexDirectFeedError";
  }
}

export const YANDEX_FEED_CATEGORIES: readonly FeedCategory[] = [
  { id: "1", name: "Одежда" },
  { id: "101", name: "Футболки", slug: "tshirts", parentId: "1" },
  { id: "102", name: "Худи", slug: "hoodies", parentId: "1" },
  { id: "103", name: "Свитшоты", slug: "sweatshirts", parentId: "1" },
];

export const YANDEX_FEED_COLLECTIONS: readonly FeedCollection[] = [
  { id: "naruto", name: "Naruto", slug: "naruto", titleSlug: "naruto" },
  {
    id: "jujutsu-kaisen",
    name: "Jujutsu Kaisen",
    slug: "jujutsu-kaisen",
    titleSlug: "jujutsu-kaisen",
  },
  {
    id: "gravity",
    name: "Gravity",
    slug: "gravity",
    titleSlug: "gravity",
  },
  {
    id: "grand-theft-auto",
    name: "Grand Theft Auto",
    slug: "grand-theft-auto",
    titleSlug: "grand-theft-auto",
  },
];

const CATEGORY_ID_BY_SLUG = new Map(
  YANDEX_FEED_CATEGORIES.filter((category) => category.slug).map((category) => [
    category.slug as string,
    category.id,
  ]),
);
const CATEGORY_ID_BY_NAME = new Map(
  YANDEX_FEED_CATEGORIES.map((category) => [category.name.toLowerCase(), category.id]),
);
const COLLECTION_BY_TITLE_SLUG = new Map(
  YANDEX_FEED_COLLECTIONS.map((collection) => [collection.titleSlug, collection]),
);

function validXmlString(value: unknown) {
  let result = "";
  for (const character of String(value ?? "")) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      result += character;
    }
  }
  return result;
}

export function escapeYml(value: unknown) {
  return validXmlString(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plainText(value: unknown) {
  return validXmlString(value).replace(/\s+/g, " ").trim();
}

function uniqueText(values: unknown[]) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = plainText(value);
    if (!normalized) continue;
    const key = normalized.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeSiteOrigin(siteUrl: string) {
  const parsed = new URL(siteUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Yandex Direct feed site URL must use HTTP or HTTPS");
  }
  return parsed.origin;
}

function absoluteUrl(origin: string, value: string) {
  return new URL(value, `${origin}/`).toString();
}

function imageFormat(url: string, metadata: PublicMediaMetadata) {
  const fromMetadata = plainText(metadata.format).toLowerCase();
  if (fromMetadata) return fromMetadata === "jpeg" ? "jpg" : fromMetadata;
  const pathname = new URL(url).pathname;
  const extension = pathname.split(".").at(-1)?.toLowerCase() || "";
  return extension === "jpeg" ? "jpg" : extension;
}

function productPictures(
  product: YandexFeedProduct,
  origin: string,
  metadataForUrl: (url: string) => PublicMediaMetadata | undefined,
) {
  const candidates = uniqueText([
    product.primary_image_url,
    product.main_image_path,
    ...product.image_urls,
  ]);
  const pictures: string[] = [];

  for (const candidate of candidates) {
    let url: string;
    try {
      url = absoluteUrl(origin, candidate);
    } catch {
      continue;
    }

    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

    const metadata = metadataForUrl(candidate) ?? metadataForUrl(url);
    if (!metadata) continue;
    if (
      !Number.isFinite(metadata.width) ||
      !Number.isFinite(metadata.height) ||
      Number(metadata.width) < MIN_IMAGE_SIDE ||
      Number(metadata.height) < MIN_IMAGE_SIDE
    ) {
      continue;
    }
    if (
      metadata.bytes !== undefined &&
      (!Number.isFinite(metadata.bytes) || metadata.bytes > MAX_IMAGE_BYTES)
    ) {
      continue;
    }
    if (!ALLOWED_IMAGE_FORMATS.has(imageFormat(url, metadata))) continue;

    pictures.push(url);
    if (pictures.length === MAX_PICTURES) break;
  }

  return pictures;
}

function formatPrice(value: number) {
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function formatYmlDate(date: Date, timeZone = "Europe/Moscow") {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid feed generation date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function categoryIdForProduct(product: YandexFeedProduct) {
  return (
    CATEGORY_ID_BY_SLUG.get(plainText(product.category_slug).toLowerCase()) ||
    CATEGORY_ID_BY_NAME.get(plainText(product.category).toLowerCase())
  );
}

function collectionForProduct(product: YandexFeedProduct) {
  return COLLECTION_BY_TITLE_SLUG.get(
    plainText(product.title_slug).toLowerCase(),
  );
}

function productDescription(product: YandexFeedProduct, sizes: string[]) {
  const sentences: string[] = [];
  const productType = plainText(product.product_type || product.category);
  const color = plainText(product.color_name);
  const decoration = plainText(product.decoration_type);
  const title = plainText(product.title_name || product.collection_name);

  if (productType) sentences.push(`${productType}.`);
  if (color) sentences.push(`Цвет: ${color}.`);
  if (decoration) sentences.push(`Тип нанесения: ${decoration}.`);
  if (title) sentences.push(`Тематика: ${title}.`);
  if (sizes.length) sentences.push(`Размеры: ${sizes.join(", ")}.`);

  return sentences.join(" ");
}

function offerIssue(
  product: YandexFeedProduct,
  code: string,
  message: string,
): YandexDirectFeedIssue {
  return {
    code,
    message,
    productId: plainText(product.id),
    slug: plainText(product.slug),
  };
}

function prepareOffers(
  products: YandexFeedProduct[],
  origin: string,
  metadataForUrl: (url: string) => PublicMediaMetadata | undefined,
) {
  const offers: PreparedOffer[] = [];
  const issues: YandexDirectFeedIssue[] = [];
  const seenIds = new Set<string>();

  for (const product of products) {
    if (!product.is_active) continue;

    const id = plainText(product.id);
    const name = plainText(product.name);
    const slug = plainText(product.slug);
    const price = Number(product.price_min);
    const currency = plainText(product.currency).toUpperCase();
    const categoryId = categoryIdForProduct(product);
    const pictures = productPictures(product, origin, metadataForUrl);
    const sizes = uniqueText(product.sizes);

    if (!id || id.length > MAX_OFFER_ID_LENGTH) {
      issues.push(
        offerIssue(product, "invalid_offer_id", "Product ID is empty or longer than 100 characters"),
      );
    } else if (seenIds.has(id)) {
      issues.push(offerIssue(product, "duplicate_offer_id", "Product ID is not unique"));
    } else {
      seenIds.add(id);
    }
    if (!name) {
      issues.push(offerIssue(product, "missing_name", "Product name is required"));
    }
    if (!slug) {
      issues.push(offerIssue(product, "missing_slug", "Product slug is required"));
    }
    if (!Number.isFinite(price) || price <= 0) {
      issues.push(offerIssue(product, "invalid_price", "Product price must be positive"));
    }
    if (currency !== "RUB" && currency !== "RUR") {
      issues.push(offerIssue(product, "invalid_currency", "Product currency must be RUB"));
    }
    if (!categoryId) {
      issues.push(offerIssue(product, "unknown_category", "Product category is not mapped"));
    }
    if (!pictures.length) {
      issues.push(
        offerIssue(product, "missing_picture", "Product has no Yandex-compatible picture"),
      );
    }

    if (
      id &&
      id.length <= MAX_OFFER_ID_LENGTH &&
      name &&
      slug &&
      Number.isFinite(price) &&
      price > 0 &&
      (currency === "RUB" || currency === "RUR") &&
      categoryId &&
      pictures.length
    ) {
      const compareAt = Number(product.compare_at_price);
      offers.push({
        product,
        categoryId,
        pictures,
        price,
        oldPrice:
          Number.isFinite(compareAt) && compareAt > price ? compareAt : undefined,
        sizes,
        collectionId: collectionForProduct(product)?.id,
      });
    }
  }

  if (!offers.length && !issues.length) {
    issues.push({
      code: "empty_feed",
      message: "No active storefront products were found",
    });
  }
  if (issues.length) throw new YandexDirectFeedError(issues);
  return offers;
}

function renderCategories(lines: string[]) {
  lines.push("    <categories>");
  for (const category of YANDEX_FEED_CATEGORIES) {
    const parent = category.parentId
      ? ` parentId="${escapeYml(category.parentId)}"`
      : "";
    lines.push(
      `      <category id="${escapeYml(category.id)}"${parent}>${escapeYml(category.name)}</category>`,
    );
  }
  lines.push("    </categories>");
}

function renderOffer(lines: string[], offer: PreparedOffer, origin: string) {
  const product = offer.product;
  const name = plainText(product.name);
  const model = plainText(
    product.design_name || product.collection_name || product.title_name || name,
  );
  const productType = plainText(product.product_type || product.category);
  const productUrl = absoluteUrl(origin, `/p/${encodeURIComponent(plainText(product.slug))}`);

  lines.push(
    `      <offer id="${escapeYml(product.id)}" type="vendor.model" available="true">`,
  );
  lines.push(`        <url>${escapeYml(productUrl)}</url>`);
  lines.push(`        <price>${formatPrice(offer.price)}</price>`);
  if (offer.oldPrice !== undefined) {
    lines.push(`        <oldprice>${formatPrice(offer.oldPrice)}</oldprice>`);
  }
  lines.push("        <currencyId>RUB</currencyId>");
  lines.push(`        <categoryId>${escapeYml(offer.categoryId)}</categoryId>`);
  for (const picture of offer.pictures) {
    lines.push(`        <picture>${escapeYml(picture)}</picture>`);
  }
  lines.push("        <store>false</store>");
  lines.push("        <pickup>true</pickup>");
  lines.push("        <delivery>false</delivery>");
  lines.push(`        <name>${escapeYml(name)}</name>`);
  lines.push(`        <typePrefix>${escapeYml(productType)}</typePrefix>`);
  lines.push("        <vendor>KOMUI</vendor>");
  lines.push(`        <model>${escapeYml(model)}</model>`);
  lines.push(
    `        <description>${escapeYml(productDescription(product, offer.sizes))}</description>`,
  );
  if (product.color_name) {
    lines.push(
      `        <param name="Цвет">${escapeYml(plainText(product.color_name))}</param>`,
    );
  }
  for (const size of offer.sizes) {
    lines.push(
      `        <param name="Размер" unit="INT">${escapeYml(size)}</param>`,
    );
  }
  if (product.decoration_type) {
    lines.push(
      `        <param name="Тип нанесения">${escapeYml(plainText(product.decoration_type))}</param>`,
    );
  }
  if (offer.collectionId) {
    lines.push(
      `        <collectionId>${escapeYml(offer.collectionId)}</collectionId>`,
    );
  }
  lines.push("      </offer>");
}

function renderCollections(
  lines: string[],
  offers: PreparedOffer[],
  origin: string,
) {
  const usedCollections = new Map<string, { collection: FeedCollection; picture: string }>();
  for (const offer of offers) {
    if (!offer.collectionId || usedCollections.has(offer.collectionId)) continue;
    const collection = YANDEX_FEED_COLLECTIONS.find(
      (item) => item.id === offer.collectionId,
    );
    if (collection && offer.pictures[0]) {
      usedCollections.set(collection.id, {
        collection,
        picture: offer.pictures[0],
      });
    }
  }
  if (!usedCollections.size) return;

  lines.push("    <collections>");
  for (const { collection, picture } of usedCollections.values()) {
    lines.push(`      <collection id="${escapeYml(collection.id)}">`);
    lines.push(
      `        <url>${escapeYml(absoluteUrl(origin, `/collections/${collection.slug}`))}</url>`,
    );
    lines.push(`        <picture>${escapeYml(picture)}</picture>`);
    lines.push(`        <name>${escapeYml(collection.name)}</name>`);
    lines.push(
      `        <description>${escapeYml(`Товары KOMUI в тематике ${collection.name}.`)}</description>`,
    );
    lines.push("      </collection>");
  }
  lines.push("    </collections>");
}

export function buildYandexDirectFeed(
  products: YandexFeedProduct[],
  options: YandexDirectFeedOptions,
) {
  const origin = normalizeSiteOrigin(options.siteUrl);
  const generatedAt = options.generatedAt ?? new Date();
  const metadataForUrl = options.mediaMetadata ?? mediaMetadataForPublicUrl;
  const offers = prepareOffers(products, origin, metadataForUrl);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<yml_catalog date="${escapeYml(formatYmlDate(generatedAt, options.timeZone))}">`,
    "  <shop>",
    "    <name>KOMUI</name>",
    "    <company>ИП Кадимагомедов Магомедсайгид Алиевич</company>",
    `    <url>${escapeYml(origin)}</url>`,
    "    <currencies>",
    '      <currency id="RUB" rate="1"/>',
    "    </currencies>",
  ];

  renderCategories(lines);
  lines.push("    <offers>");
  for (const offer of offers) renderOffer(lines, offer, origin);
  lines.push("    </offers>");
  renderCollections(lines, offers, origin);
  lines.push("  </shop>", "</yml_catalog>", "");
  return lines.join("\n");
}
