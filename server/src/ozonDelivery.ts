import type { AppConfig } from "./config";
import type { Db } from "./db";
import { HttpError } from "./errors";
import {
  normalizePhone,
  subtotalAmount,
  type OrderItemInput,
} from "./checkout";

export type OzonPoint = {
  delivery_point_id: number;
  name: string;
  full_address: string;
  is_active: boolean;
  type: string;
  coordinates?: { latitude: number; longitude: number };
  schedule?: Array<{
    date: string;
    periods: Array<{ from_local: string; to_local: string }>;
  }>;
};
export type OzonDimensions = {
  weight_g: number;
  length_mm: number;
  width_mm: number;
  height_mm: number;
};
export type OzonMoney = { amount: string; currency_code: string };
export type OzonPostingInput = {
  request_id: number;
  shipment_method_id: number;
  cutoff_at: string;
  declared_value: OzonMoney;
  dimensions: OzonDimensions;
};
export type OzonSnapshot = {
  posting: OzonPostingInput;
  point: OzonPoint;
  deliveryCost: number;
  insuranceCost: number;
  amount: number;
  eta: string;
  quotedAt: string;
};
export type OzonPosting = {
  posting_number: string;
  order_number: string;
  status: string;
  status_changed_at: string;
  [key: string]: unknown;
};
const providerMessages: Record<string, string> = {
  NotEnoughBalance: "Недостаточно средств на балансе доставки Ozon",
  RecipientError: "Ozon не может доставить заказ этому получателю",
  DeliveryPointNotFound: "Пункт Ozon не найден",
  DeliveryPointRestrictionsError:
    "Посылка не соответствует ограничениям пункта Ozon",
  SameDeliveryPointError: "Пункт получения совпадает с пунктом отгрузки",
  AuthenticationFailed: "Не удалось авторизоваться в Ozon Delivery",
  CancellationPending: "Ozon ещё обрабатывает отмену отправления",
};
export class OzonApiError extends HttpError {
  constructor(
    readonly providerStatus: number,
    readonly providerCode: string,
    readonly traceId: string | null,
  ) {
    super(
      providerStatus === 429 || providerStatus >= 500 ? 503 : 422,
      "ozon_delivery_error",
      providerMessages[providerCode] ?? `Ozon: ${providerCode}`,
      { providerCode, traceId },
    );
  }
}
const apiOrigin = "https://api-delivery.ozon.ru";
const authOrigin = "https://xapi.ozon.ru";
const scopes = [
  "shipment-method",
  "delivery",
  "delivery-point",
  "order",
  "posting",
  "return",
].map((s) => `delivery-api.${s}`);
const clients = new WeakMap<AppConfig, OzonDeliveryClient>();
export const ozonConfigured = (c: AppConfig) =>
  Boolean(
    c.OZON_DELIVERY_CLIENT_ID &&
      c.OZON_DELIVERY_CLIENT_SECRET &&
      c.OZON_DELIVERY_SHIPMENT_METHOD_ID,
  );
