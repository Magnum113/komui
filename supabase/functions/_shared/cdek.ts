type CdekAuthResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

type CdekResponseError = {
  code?: string;
  message?: string;
};

type CdekApiResponse<T = unknown> = T & {
  errors?: CdekResponseError[];
};

type CdekRelatedEntity = {
  type?: string;
  uuid?: string;
  url?: string;
  cdek_number?: string;
};

export type CdekCity = {
  code: number;
  city: string;
  country_code: string;
  country: string;
  region?: string;
  region_code?: number;
  sub_region?: string;
  longitude?: number;
  latitude?: number;
  time_zone?: string;
};

export type CdekDeliveryPoint = {
  code: string;
  name?: string;
  type?: string;
  take_only?: boolean;
  is_handout?: boolean;
  is_reception?: boolean;
  work_time?: string;
  nearest_metro_station?: string;
  nearest_station?: string;
  location?: {
    city_code?: number;
    city?: string;
    address?: string;
    address_full?: string;
    longitude?: number;
    latitude?: number;
  };
};

export type CdekPackageItem = {
  name: string;
  ware_key: string;
  payment: { value: number };
  cost: number;
  amount: number;
  weight: number;
};

export type CdekPackage = {
  number: string;
  weight: number;
  length: number;
  width: number;
  height: number;
  items?: CdekPackageItem[];
};

export type CdekTariff = {
  tariff_code: number;
  tariff_name: string;
  tariff_description?: string;
  delivery_mode?: number;
  delivery_sum: number;
  period_min?: number;
  period_max?: number;
  calendar_min?: number;
  calendar_max?: number;
};

export type CdekQuote = {
  amount: number;
  amountKopecks: number;
  eta: string;
  tariffCode: number;
  tariffName: string;
  deliveryMode: number | null;
  periodMin: number | null;
  periodMax: number | null;
  raw: CdekTariff;
};

export type CdekPackageInput = {
  productId?: string | null;
  offerId?: string | null;
  sku?: string | null;
  productName: string;
  size?: string | null;
  quantity: number;
  unitPriceAmount?: number;
  productTypeSlug?: string | null;
  categorySlug?: string | null;
  profileKey?: string | null;
};

export type CdekPackageProfile = {
  key: "tshirt" | "hoodie";
  title: string;
  weight: number;
  length: number;
  width: number;
  height: number;
};

export type CdekOrderPayload = {
  number: string;
  tariffCode: number;
  deliveryPoint: string;
  recipientName: string;
  recipientPhone: string;
  packages: CdekPackage[];
  comment?: string;
};

export type CdekOrderRequestPayload = {
  type: number;
  number: string;
  tariff_code: number;
  shipment_point: string;
  delivery_point: string;
  comment?: string;
  sender: {
    company: string;
    name: string;
    phones: Array<{ number: string }>;
  };
  recipient: {
    name: string;
    phones: Array<{ number: string }>;
  };
  delivery_recipient_cost: { value: number };
  packages: CdekPackage[];
};

const defaultApiBaseUrl = "https://api.cdek.ru";
const defaultShipmentPoint = "MKHCH20";
const defaultShipmentCity = "Махачкала";
const defaultShipmentAddress = "ул. Сурикова, 77";
const defaultSenderName = "Komui";
const defaultSenderPhone = "+79995330015";

let tokenCache: { token: string; expiresAt: number } | null = null;

function env(name: string): string {
  return String(Deno.env.get(name) ?? "").trim();
}

