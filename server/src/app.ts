import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config";
import { publicConfig, yandexMapsApiKey } from "./config";
import { createDb, type Db } from "./db";
import { auditAdminEvent } from "./audit";
import { CatalogRepository, normalizeLimit } from "./catalog";
import { HttpError } from "./errors";
import { mediaManifestStatus } from "./mediaManifest";
import {
  buildYandexDirectFeed,
  YandexDirectFeedError,
} from "./yandexDirectFeed";
import {
  handleCdekDeliveryPoints,
  handleCdekDeliveryQuote,
  handleCompatibilityFunction,
  handlePromoValidate,
  handleTbankCreatePayment,
  handleTbankPaymentStatus,
  handleTbankWebhook,
} from "./stage5";
import {
  handleAdminGetStorefrontProduct,
  handleAdminListStorefrontProducts,
  handleAdminUpdateStorefrontProduct,
} from "./adminStorefront";
import {
  handleAdminGetOrder,
  handleAdminListOrders,
  handleAdminMarkOrderShipped,
  handleAdminUpdateOrderFulfillment,
} from "./adminOrders";
import {
  handleAdminCreateOzonStorefrontProduct,
  handleAdminLinkOzonStorefrontOffers,
  handleOzonImportJobStatus,
  handleOzonProductsImport,
  handleOzonProductsImportPreview,
} from "./ozonImport";
import {
  handleRuntimeFallbackSwitch,
  handleRuntimeRead,
} from "./runtimeSwitch";
import { handleAdminCreateCdekShipment } from "./cdekShipments";
import {
  decodeReviewCursor,
  normalizeReviewsLimit,
  ReviewsRepository,
} from "./reviews";

type AppOptions = {
  config: AppConfig;
  db?: Db;
};

function jsonError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return reply.status(statusCode).send({
    error: {
      code,
      message,
      ...(details && Object.keys(details).length ? { details } : {}),
    },
  });
}

function deliveryConfigScript(config: AppConfig) {
  return `window.KOMUI_DELIVERY = Object.assign({}, window.KOMUI_DELIVERY, { yandexMapsApiKey: ${JSON.stringify(
    yandexMapsApiKey(config),
  )} });`;
}

async function requireAdmin(
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!config.ADMIN_API_TOKEN) {
    await auditAdminEvent(config, request, "admin.auth", "disabled").catch(
      () => undefined,
    );
    return jsonError(reply, 503, "admin_disabled", "Admin API is disabled");
  }

  const header = request.headers.authorization || "";
  const expected = `Bearer ${config.ADMIN_API_TOKEN}`;
  const adminTokenHeader = request.headers["x-komui-admin-token"];
  const adminToken =
    typeof adminTokenHeader === "string"
      ? adminTokenHeader
      : Array.isArray(adminTokenHeader)
        ? adminTokenHeader[0]
        : "";

  if (header !== expected && adminToken !== config.ADMIN_API_TOKEN) {
    await auditAdminEvent(config, request, "admin.auth", "denied").catch(
      () => undefined,
    );
    return jsonError(reply, 401, "unauthorized", "Unauthorized");
  }
}

