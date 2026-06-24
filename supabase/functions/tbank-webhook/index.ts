import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import {
  createTbankToken,
  parseTbankBody,
  safeEqual,
  sanitizedTbankPayload,
  sha256Hex,
  tbankConfig,
} from "../_shared/tbank.ts";

function text(value: unknown, maxLength = 500): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function orderStatus(providerStatus: string): string | null {
  switch (providerStatus) {
    case "CONFIRMED":
      return "paid";
    case "AUTHORIZED":
      return "authorized";
    case "REFUNDED":
      return "refunded";
    case "PARTIAL_REFUNDED":
      return "partially_refunded";
    case "REJECTED":
    case "CANCELED":
    case "REVERSED":
    case "DEADLINE_EXPIRED":
      return "payment_failed";
    default:
      return null;
  }
}

function canApplyStatus(currentStatus: string, nextStatus: string): boolean {
  switch (currentStatus) {
    case "paid":
      return ["paid", "partially_refunded", "refunded"].includes(nextStatus);
    case "partially_refunded":
      return ["partially_refunded", "refunded"].includes(nextStatus);
    case "refunded":
      return nextStatus === "refunded";
    case "payment_review":
      return ["paid", "partially_refunded", "refunded"].includes(nextStatus);
    default:
      return true;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await parseTbankBody(request);
    const token = text(body.Token, 128);
    const paymentId = text(body.PaymentId, 120);
    const number = text(body.OrderId, 36);
    const providerStatus = text(body.Status, 80);
    const amount = integer(body.Amount);
    const { terminalKey, password } = tbankConfig();

    if (text(body.TerminalKey, 40) !== terminalKey || !token) {
      return new Response("Invalid terminal", { status: 403 });
    }

    const expectedToken = await createTbankToken(body, password);
    if (!safeEqual(token, expectedToken)) {
      console.warn("T-Bank webhook signature mismatch", {
        paymentId,
        orderId: number,
      });
      return new Response("Invalid token", { status: 403 });
    }

    const admin = createAdminClient();
    let attemptQuery = admin
      .from("merch_payment_attempts")
      .select("id, order_id, amount");
    attemptQuery = paymentId
      ? attemptQuery.eq("external_payment_id", paymentId)
      : attemptQuery.eq("id", -1);
    const { data: attempt } = await attemptQuery.maybeSingle();

    let order = null;
    if (attempt?.order_id) {
      const result = await admin
        .from("merch_customer_orders")
        .select("id, order_number, total_amount, status, paid_at")
        .eq("id", attempt.order_id)
        .maybeSingle();
      order = result.data;
    } else if (number) {
      const result = await admin
        .from("merch_customer_orders")
        .select("id, order_number, total_amount, status, paid_at")
        .eq("order_number", number)
        .maybeSingle();
      order = result.data;
    }

    if (!order) {
      console.error("T-Bank webhook order not found", { paymentId, number });
      return new Response("Order not found", { status: 404 });
    }

    const canonicalPayload = sanitizedTbankPayload(body);
    const eventHash = await sha256Hex(JSON.stringify(
      Object.fromEntries(
        Object.entries(canonicalPayload).sort(([left], [right]) =>
          left.localeCompare(right)
        ),
      ),
    ));

    await admin.from("merch_payment_events").upsert({
      payment_attempt_id: attempt?.id ?? null,
      order_id: order.id,
      external_payment_id: paymentId || null,
      provider_status: providerStatus || null,
      event_hash: eventHash,
      signature_valid: true,
      amount,
      payload: canonicalPayload,
    }, { onConflict: "event_hash", ignoreDuplicates: true });

    if (attempt?.id) {
      const attemptUpdate: Record<string, unknown> = {
        provider_status: providerStatus || "UNKNOWN",
      };
      if (providerStatus === "CONFIRMED") {
        attemptUpdate.confirmed_at = new Date().toISOString();
      }
      await admin.from("merch_payment_attempts").update(attemptUpdate)
        .eq("id", attempt.id);
    }

    const nextStatus = orderStatus(providerStatus);
    if (nextStatus) {
      if (
        providerStatus === "CONFIRMED" &&
        (amount === null || amount !== order.total_amount)
      ) {
        if (!["paid", "partially_refunded", "refunded"].includes(order.status)) {
          await admin.from("merch_customer_orders").update({
            status: "payment_review",
            metadata: {
              payment_review_reason: "amount_mismatch",
              expected_amount: order.total_amount,
              received_amount: amount,
            },
          }).eq("id", order.id);
        }
      } else if (canApplyStatus(order.status, nextStatus)) {
        const orderUpdate: Record<string, unknown> = {
          status: nextStatus,
        };
        if (nextStatus === "paid" && !order.paid_at) {
          orderUpdate.paid_at = new Date().toISOString();
        }
        await admin.from("merch_customer_orders").update(orderUpdate)
          .eq("id", order.id);
      }
    }

    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.error("tbank-webhook", error);
    return new Response("Internal error", { status: 500 });
  }
});