function normalizeBaseUrl(value: string): string {
  return (value || defaultApiBaseUrl).replace(/\/+$/, "").replace(/\/v2$/, "");
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cdekCredentials() {
  const clientId = env("CDEK_LOGIN") || env("CDEK_CLIENT_ID");
  const clientSecret = env("CDEK_PASSWORD") || env("CDEK_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("CDEK_LOGIN and CDEK_PASSWORD must be configured");
  }
  return { clientId, clientSecret };
}

export function cdekConfig() {
  return {
    apiBaseUrl: normalizeBaseUrl(env("CDEK_API_BASE_URL")),
    shipmentPoint: env("CDEK_SHIPMENT_POINT") || defaultShipmentPoint,
    shipmentCity: env("CDEK_SHIPMENT_CITY") || defaultShipmentCity,
    shipmentCityCode: positiveInt(env("CDEK_SHIPMENT_CITY_CODE")),
    shipmentAddress: env("CDEK_SHIPMENT_ADDRESS") || defaultShipmentAddress,
    senderName: env("CDEK_SENDER_NAME") || defaultSenderName,
    senderPhone: env("CDEK_SENDER_PHONE") || defaultSenderPhone,
    tariffCode: positiveInt(env("CDEK_TARIFF_CODE")),
    allowedDeliveryModes: (env("CDEK_DELIVERY_MODES") || "4")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0),
  };
}

function fromLocation(): Record<string, unknown> {
  const config = cdekConfig();
  if (config.shipmentCityCode) {
    return { code: config.shipmentCityCode };
  }

  return {
    country_code: "RU",
    city: config.shipmentCity,
    address: config.shipmentAddress,
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const rawText = await response.text();
  let parsed: CdekApiResponse<T> | null = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`CDEK returned invalid JSON (${response.status})`);
    }
  }

  if (!response.ok) {
    const firstError = parsed?.errors?.[0];
    throw new Error(
      firstError?.message ||
        `CDEK request failed with HTTP ${response.status}`,
    );
  }

  return (parsed ?? {}) as T;
}

