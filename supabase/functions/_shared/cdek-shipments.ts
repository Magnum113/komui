import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildCdekOrderRequest,
  buildCdekPackages,
  cdekConfig,
  cdekFirstError,
  cdekNumberFromResponse,
  cdekRequestState,
  createCdekOrder,
  quoteCdekDelivery,
} from "./cdek.ts";

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  delivery_point_code: string;
  delivery_city: string;
  delivery_address: string;
  metadata: Record<string, unknown>;
};

type OrderItemRow = {
  product_id: string | null;
  offer_id: string | null;
  sku: string | null;
  product_name: string;
  size: string;
  quantity: number;
  unit_price_amount: number;
  product_snapshot: Record<string, unknown>;
};

type ShipmentRow = {
  id: number;
  order_id: string;
  status: string;
  cdek_uuid: string | null;
  cdek_number: string | null;
};

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedMetadata(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return metadataObject(source[key]);
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function existingShipment(
  admin: SupabaseClient,
  orderId: string,
): Promise<ShipmentRow | null> {
  const { data, error } = await admin
    .from("merch_cdek_shipments")
    .select("id,order_id,status,cdek_uuid,cdek_number")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw error;
  return data as ShipmentRow | null;
}

export async function createCdekShipmentForOrder(
  admin: SupabaseClient,
  orderId: string,
): Promise<ShipmentRow | null> {
  const found = await existingShipment(admin, orderId);
  if (found && !["failed", "invalid"].includes(found.status)) return found;

  const { data: order, error: orderError } = await admin
    .from("merch_customer_orders")
    .select(
      "id,order_number,status,customer_first_name,customer_last_name,customer_phone,delivery_point_code,delivery_city,delivery_address,metadata",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) throw orderError;
  if (!order) throw new Error("Order not found for CDEK shipment");

  const orderRow = order as OrderRow;
  if (!["paid", "authorized"].includes(orderRow.status)) return null;

  const { data: items, error: itemsError } = await admin
    .from("merch_customer_order_items")
    .select(
      "product_id,offer_id,sku,product_name,size,quantity,unit_price_amount,product_snapshot",
    )
    .eq("order_id", orderId);
  if (itemsError) throw itemsError;

  const itemRows = (items ?? []) as OrderItemRow[];
  const packages = buildCdekPackages(
    orderRow.order_number,
    itemRows.map((item) => ({
      productId: item.product_id,
      offerId: item.offer_id,
      sku: item.sku,
      productName: item.product_name,
      size: item.size,
      quantity: item.quantity,
      unitPriceAmount: item.unit_price_amount,
      profileKey: text(item.product_snapshot?.cdek_profile, 40),
    })),
  );

  const cdekMetadata = nestedMetadata(orderRow.metadata, "cdek");
  const configuredTariffCode = cdekConfig().tariffCode;
  let tariffCode = numberValue(cdekMetadata.tariff_code) ?? configuredTariffCode;
  let tariffName = text(cdekMetadata.tariff_name, 160) || null;

  if (!tariffCode) {
    const deliveryCityCode = numberValue(cdekMetadata.delivery_city_code);
    if (!deliveryCityCode) {
      throw new Error("CDEK delivery city code is missing");
    }
    const quote = await quoteCdekDelivery({
      deliveryCityCode,
      packages,
    });
    tariffCode = quote.tariffCode;
    tariffName = quote.tariffName;
  }

  const requestPayload = buildCdekOrderRequest({
    number: orderRow.order_number,
    tariffCode,
    deliveryPoint: orderRow.delivery_point_code,
    recipientName:
      `${orderRow.customer_last_name} ${orderRow.customer_first_name}`.trim(),
    recipientPhone: orderRow.customer_phone,
    packages,
    comment: `KOMUI ${orderRow.order_number}`,
  });

  let shipment: ShipmentRow | null = found;
  if (!shipment) {
    const { data: inserted, error: insertError } = await admin
      .from("merch_cdek_shipments")
      .insert({
        order_id: orderId,
        status: "creating",
        tariff_code: tariffCode,
        tariff_name: tariffName,
        shipment_point: requestPayload.shipment_point,
        delivery_point: requestPayload.delivery_point,
        delivery_city: orderRow.delivery_city,
        delivery_address: orderRow.delivery_address,
        package_snapshot: packages,
        request_payload: requestPayload,
      })
      .select("id,order_id,status,cdek_uuid,cdek_number")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        return await existingShipment(admin, orderId);
      }
      throw insertError;
    }
    shipment = inserted as ShipmentRow;
  } else {
    const { error: updateError } = await admin
      .from("merch_cdek_shipments")
      .update({
        status: "creating",
        tariff_code: tariffCode,
        tariff_name: tariffName,
        shipment_point: requestPayload.shipment_point,
        delivery_point: requestPayload.delivery_point,
        delivery_city: orderRow.delivery_city,
        delivery_address: orderRow.delivery_address,
        package_snapshot: packages,
        request_payload: requestPayload,
        error_code: null,
        error_message: null,
      })
      .eq("id", shipment.id);
    if (updateError) throw updateError;
  }

  try {
    const response = await createCdekOrder({
      number: orderRow.order_number,
      tariffCode,
      deliveryPoint: orderRow.delivery_point_code,
      recipientName:
        `${orderRow.customer_last_name} ${orderRow.customer_first_name}`.trim(),
      recipientPhone: orderRow.customer_phone,
      packages,
      comment: `KOMUI ${orderRow.order_number}`,
    });
    const firstRequest = response.requests?.[0] ?? {};
    const firstError = cdekFirstError(response);
    const nextStatus = cdekRequestState(response);

    const { data: updated, error: updateError } = await admin
      .from("merch_cdek_shipments")
      .update({
        status: nextStatus,
        cdek_uuid: response.entity?.uuid ?? null,
        cdek_number: cdekNumberFromResponse(response),
        request_uuid: firstRequest.request_uuid ?? null,
        response_payload: response,
        error_code: firstError?.code ?? null,
        error_message: firstError?.message ?? null,
        synced_at: new Date().toISOString(),
      })
      .eq("id", shipment!.id)
      .select("id,order_id,status,cdek_uuid,cdek_number")
      .single();
    if (updateError) throw updateError;
    return updated as ShipmentRow;
  } catch (error) {
    await admin.from("merch_cdek_shipments").update({
      status: "failed",
      error_message: error instanceof Error ? error.message.slice(0, 500) : String(error),
      synced_at: new Date().toISOString(),
    }).eq("id", shipment!.id);
    throw error;
  }
}
