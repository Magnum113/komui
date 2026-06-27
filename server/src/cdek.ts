import type { AppConfig } from "./config";
import { HttpError } from "./errors";

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

export type CdekCity = {
  code: number;
  city: string;
  country_code: string;
  country: string;
  region?: string;
  longitude?: number;
  latitude?: number;
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
  raw: CdekTariff | Record<string, unknown>;
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

let tokenCache: { token: string; expiresAt: number; cacheKey: string } | null =
  null;

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cdekCredentials(config: AppConfig) {
  const clientId = config.CDEK_LOGIN || config.CDEK_CLIENT_ID;
  const clientSecret = config.CDEK_PASSWORD || config.CDEK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new HttpError(
      503,
      "cdek_not_configured",
      "CDEK credentials are not configured",
    );
  }
  return { clientId, clientSecret };
}

function cdekBaseUrl(config: AppConfig) {
  return config.CDEK_API_BASE_URL.replace(/\/+$/, "").replace(/\/v2$/, "");
}

function cdekRuntimeConfig(config: AppConfig) {
  return {
    apiBaseUrl: cdekBaseUrl(config),
    shipmentPoint: config.CDEK_SHIPMENT_POINT,
    shipmentCity: config.CDEK_SHIPMENT_CITY,
    shipmentCityCode: positiveInt(config.CDEK_SHIPMENT_CITY_CODE),
    shipmentAddress: config.CDEK_SHIPMENT_ADDRESS,
    senderName: config.CDEK_SENDER_NAME,
    senderPhone: config.CDEK_SENDER_PHONE,
    tariffCode: positiveInt(config.CDEK_TARIFF_CODE),
    allowedDeliveryModes: config.CDEK_DELIVERY_MODES.split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0),
  };
}

function fromLocation(config: AppConfig): Record<string, unknown> {
  const runtime = cdekRuntimeConfig(config);
  if (runtime.shipmentCityCode) return { code: runtime.shipmentCityCode };
  return {
    country_code: "RU",
    city: runtime.shipmentCity,
    address: runtime.shipmentAddress,
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const rawText = await response.text();
  let parsed: CdekApiResponse<T> | null = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new HttpError(
        502,
        "cdek_invalid_json",
        `CDEK returned invalid JSON (${response.status})`,
      );
    }
  }

  if (!response.ok) {
    const firstError = parsed?.errors?.[0];
    throw new HttpError(
      response.status >= 500 ? 502 : 400,
      "cdek_request_failed",
      firstError?.message || `CDEK request failed with HTTP ${response.status}`,
    );
  }

  return (parsed ?? {}) as T;
}