async function cdekToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 30_000 > now) {
    return tokenCache.token;
  }

  const config = cdekConfig();
  const credentials = cdekCredentials();
  const response = await fetch(`${config.apiBaseUrl}/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });
  const auth = await parseJsonResponse<CdekAuthResponse>(response);
  if (!auth.access_token) throw new Error("CDEK did not return access token");

  tokenCache = {
    token: auth.access_token,
    expiresAt: now + Math.max(60, auth.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

async function cdekRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const config = cdekConfig();
  const token = await cdekToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-App-Name", "komui_checkout");
  headers.set("X-App-Version", "1.0.0");
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  return await parseJsonResponse<T>(response);
}

function queryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : "";
}

export async function findCdekCity(city: string): Promise<CdekCity | null> {
  const normalized = text(city, 80);
  if (normalized.length < 2) return null;

  const cities = await cdekRequest<CdekCity[]>(
    `/v2/location/cities${queryString({
      country_codes: "RU",
      city: normalized,
      size: 10,
      lang: "rus",
    })}`,
    { method: "GET" },
  );

  return cities.find((item) =>
    item.city.toLowerCase() === normalized.toLowerCase()
  ) ?? cities[0] ?? null;
}

export async function listCdekDeliveryPoints(
  cityCode: number,
): Promise<CdekDeliveryPoint[]> {
  if (!Number.isInteger(cityCode) || cityCode <= 0) {
    throw new Error("CDEK city code is required");
  }

  const points = await cdekRequest<CdekDeliveryPoint[]>(
    `/v2/deliverypoints${queryString({
      country_code: "RU",
      city_code: cityCode,
      type: "PVZ",
      is_handout: true,
      lang: "rus",
    })}`,
    { method: "GET" },
  );

  return points.filter((point) => point.code && point.location?.city_code);
}

export async function findCdekDeliveryPoint(
  cityCode: number,
  pointCode: string,
): Promise<CdekDeliveryPoint | null> {
  const normalizedCode = text(pointCode, 40).toUpperCase();
  if (!normalizedCode) return null;
  const points = await listCdekDeliveryPoints(cityCode);
  return points.find((point) => point.code.toUpperCase() === normalizedCode) ??
    null;
}

const profileByKey: Record<string, CdekPackageProfile> = {
  tshirt: {
    key: "tshirt",
    title: "Футболка",
    weight: 250,
    length: 30,
    width: 23,
    height: 4,
  },
  hoodie: {
    key: "hoodie",
    title: "Худи",
    weight: 350,
    length: 28,
    width: 24,
    height: 4,
  },
};

export function cdekProfileForProduct(
  product: {
    name?: string | null;
    product_type_slug?: string | null;
    category_slug?: string | null;
    cdek_profile?: string | null;
  },
): CdekPackageProfile {
  const explicit = text(product.cdek_profile, 40).toLowerCase();
  if (profileByKey[explicit]) return profileByKey[explicit];

  const haystack = [
    product.product_type_slug,
    product.category_slug,
    product.name,
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");

  if (
    haystack.includes("hoodie") ||
    haystack.includes("hood") ||
    haystack.includes("sweatshirt") ||
    haystack.includes("sweat") ||
    haystack.includes("худи") ||
    haystack.includes("свитш") ||
    haystack.includes("толстов")
  ) {
    return profileByKey.hoodie;
  }

  return profileByKey.tshirt;
}

export function buildCdekPackages(
  number: string,
  items: CdekPackageInput[],
): CdekPackage[] {
  if (!items.length) throw new Error("CDEK package cannot be empty");

  let weight = 0;
  let length = 0;
  let width = 0;
  let height = Number(env("CDEK_PACKING_HEIGHT_EXTRA_CM") || 1);
  const packageItems: CdekPackageItem[] = [];

  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new Error("Invalid CDEK package item quantity");
    }

    const profile = cdekProfileForProduct({
      name: item.productName,
      product_type_slug: item.productTypeSlug,
      category_slug: item.categorySlug,
      cdek_profile: item.profileKey,
    });

    weight += profile.weight * quantity;
    length = Math.max(length, profile.length);
    width = Math.max(width, profile.width);
    height += profile.height * quantity;

    packageItems.push({
      name: text(
        `${item.productName}${item.size ? `, размер ${item.size}` : ""}`,
        255,
      ),
      ware_key: text(
        item.sku || item.offerId || item.productId || item.productName,
        255,
      ),
      payment: { value: 0 },
      cost: Math.max(0, Math.round((item.unitPriceAmount ?? 0) / 100)),
      amount: quantity,
      weight: profile.weight,
    });
  }

  return [{
    number: text(number, 36) || "1",
    weight: Math.max(100, weight),
    length: Math.max(1, length),
    width: Math.max(1, width),
    height: Math.max(1, height),
    items: packageItems,
  }];
}

function packageForCalculator(pack: CdekPackage) {
  const { items: _items, ...rest } = pack;
  return rest;
}

function etaForTariff(tariff: CdekTariff): string {
  const min = tariff.period_min ?? tariff.calendar_min ?? null;
  const max = tariff.period_max ?? tariff.calendar_max ?? null;
  if (!min && !max) return "срок уточняется";
  if (min && max && min !== max) return `${min}-${max} дн.`;
  return `${min ?? max} дн.`;
}

function chooseTariff(
  tariffs: CdekTariff[],
  requestedTariffCode?: number | null,
): CdekTariff {
  const config = cdekConfig();
  const usable = tariffs.filter((tariff) =>
    Number.isFinite(tariff.delivery_sum) &&
    tariff.delivery_sum >= 0 &&
    (!config.allowedDeliveryModes.length ||
      !tariff.delivery_mode ||
      config.allowedDeliveryModes.includes(tariff.delivery_mode))
  );

  if (requestedTariffCode) {
    const requested = usable.find((tariff) =>
      tariff.tariff_code === requestedTariffCode
    );
    if (requested) return requested;
    throw new Error(`CDEK tariff ${requestedTariffCode} is unavailable`);
  }

  if (config.tariffCode) {
    const configured = usable.find((tariff) =>
      tariff.tariff_code === config.tariffCode
    );
    if (configured) return configured;
    throw new Error(`CDEK tariff ${config.tariffCode} is unavailable`);
  }

  const candidates = usable.length ? usable : tariffs;
  const selected = [...candidates].sort((left, right) =>
    left.delivery_sum - right.delivery_sum
  )[0];

  if (!selected) throw new Error("CDEK did not return available tariffs");
  return selected;
}

export async function quoteCdekDelivery(
  input: {
    deliveryCityCode: number;
    packages: CdekPackage[];
    tariffCode?: number | null;
  },
): Promise<CdekQuote> {
  const payload = {
    type: 1,
    lang: "rus",
    from_location: fromLocation(),
    to_location: { code: input.deliveryCityCode },
    packages: input.packages.map(packageForCalculator),
  };

  const result = await cdekRequest<{ tariff_codes: CdekTariff[] }>(
    "/v2/calculator/tarifflist",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  const tariff = chooseTariff(result.tariff_codes ?? [], input.tariffCode);

  return {
    amount: tariff.delivery_sum,
    amountKopecks: Math.round(tariff.delivery_sum * 100),
    eta: etaForTariff(tariff),
    tariffCode: tariff.tariff_code,
    tariffName: tariff.tariff_name,
    deliveryMode: tariff.delivery_mode ?? null,
    periodMin: tariff.period_min ?? tariff.calendar_min ?? null,
    periodMax: tariff.period_max ?? tariff.calendar_max ?? null,
    raw: tariff,
  };
}

export function buildCdekOrderRequest(
  payload: CdekOrderPayload,
): CdekOrderRequestPayload {
  const config = cdekConfig();
  const body: CdekOrderRequestPayload = {
    type: 1,
    number: text(payload.number, 36),
    tariff_code: payload.tariffCode,
    shipment_point: config.shipmentPoint,
    delivery_point: text(payload.deliveryPoint, 40),
    comment: text(payload.comment, 255),
    sender: {
      company: text(config.senderName, 255),
      name: text(config.senderName, 255),
      phones: [{ number: text(config.senderPhone, 32) }],
    },
    recipient: {
      name: text(payload.recipientName, 255),
      phones: [{ number: text(payload.recipientPhone, 32) }],
    },
    delivery_recipient_cost: { value: 0 },
    packages: payload.packages,
  };
  if (!body.comment) delete body.comment;
  return body;
}

export async function createCdekOrder(payload: CdekOrderPayload) {
  return await cdekRequest<{
    entity?: { uuid?: string };
    requests?: Array<{
      request_uuid?: string;
      type?: string;
      state?: string;
      errors?: CdekResponseError[];
      warnings?: CdekResponseError[];
    }>;
    related_entities?: CdekRelatedEntity | CdekRelatedEntity[];
  }>("/v2/orders", {
    method: "POST",
    body: JSON.stringify(buildCdekOrderRequest(payload)),
  });
}

export function cdekNumberFromResponse(
  response: { related_entities?: CdekRelatedEntity | CdekRelatedEntity[] },
): string | null {
  const related = response.related_entities;
  const entities = Array.isArray(related) ? related : related ? [related] : [];
  const value = entities.find((entity) => entity.cdek_number)?.cdek_number;
  return value ? text(value, 80) : null;
}

export function cdekRequestState(
  response: { requests?: Array<{ state?: string; errors?: CdekResponseError[] }> },
): string {
  const state = response.requests?.[0]?.state ?? "UNKNOWN";
  switch (state) {
    case "ACCEPTED":
    case "WAITING":
      return "accepted";
    case "SUCCESSFUL":
      return "created";
    case "INVALID":
      return "invalid";
    default:
      return "unknown";
  }
}

export function cdekFirstError(
  response: { requests?: Array<{ errors?: CdekResponseError[] }> },
): CdekResponseError | null {
  return response.requests?.find((request) => request.errors?.length)
    ?.errors?.[0] ?? null;
}
