#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const sharp = require("sharp");
const {
  buildYandexDirectFeed,
  YANDEX_FEED_CATEGORIES,
} = require("../server/dist/yandexDirectFeed");

const siteUrl = new URL(
  process.env.KOMUI_FEED_SITE_URL || "https://komui.ru",
).origin;
const productsUrl =
  process.env.KOMUI_FEED_PRODUCTS_URL ||
  `${siteUrl}/api/v1/products?limit=200`;
const requestTimeoutMs = Number(
  process.env.KOMUI_FEED_AUDIT_TIMEOUT_MS || 20_000,
);
const concurrency = Math.max(
  1,
  Math.min(20, Number(process.env.KOMUI_FEED_AUDIT_CONCURRENCY || 10)),
);
const allowedFormats = new Set(["gif", "jpeg", "jpg", "png", "webp"]);
const maxImageBytes = 10 * 1024 * 1024;

async function fetchWithRetry(url, responseType, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { "user-agent": "KOMUI-Yandex-Feed-Audit/1.0" },
      });
      assert.equal(
        response.ok,
        true,
        `${url} returned HTTP ${response.status}`,
      );
      if (responseType === "buffer") {
        return {
          body: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") || "",
          finalUrl: response.url,
        };
      }
      return {
        body: await response.text(),
        contentType: response.headers.get("content-type") || "",
        finalUrl: response.url,
      };
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
  }
  throw lastError;
}