async function cdekToken(config: AppConfig): Promise<string> {
  const now = Date.now();
  const credentials = cdekCredentials(config);
  const cacheKey = `${cdekBaseUrl(config)}:${credentials.clientId}`;
  if (tokenCache && tokenCache.cacheKey === cacheKey && tokenCache.expiresAt - 30_000 > now) {
    return tokenCache.token;
  }

  const response = await fetch(`${cdekBaseUrl(config)}/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
    signal: AbortSignal.timeout(config.CDEK_REQUEST_TIMEOUT_MS),
  });
  const auth = await parseJsonResponse<CdekAuthResponse>(response);
  if (!auth.access_token) {
    throw new HttpError(502, "cdek_no_token", "CDEK did not return access token");
  }

  tokenCache = {
    token: auth.access_token,
    expiresAt: now + Math.max(60, auth.expires_in || 3600) * 1000,
    cacheKey,
  };
  return tokenCache.token;
}

async function cdekRequest<T>(
  config: AppConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await cdekToken(config);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-App-Name", "komui_checkout");
  headers.set("X-App-Version", "1.0.0");
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${cdekBaseUrl(config)}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(config.CDEK_REQUEST_TIMEOUT_MS),
  });
  return parseJsonResponse<T>(response);
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

export async function findCdekCity(
  config: AppConfig,
  city: string,
): Promise<CdekCity | null> {
  const normalized = text(city, 80);
  if (normalized.length < 2) return null;

  if (config.CDEK_MOCK) {
    return {
      code: 44,
      city: normalized,
      country_code: "RU",
      country: "Россия",
      region: "staging",
      longitude: 37.6173,
      latitude: 55.7558,
    };
  }

  const cities = await cdekRequest<CdekCity[]>(
    config,
    `/v2/location/cities${queryString({
      country_codes: "RU",
      city: normalized,
      size: 10,
      lang: "rus",
    })}`,
    { method: "GET" },
  );

  return (
    cities.find((item) => item.city.toLowerCase() === normalized.toLowerCase()) ??
    cities[0] ??
    null
  );
}

export async function listCdekDeliveryPoints(
  config: AppConfig,
  cityCode: number,
): Promise<CdekDeliveryPoint[]> {
  if (!Number.isInteger(cityCode) || cityCode <= 0) {
    throw new HttpError(400, "cdek_city_required", "CDEK city code is required");
  }

  if (config.CDEK_MOCK) {
    return [
      {
        code: "KOMUI-STAGE-PVZ",
        name: "СДЭК staging ПВЗ",
        type: "PVZ",
        is_handout: true,
        is_reception: false,
        work_time: "ежедневно 10:00–20:00",
        location: {
          city_code: cityCode,
          city: "Staging",
          address: "Тестовый пункт выдачи",
          address_full: "Staging, тестовый пункт выдачи KOMUI",
          latitude: 55.7558,
          longitude: 37.6173,
        },
      },
    ];
  }

  const points = await cdekRequest<CdekDeliveryPoint[]>(
    config,
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
  config: AppConfig,
  cityCode: number,
  pointCode: string,
): Promise<CdekDeliveryPoint | null> {
  const normalizedCode = text(pointCode, 40).toUpperCase();
  if (!normalizedCode) return null;
  const points = await listCdekDeliveryPoints(config, cityCode);
  return (
    points.find((point) => point.code.toUpperCase() === normalizedCode) ?? null
  );
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

export function cdekProfileForProduct(product: {
  name?: string | null;
  product_type_slug?: string | null;
  category_slug?: string | null;
  cdek_profile?: string | null;
}): CdekPackageProfile {
  const explicit = text(product.cdek_profile, 40).toLowerCase();
  if (profileByKey[explicit]) return profileByKey[explicit];

  const haystack = [
    product.product_type_slug,
    product.category_slug,
    product.name,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");

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
  packingHeightExtraCm = 1,
): CdekPackage[] {
  if (!items.length) {
    throw new HttpError(400, "cdek_empty_package", "CDEK package cannot be empty");
  }

  let weight = 0;
  let length = 0;
  let width = 0;
  let height = packingHeightExtraCm;
  const packageItems: CdekPackageItem[] = [];

  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new HttpError(
        400,
        "cdek_invalid_quantity",
        "Invalid CDEK package item quantity",
      );
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
      name: text(`${item.productName}${item.size ? `, размер ${item.size}` : ""}`, 255),
      ware_key: text(item.sku || item.offerId || item.productId || item.productName, 255),
      payment: { value: 0 },
      cost: Math.max(0, Math.round((item.unitPriceAmount ?? 0) / 100)),
      amount: quantity,
      weight: profile.weight,
    });
  }

  return [
    {
      number: text(number, 36) || "1",
      weight: Math.max(100, weight),
      length: Math.max(1, length),
      width: Math.max(1, width),
      height: Math.max(1, height),
      items: packageItems,
    },
  ];
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
  config: AppConfig,
  tariffs: CdekTariff[],
  requestedTariffCode?: number | null,
): CdekTariff {
  const runtime = cdekRuntimeConfig(config);
  const usable = tariffs.filter(
    (tariff) =>
      Number.isFinite(tariff.delivery_sum) &&
      tariff.delivery_sum >= 0 &&
      (!runtime.allowedDeliveryModes.length ||
        !tariff.delivery_mode ||
        runtime.allowedDeliveryModes.includes(tariff.delivery_mode)),
  );

  if (requestedTariffCode) {
    const requested = usable.find(
      (tariff) => tariff.tariff_code === requestedTariffCode,
    );
    if (requested) return requested;
    throw new HttpError(
      400,
      "cdek_tariff_unavailable",
      `CDEK tariff ${requestedTariffCode} is unavailable`,
    );
  }

  if (runtime.tariffCode) {
    const configured = usable.find(
      (tariff) => tariff.tariff_code === runtime.tariffCode,
    );
    if (configured) return configured;
    throw new HttpError(
      400,
      "cdek_tariff_unavailable",
      `CDEK tariff ${runtime.tariffCode} is unavailable`,
    );
  }

  const candidates = usable.length ? usable : tariffs;
  const selected = [...candidates].sort(
    (left, right) => left.delivery_sum - right.delivery_sum,
  )[0];

  if (!selected) {
    throw new HttpError(
      502,
      "cdek_no_tariffs",
      "CDEK did not return available tariffs",
    );
  }
  return selected;
}

export async function quoteCdekDelivery(
  config: AppConfig,
  input: {
    deliveryCityCode: number;
    packages: CdekPackage[];
    tariffCode?: number | null;
  },
): Promise<CdekQuote> {
  if (config.CDEK_MOCK) {
    return {
      amount: 390,
      amountKopecks: 39_000,
      eta: "2-4 дн.",
      tariffCode: input.tariffCode ?? 136,
      tariffName: "Mock СДЭК склад-дверь",
      deliveryMode: 4,
      periodMin: 2,
      periodMax: 4,
      raw: { mock: true },
    };
  }

  const payload = {
    type: 1,
    lang: "rus",
    from_location: fromLocation(config),
    to_location: { code: input.deliveryCityCode },
    packages: input.packages.map(packageForCalculator),
  };

  const result = await cdekRequest<{ tariff_codes: CdekTariff[] }>(
    config,
    "/v2/calculator/tarifflist",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  const tariff = chooseTariff(config, result.tariff_codes ?? [], input.tariffCode);

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

export function normalizePoint(point: CdekDeliveryPoint) {
  const location = point.location ?? {};
  return {
    code: point.code,
    title: point.name || `СДЭК ${point.code}`,
    type: point.type || "PVZ",
    cityCode: Number(location.city_code) || null,
    city: location.city || "",
    address: location.address || location.address_full || "",
    addressFull: location.address_full || location.address || "",
    hours: point.work_time || "график уточняется",
    lat: Number(location.latitude) || null,
    lng: Number(location.longitude) || null,
    metro: point.nearest_metro_station || point.nearest_station || "",
    isHandout: point.is_handout === true,
    isReception: point.is_reception === true,
  };
}