export function ozonClient(config: AppConfig) {
  let client = clients.get(config);
  if (!client) {
    client = new OzonDeliveryClient(config);
    clients.set(config, client);
  }
  return client;
}
export class OzonDeliveryClient {
  private token = "";
  private expiresAt = 0;
  private tokenPromise?: Promise<string>;
  private cookies = new Map<string, Map<string, string>>();
  constructor(
    private config: AppConfig,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async request(
    url: string,
    payload: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const origin = new URL(url).origin;
    if (![apiOrigin, authOrigin].includes(origin))
      throw new Error("Ozon origin rejected");
    const jar = this.cookies.get(origin) ?? new Map<string, string>();
    this.cookies.set(origin, jar);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await this.fetcher(url, {
        method: "POST",
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(
          this.config.OZON_DELIVERY_REQUEST_TIMEOUT_MS,
        ),
        headers: {
          "Content-Type": "application/json",
          ...extra,
          ...(jar.size
            ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
        },
      });
      for (const item of response.headers.getSetCookie?.() ?? []) {
        const pair = item.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      if ([302, 307].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new OzonApiError(502, "InvalidRedirect", null);
        const next = new URL(location, url);
        if (next.origin !== origin)
          throw new OzonApiError(502, "CrossOriginRedirectBlocked", null);
        await response.body?.cancel();
        url = next.href;
        continue;
      }
      return response;
    }
    throw new OzonApiError(503, "RedirectLimit", null);
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.expiresAt > Date.now() + 60000) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      if (
        !this.config.OZON_DELIVERY_CLIENT_ID ||
        !this.config.OZON_DELIVERY_CLIENT_SECRET
      )
        throw new HttpError(
          503,
          "ozon_not_configured",
          "Доставка Ozon пока недоступна",
        );
      const r = await this.request(`${authOrigin}/oauth/token`, {
        client_id: this.config.OZON_DELIVERY_CLIENT_ID,
        client_secret: this.config.OZON_DELIVERY_CLIENT_SECRET,
        grant_type: "client_credentials",
        scope: scopes,
      });
      if (!r.ok)
        throw new OzonApiError(
          r.status,
          "AuthenticationFailed",
          r.headers.get("x-o3-trace-id"),
        );
      const data = (await r.json()) as {
        access_token?: string;
        expires_in?: number | string;
      };
      if (!data.access_token)
        throw new OzonApiError(502, "InvalidTokenResponse", null);
      this.token = data.access_token;
      const expiry = Number(data.expires_in);
      // The live OAuth service returns an absolute UNIX timestamp in expires_in.
      this.expiresAt =
        Number.isFinite(expiry) && expiry > 1e9
          ? expiry * 1000
          : Date.now() +
            Math.min(Number.isFinite(expiry) ? expiry : 300, 3600) * 1000;
      return this.token;
    })();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = undefined;
    }
  }
  async call<T>(
    path: string,
    payload: unknown,
    options: { idempotencyKey?: string; binary?: boolean } = {},
  ): Promise<T> {
    if (!/^\/v1\/[a-z-]+\/[a-z-]+$/.test(path))
      throw new Error("Invalid Ozon API path");
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const r = await this.request(apiOrigin + path, payload, {
        Authorization: `Bearer ${token}`,
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      });
      if (r.status === 401 && attempt === 0) {
        await r.body?.cancel();
        this.token = "";
        this.expiresAt = 0;
        continue;
      }
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        throw new OzonApiError(
          r.status,
          String(data.error?.code ?? `HTTP_${r.status}`)
            .replace(/[^\w.-]/g, "")
            .slice(0, 100),
          r.headers.get("x-o3-trace-id"),
        );
      }
      if (options.binary) {
        const buffer = Buffer.from(await r.arrayBuffer());
        if (buffer.subarray(0, 5).toString() !== "%PDF-")
          throw new OzonApiError(502, "InvalidLabelFormat", null);
        return buffer as T;
      }
      const text = await r.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw new OzonApiError(401, "AuthenticationFailed", null);
  }
}
export function ozonMoneyKopecks(money: OzonMoney | undefined): number {
  if (
    !money ||
    money.currency_code !== "RUB" ||
    !/^\d+(?:\.\d{1,2})?$/.test(money.amount)
  )
    throw new OzonApiError(502, "InvalidMoneyResponse", null);
  const [rub, kop = ""] = money.amount.split(".");
  const value = Number(rub) * 100 + Number(kop.padEnd(2, "0"));
  if (!Number.isSafeInteger(value) || value < 0)
    throw new OzonApiError(502, "InvalidMoneyResponse", null);
  return value;
}
export function buildOzonDimensions(items: OrderItemInput[]): OzonDimensions {
  let weight = 0,
    height = 0,
    length = 0,
    width = 0;
  for (const item of items) {
    const snapshot = item.product_snapshot as Record<string, unknown>;
    const profile = snapshot.cdek_package_profile as
      | Record<string, unknown>
      | undefined;
    const tshirt = snapshot.cdek_profile === "tshirt";
    const l = tshirt ? 300 : Number(profile?.length ?? 0) * 10;
    const w = tshirt ? 230 : Number(profile?.width ?? 0) * 10;
    const h = tshirt ? 40 : Number(profile?.height ?? 0) * 10;
    const g = tshirt ? 250 : Number(profile?.weight ?? 0);
    if (![l, w, h, g].every((v) => Number.isFinite(v) && v > 0))
      throw new HttpError(
        422,
        "ozon_package_missing",
        "Для товара не заданы параметры упаковки",
      );
    weight += g * item.quantity;
    height += h * item.quantity;
    length = Math.max(length, l);
    width = Math.max(width, w);
  }
  if (!weight) throw new HttpError(400, "empty_cart", "Корзина пуста");
  return {
    weight_g: Math.ceil(weight),
    length_mm: Math.ceil(length),
    width_mm: Math.ceil(width),
    height_mm: Math.ceil(height),
  };
}
export function normalizeOzonPoint(point: OzonPoint, city = "") {
  return {
    code: String(point.delivery_point_id),
    title: point.name,
    city,
    cityCode: null,
    address: point.full_address,
    hours: (point.schedule ?? [])
      .slice(0, 7)
      .map(
        (d) =>
          `${d.date}: ${d.periods.map((p) => `${p.from_local.slice(0, 5)}–${p.to_local.slice(0, 5)}`).join(", ")}`,
      )
      .join("; ")
      .slice(0, 160),
    lat: point.coordinates?.latitude ?? null,
    lng: point.coordinates?.longitude ?? null,
    type: point.type,
    isHandout: true,
    metro: "",
  };
}
export async function ozonCacheReady(db: Db, config: AppConfig) {
  if (!ozonConfigured(config)) return false;
  const result = await db.query<{ ready: boolean }>(
    `select completed_at > now()-interval '3 days' as ready from public.merch_ozon_delivery_cache where shipment_method_id=$1`,
    [config.OZON_DELIVERY_SHIPMENT_METHOD_ID],
  );
  return result.rows[0]?.ready === true;
}
export async function searchOzonPoints(
  db: Db,
  config: AppConfig,
  city: string,
  query: string,
) {
  if (!config.OZON_DELIVERY_ENABLED || !(await ozonCacheReady(db, config)))
    throw new HttpError(
      503,
      "ozon_unavailable",
      "Пункты Ozon обновляются. Попробуйте позже или выберите СДЭК",
    );
  const escape = (s: string) => s.replace(/[\\%_]/g, "\\$&");
  const rows = await db.query<{ payload: OzonPoint }>(
    `select payload from public.merch_ozon_delivery_points where shipment_method_id=$1 and refreshed_at>now()-interval '3 days' and payload->>'is_active'='true' and payload->>'type'='pvz' and payload->>'full_address' ilike $2 and (payload->>'full_address' ilike $3 or payload->>'name' ilike $3 or point_id::text ilike $3) order by point_id limit 120`,
    [
      config.OZON_DELIVERY_SHIPMENT_METHOD_ID,
      `%${escape(city)}%`,
      `%${escape(query)}%`,
    ],
  );
  const points = rows.rows.map((r) => normalizeOzonPoint(r.payload, city));
  return {
    city: {
      code: null,
      name: city,
      region: null,
      lat: points[0]?.lat ?? null,
      lng: points[0]?.lng ?? null,
    },
    points,
  };
}
/** A point may disappear between list and info; isolate 404s without dropping its valid neighbours. */
export async function loadOzonPointDetails(client: OzonDeliveryClient, ids: number[]): Promise<{ points: OzonPoint[]; missingIds: number[] }> {
  if (!ids.length) return { points: [], missingIds: [] };
  try {
    const details = await client.call<{ delivery_points: OzonPoint[] }>("/v1/delivery-point/info", { delivery_point_ids: ids });
    const points = details.delivery_points.filter(point => ids.includes(point.delivery_point_id));
    const found = new Set(points.map(point => point.delivery_point_id));
    if (ids.some(id => !found.has(id))) throw new OzonApiError(502, "IncompletePointResponse", null);
    return { points, missingIds: [] };
  } catch (error) {
    if (!(error instanceof OzonApiError) || error.providerStatus !== 404) throw error;
    if (ids.length === 1) return { points: [], missingIds: ids };
    const middle = Math.ceil(ids.length / 2);
    const left = await loadOzonPointDetails(client, ids.slice(0, middle));
    const right = await loadOzonPointDetails(client, ids.slice(middle));
    return { points: [...left.points, ...right.points], missingIds: [...left.missingIds, ...right.missingIds] };
  }
}
/** Refresh one page per worker tick. Only a complete scan marks the cache ready. */
export async function refreshOzonPointsPage(db: Db, config: AppConfig) {
  const method = config.OZON_DELIVERY_SHIPMENT_METHOD_ID;
  if (!method) return;
  await db.query(
    `insert into public.merch_ozon_delivery_cache(shipment_method_id) values($1) on conflict do nothing`,
    [method],
  );
  const state = (
    await db.query<{
      cursor: string | null;
      refreshing: boolean;
      stale: boolean;
    }>(
      `select cursor,refreshing,completed_at is null or completed_at<now()-interval '1 day' as stale from public.merch_ozon_delivery_cache where shipment_method_id=$1`,
      [method],
    )
  ).rows[0];
  if (!state || (!state.refreshing && !state.stale)) return;
  const result = await ozonClient(config).call<{
    delivery_points: Array<{
      delivery_point_id: number;
      shipment_method_ids: number[] | number;
    }>;
    next_cursor?: string;
  }>("/v1/delivery-point/list", {
    pagination: {
      limit: 100,
      ...(state.refreshing && state.cursor ? { cursor: state.cursor } : {}),
    },
  });
  const ids = result.delivery_points
    .filter((p) =>
      Array.isArray(p.shipment_method_ids)
        ? p.shipment_method_ids.includes(method)
        : p.shipment_method_ids === method,
    )
    .map((p) => p.delivery_point_id);
  if (ids.length) {
    const details = await loadOzonPointDetails(ozonClient(config), ids);
    await db.query(
      `insert into public.merch_ozon_delivery_points(point_id,shipment_method_id,payload) select (p->>'delivery_point_id')::bigint,$1,p from jsonb_array_elements($2::jsonb) p on conflict(point_id) do update set shipment_method_id=excluded.shipment_method_id,payload=excluded.payload,refreshed_at=now()`,
      [method, JSON.stringify(details.points)],
    );
    if (details.missingIds.length) await db.query(
      `delete from public.merch_ozon_delivery_points where shipment_method_id=$1 and point_id=any($2::bigint[])`,
      [method, details.missingIds],
    );
  }
  if (result.next_cursor && result.next_cursor === state.cursor)
    throw new OzonApiError(502, "RepeatedPointCursor", null);
  await db.query(
    `update public.merch_ozon_delivery_cache set cursor=$2,refreshing=$3,completed_at=case when $3 then completed_at else now() end,updated_at=now() where shipment_method_id=$1`,
    [method, result.next_cursor ?? null, Boolean(result.next_cursor)],
  );
}
export async function quoteOzonDelivery(
  config: AppConfig,
  items: OrderItemInput[],
  pointCode: string,
  phoneValue: unknown,
): Promise<OzonSnapshot> {
  if (
    !config.OZON_DELIVERY_ENABLED ||
    !config.OZON_DELIVERY_WORKER_ENABLED ||
    !ozonConfigured(config)
  )
    throw new HttpError(503, "ozon_unavailable", "Доставка Ozon недоступна");
  const pointId = Number(pointCode);
  if (!Number.isSafeInteger(pointId) || pointId <= 0)
    throw new HttpError(400, "delivery_point_required", "Выберите пункт Ozon");
  const phone = normalizePhone(phoneValue);
  const client = ozonClient(config);
  const buyer = await client.call<{ can_be_delivered: boolean }>(
    "/v1/delivery/check-client",
    { phone_number: phone },
  );
  if (!buyer.can_be_delivered)
    throw new HttpError(
      422,
      "ozon_recipient_unavailable",
      "Для доставки Ozon нужен аккаунт Ozon с указанным телефоном. Проверьте номер или выберите СДЭК",
    );
  const info = await client.call<{ delivery_points: OzonPoint[] }>(
    "/v1/delivery-point/info",
    { delivery_point_ids: [pointId] },
  );
  const point = info.delivery_points.find(
    (p) => p.delivery_point_id === pointId && p.is_active && p.type === "pvz",
  );
  if (!point)
    throw new HttpError(422, "ozon_point_unavailable", "Пункт Ozon недоступен");
  const posting: OzonPostingInput = {
    request_id: 1,
    shipment_method_id: config.OZON_DELIVERY_SHIPMENT_METHOD_ID!,
    cutoff_at: new Date(
      Date.now() + config.OZON_DELIVERY_PREPARATION_HOURS * 3600000,
    ).toISOString(),
    declared_value: {
      amount: (subtotalAmount(items) / 100).toFixed(2),
      currency_code: "RUB",
    },
    dimensions: buildOzonDimensions(items),
  };
  const availability = await client.call<{
    results: Array<{
      request_id: number;
      delivery_point_id: number;
      cutoff_at?: string;
      error?: { code: string };
    }>;
  }>("/v1/delivery-point/check-availability", {
    delivery_point_ids: [pointId],
    shipment_method_id: posting.shipment_method_id,
    postings: [
      {
        request_id: 1,
        cutoff_at: posting.cutoff_at,
        declared_value: posting.declared_value,
        dimensions: posting.dimensions,
      },
    ],
  });
  const available = availability.results.find(
    (r) => r.request_id === 1 && r.delivery_point_id === pointId && !r.error,
  );
  if (!available)
    throw new HttpError(
      422,
      "ozon_point_unavailable",
      "Ozon не доставляет эту посылку в выбранный пункт",
    );
  if (available.cutoff_at) posting.cutoff_at = available.cutoff_at;
  const quoted = await client.call<{
    results: Array<{
      request_id: number;
      posting?: {
        estimated_delivery_cost: OzonMoney;
        estimated_insurance_cost: OzonMoney;
        estimated_delivery_days?: number;
        cutoff_at: string;
      };
      error?: { code: string };
    }>;
  }>("/v1/order/checkout", {
    recipient: { phone_number: phone },
    postings: [posting],
    delivery: { delivery_point: { delivery_point_id: pointId } },
  });
  const quote = quoted.results.find(
    (r) => r.request_id === 1 && !r.error,
  )?.posting;
  if (!quote)
    throw new HttpError(
      422,
      "ozon_quote_unavailable",
      "Не удалось рассчитать доставку Ozon",
    );
  const deliveryCost = ozonMoneyKopecks(quote.estimated_delivery_cost),
    insuranceCost = ozonMoneyKopecks(quote.estimated_insurance_cost);
  posting.cutoff_at = quote.cutoff_at;
  return {
    posting,
    point,
    deliveryCost,
    insuranceCost,
    amount: deliveryCost + insuranceCost,
    eta: quote.estimated_delivery_days
      ? `${quote.estimated_delivery_days} дн.`
      : "Уточняется",
    quotedAt: new Date().toISOString(),
  };
}
