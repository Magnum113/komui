import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  errorMessage,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/http.ts";
import { findCdekCity, listCdekDeliveryPoints } from "../_shared/cdek.ts";

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function matchesPoint(point: ReturnType<typeof normalizePoint>, query: string) {
  if (!query) return true;
  const haystack = [
    point.code,
    point.title,
    point.city,
    point.address,
    point.metro,
  ].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function normalizePoint(point: Awaited<ReturnType<typeof listCdekDeliveryPoints>>[number]) {
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

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }
  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ error: "Origin is not allowed" }, 403, cors);
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const cityQuery = text(body.city, 80);
    const pointQuery = text(body.query, 120);
    if (cityQuery.length < 2) {
      return jsonResponse({
        city: null,
        points: [],
        message: "Введите город",
      }, 200, cors);
    }

    const city = await findCdekCity(cityQuery);
    if (!city) {
      return jsonResponse({
        city: null,
        points: [],
        message: "Город не найден в CDEK",
      }, 200, cors);
    }

    const points = (await listCdekDeliveryPoints(city.code))
      .map(normalizePoint)
      .filter((point) => point.isHandout && matchesPoint(point, pointQuery))
      .slice(0, 120);

    return jsonResponse({
      city: {
        code: city.code,
        name: city.city,
        region: city.region ?? null,
        lat: city.latitude ?? null,
        lng: city.longitude ?? null,
      },
      points,
    }, 200, cors);
  } catch (error) {
    console.error("cdek-delivery-points", error);
    return jsonResponse({ error: errorMessage(error) }, 400, cors);
  }
});