async function mapConcurrent(items, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function absoluteUrl(value) {
  return new URL(value, `${siteUrl}/`).toString();
}

function imageCandidates(product) {
  return [
    product.primary_image_url,
    product.main_image_path,
    ...(Array.isArray(product.image_urls) ? product.image_urls : []),
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function element(body, name) {
  return decodeXml(
    body.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1] || "",
  );
}

async function main() {
  const productsResponse = await fetchWithRetry(productsUrl, "text");
  const products = JSON.parse(productsResponse.body);
  assert.equal(Array.isArray(products), true, "Products API must return an array");
  assert.ok(products.length > 0, "Products API returned an empty catalog");
  assert.equal(
    products.every((product) => product.is_active === true),
    true,
    "Products API returned an inactive product",
  );

  const candidateUrls = [
    ...new Set(products.flatMap(imageCandidates).map(absoluteUrl)),
  ];
  const auditedImages = await mapConcurrent(candidateUrls, async (url) => {
    const response = await fetchWithRetry(url, "buffer");
    const metadata = await sharp(response.body).metadata();
    const format = String(metadata.format || "").toLowerCase();
    assert.ok(metadata.width, `${url} has no detectable width`);
    assert.ok(metadata.height, `${url} has no detectable height`);
    assert.ok(format, `${url} has no detectable image format`);
    assert.match(
      response.contentType,
      /^image\//i,
      `${url} has unexpected Content-Type ${response.contentType}`,
    );
    return {
      url,
      width: metadata.width,
      height: metadata.height,
      format,
      mime: response.contentType.split(";")[0].trim(),
      bytes: response.body.length,
    };
  });
  const imageMetadata = new Map(
    auditedImages.map((metadata) => [metadata.url, metadata]),
  );

  const xml = buildYandexDirectFeed(products, {
    siteUrl,
    mediaMetadata: (url) => imageMetadata.get(absoluteUrl(url)),
  });
  const xmllint = spawnSync("xmllint", ["--noout", "-"], {
    input: xml,
    encoding: "utf8",
  });
  assert.equal(
    xmllint.status,
    0,
    `xmllint failed: ${xmllint.stderr || xmllint.stdout}`,
  );

  const offers = [
    ...xml.matchAll(/<offer id="([^"]+)"([^>]*)>([\s\S]*?)<\/offer>/g),
  ].map((match) => ({
    id: decodeXml(match[1] || ""),
    attributes: match[2] || "",
    body: match[3] || "",
  }));
  const productIds = products.map(({ id }) => id);
  const offerIds = offers.map(({ id }) => id);
  assert.equal(offers.length, products.length, "Offer count differs from product count");
  assert.equal(new Set(offerIds).size, offers.length, "Duplicate offer IDs found");
  assert.deepEqual(
    [...offerIds].sort(),
    [...productIds].sort(),
    "Offer IDs differ from product/e-commerce IDs",
  );

  const knownCategoryIds = new Set(YANDEX_FEED_CATEGORIES.map(({ id }) => id));
  const feedPictureUrls = [];
  const pageChecks = [];
  let oldPriceCount = 0;
  let sizeParamCount = 0;

  for (const offer of offers) {
    assert.match(offer.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(offer.attributes, /\bavailable="true"/);
    const price = Number(element(offer.body, "price"));
    const oldPriceText = element(offer.body, "oldprice");
    const oldPrice = oldPriceText ? Number(oldPriceText) : undefined;
    const categoryId = element(offer.body, "categoryId");
    const currencyId = element(offer.body, "currencyId");
    const pageUrl = element(offer.body, "url");
    const pictures = [
      ...offer.body.matchAll(/<picture>([^<]+)<\/picture>/g),
    ].map((match) => decodeXml(match[1] || ""));
    const sizeParams = [
      ...offer.body.matchAll(/<param name="Размер" unit="INT">([^<]+)<\/param>/g),
    ];

    assert.ok(price > 0, `${offer.id} has invalid price`);
    assert.equal(currencyId, "RUB", `${offer.id} has invalid currency`);
    assert.match(categoryId, /^\d+$/, `${offer.id} has non-numeric category`);
    assert.equal(knownCategoryIds.has(categoryId), true, `${offer.id} has unknown category`);
    assert.ok(pictures.length >= 1 && pictures.length <= 5, `${offer.id} has invalid picture count`);
    assert.equal(/^https:\/\//.test(pageUrl), true, `${offer.id} has non-HTTPS URL`);
    assert.equal(pageUrl.includes(" "), false, `${offer.id} URL contains spaces`);
    if (oldPrice !== undefined) {
      assert.ok(oldPrice > price, `${offer.id} oldprice is not higher than price`);
      oldPriceCount += 1;
    }
    for (const picture of pictures) {
      assert.equal(/^https:\/\//.test(picture), true, `${offer.id} has non-HTTPS picture`);
      assert.equal(picture.includes(" "), false, `${offer.id} picture contains spaces`);
      feedPictureUrls.push(picture);
    }
    sizeParamCount += sizeParams.length;
    pageChecks.push({ id: offer.id, url: pageUrl });
  }

  assert.equal(xml.includes("ir.ozone.ru"), false, "Feed contains an Ozon image URL");
  const uniqueFeedPictures = [...new Set(feedPictureUrls)];
  for (const picture of uniqueFeedPictures) {
    const metadata = imageMetadata.get(picture);
    assert.ok(metadata, `${picture} was not audited`);
    assert.ok(metadata.width >= 450, `${picture} is narrower than 450 px`);
    assert.ok(metadata.height >= 450, `${picture} is shorter than 450 px`);
    assert.ok(metadata.bytes <= maxImageBytes, `${picture} exceeds 10 MB`);
    assert.equal(allowedFormats.has(metadata.format), true, `${picture} has unsupported format`);
  }

  await mapConcurrent(pageChecks, async ({ id, url }) => {
    const response = await fetchWithRetry(url, "text");
    assert.match(response.contentType, /^text\/html/i, `${url} is not HTML`);
    assert.equal(response.body.includes(id), true, `${url} does not contain product UUID ${id}`);
    assert.equal(response.body.includes("ecommerce"), true, `${url} has no e-commerce payload`);
  });

  const collectionCount = (xml.match(/<collection id=/g) || []).length;
  const notSelectedImages = auditedImages.filter(
    ({ url }) => !uniqueFeedPictures.includes(url),
  );
  const policyRejectedImages = auditedImages.filter(
    ({ width, height, format, bytes }) =>
      width < 450 ||
      height < 450 ||
      bytes > maxImageBytes ||
      !allowedFormats.has(format),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        source: productsUrl,
        products: products.length,
        offers: offers.length,
        availableTrue: offers.length,
        productAndMetrikaIdsMatched: offerIds.length,
        productPagesChecked: pageChecks.length,
        candidatePicturesChecked: auditedImages.length,
        feedPictures: feedPictureUrls.length,
        uniqueFeedPictures: uniqueFeedPictures.length,
        notSelectedPictures: notSelectedImages.length,
        policyRejectedPictures: policyRejectedImages.map(({ url, width, height, format, bytes }) => ({
          url,
          width,
          height,
          format,
          bytes,
        })),
        oldPrices: oldPriceCount,
        sizeParams: sizeParamCount,
        collections: collectionCount,
        ozonUrls: 0,
        feedPicturePolicy: "ok",
        xmlBytes: Buffer.byteLength(xml),
        xmllint: "ok",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