export function buildApp({ config, db = createDb(config) }: AppOptions) {
  const app: FastifyInstance = Fastify({
    logger: {
      level: config.NODE_ENV === "development" ? "debug" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-komui-admin-token",
          "req.headers.cookie",
          "DATABASE_URL",
          "*.password",
          "*.token",
        ],
        censor: "[redacted]",
      },
    },
    bodyLimit: 1_048_576,
    connectionTimeout: 5_000,
    requestTimeout: 10_000,
    genReqId: (request) =>
      request.headers["x-request-id"]?.toString() ||
      randomUUID().replaceAll("-", ""),
  });

  const catalog = new CatalogRepository(db);
  const reviews = new ReviewsRepository(db);
  const stage5Context = { config, db };

  app.addHook("onClose", async () => {
    await db.close();
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if ((error as { validation?: unknown }).validation) {
      return jsonError(reply, 400, "bad_request", "Invalid request");
    }
    if (error instanceof HttpError) {
      return jsonError(
        reply,
        error.statusCode,
        error.code,
        error.message,
        error.details,
      );
    }
    return jsonError(reply, 500, "internal_error", "Internal server error");
  });

  app.get("/health/live", async () => ({
    ok: true,
    service: "komui-backend",
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get("/healthz", async () => ({
    ok: true,
    service: "komui-backend",
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      const ping = await db.ping();
      return {
        ok: true,
        database: ping.database_name,
        config: publicConfig(config),
        media: mediaManifestStatus(),
      };
    } catch (error) {
      return jsonError(reply, 503, "not_ready", "Database is not ready");
    }
  });

  app.get("/readyz", async (_request, reply) => {
    try {
      const ping = await db.ping();
      return {
        ok: true,
        database: ping.database_name,
      };
    } catch (error) {
      return jsonError(reply, 503, "not_ready", "Database is not ready");
    }
  });

  app.get<{
    Querystring: { limit?: string };
  }>("/v1/products", async (request) => {
    const limit = normalizeLimit(request.query.limit);
    return catalog.listActiveProducts(limit);
  });

  app.get<{
    Params: { slug: string };
  }>("/v1/products/:slug", async (request, reply) => {
    const product = await catalog.findActiveProductBySlug(request.params.slug);
    if (!product) {
      return jsonError(reply, 404, "not_found", "Product not found");
    }
    if (product.slug !== request.params.slug) {
      reply.header("X-Komui-Canonical-Slug", product.slug);
    }
    return product;
  });

  app.get<{
    Params: { slug: string };
    Querystring: { limit?: string; cursor?: string };
  }>("/v1/products/:slug/reviews", async (request, reply) => {
    const product = await catalog.findActiveProductBySlug(request.params.slug);
    if (!product) {
      return jsonError(reply, 404, "not_found", "Product not found");
    }
    if (product.slug !== request.params.slug) {
      reply.header("X-Komui-Canonical-Slug", product.slug);
    }

    const result = await reviews.listPublicProductReviews(
      product.id,
      normalizeReviewsLimit(request.query.limit),
      decodeReviewCursor(request.query.cursor),
    );
    return reply
      .header("Cache-Control", "public, max-age=60, s-maxage=300")
      .send({
        product: { id: product.id, slug: product.slug },
        ...result,
      });
  });

  app.get("/v1/catalog/stats", async () => catalog.stats());

  app.get("/v1/feeds/yandex-direct.yml", async (request, reply) => {
    try {
      const products = await catalog.listActiveProductsForYandexFeed();
      const feed = buildYandexDirectFeed(products, {
        siteUrl: config.SITE_URL,
      });
      return reply
        .header("Content-Type", "application/xml; charset=utf-8")
        .header(
          "Content-Disposition",
          'inline; filename="yandex-direct.yml"',
        )
        .header("Cache-Control", "no-cache")
        .send(feed);
    } catch (error) {
      if (error instanceof YandexDirectFeedError) {
        request.log.error(
          { issues: error.issues },
          "Yandex Direct feed validation failed",
        );
        return jsonError(
          reply,
          503,
          "yandex_feed_invalid",
          "Yandex Direct feed data is invalid",
          { issues: error.issues.slice(0, 50) },
        );
      }
      throw error;
    }
  });

  app.get("/delivery-config", async (_request, reply) => {
    const configured = Boolean(yandexMapsApiKey(config));
    return reply
      .header("Content-Type", "application/javascript; charset=utf-8")
      .header(
        "Cache-Control",
        configured ? "public, max-age=300, s-maxage=300" : "no-store",
      )
      .send(deliveryConfigScript(config));
  });

  app.post("/v1/delivery/points", async (request, reply) =>
    handleCdekDeliveryPoints(request, reply, stage5Context),
  );

  app.post("/v1/delivery/quote", async (request, reply) =>
    handleCdekDeliveryQuote(request, reply, stage5Context),
  );

  app.post("/v1/promos/validate", async (request, reply) =>
    handlePromoValidate(request, reply, stage5Context),
  );

  app.post("/v1/payments", async (request, reply) =>
    handleTbankCreatePayment(request, reply, stage5Context),
  );

  app.post("/v1/payments/status", async (request, reply) =>
    handleTbankPaymentStatus(request, reply, stage5Context),
  );

  app.post("/v1/webhooks/tbank", async (request, reply) =>
    handleTbankWebhook(request, reply, stage5Context),
  );

  app.post("/supabase-function", async (request, reply) =>
    handleCompatibilityFunction(request, reply, stage5Context),
  );

  app.post("/api/supabase-function", async (request, reply) =>
    handleCompatibilityFunction(request, reply, stage5Context),
  );

  app.get("/admin/runtime", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleRuntimeRead(request, reply, config);
  });

  app.post("/admin/runtime/fallback", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleRuntimeFallbackSwitch(request, reply, config);
  });

  app.get("/admin/storefront/products", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminListStorefrontProducts(request, reply, { config, db });
  });

  app.get<{
    Params: { productId: string };
  }>("/admin/storefront/products/:productId", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminGetStorefrontProduct(request, reply, { config, db });
  });

  app.patch<{
    Params: { productId: string };
  }>("/admin/storefront/products/:productId", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminUpdateStorefrontProduct(request, reply, { config, db });
  });

  app.get("/admin/storefront/orders", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminListOrders(request, reply, { config, db });
  });

  app.get<{
    Params: { orderId: string };
  }>("/admin/storefront/orders/:orderId", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminGetOrder(request, reply, { config, db });
  });

  app.patch<{
    Params: { orderId: string };
  }>("/admin/storefront/orders/:orderId/fulfillment", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminUpdateOrderFulfillment(request, reply, { config, db });
  });

  app.post<{
    Params: { orderId: string };
  }>("/admin/storefront/orders/:orderId/mark-shipped", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminMarkOrderShipped(request, reply, { config, db });
  });

  app.post("/admin/ozon/products/import-preview", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleOzonProductsImportPreview(request, reply, { config, db });
  });

  app.post("/admin/ozon/products/import", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleOzonProductsImport(request, reply, { config, db });
  });

  app.post("/admin/ozon/products/storefront-products", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminCreateOzonStorefrontProduct(request, reply, { config, db });
  });

  app.post("/admin/ozon/products/link-storefront-offers", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminLinkOzonStorefrontOffers(request, reply, { config, db });
  });

  app.get<{
    Params: { jobId: string };
  }>("/admin/ozon/jobs/:jobId", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleOzonImportJobStatus(request, reply, { config, db });
  });

  app.post("/admin/cdek/shipments/create", async (request, reply) => {
    const authResult = await requireAdmin(config, request, reply);
    if (reply.sent) return authResult;

    return handleAdminCreateCdekShipment(request, reply, { config, db });
  });

  return app;
}
