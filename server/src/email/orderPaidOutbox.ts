import type { PoolClient, QueryResultRow } from "pg";

export type EmailOutboxQueryable = Pick<PoolClient, "query">;

export type EnqueuedOrderPaidEmail = QueryResultRow & {
  id: string;
  order_id: string;
  idempotency_key: string;
  status: string;
};

function boundedContext(
  values: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(values).slice(0, 12)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      result[key] = value;
    } else if (typeof value === "string") {
      result[key] = value.slice(0, 512);
    }
  }
  return result;
}

/**
 * Persist the immutable order_paid snapshot inside the payment transaction.
 *
 * The unique idempotency key makes webhook/reconciliation replays harmless.
 * No provider I/O happens here: the payment transaction only records intent.
 */
export async function enqueueOrderPaidEmail(
  queryable: EmailOutboxQueryable,
  orderId: string,
  context: Record<string, unknown> = {},
): Promise<EnqueuedOrderPaidEmail> {
  const normalizedOrderId = String(orderId ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalizedOrderId,
    )
  ) {
    throw new Error("order_paid outbox orderId must be a UUID");
  }

  const result = await queryable.query<EnqueuedOrderPaidEmail>(
    `
      /* email_outbox:enqueue_order_paid */
      with inserted as (
        insert into public.merch_email_outbox (
          order_id,
          event_type,
          message_class,
          recipient_email,
          template_key,
          payload,
          scheduled_at,
          status,
          idempotency_key
        )
        select
          orders.id,
          'order_paid',
          'transactional',
          lower(btrim(orders.customer_email)),
          'order_paid',
          jsonb_build_object(
            'schemaVersion', 1,
            'customerFirstName', orders.customer_first_name,
            'orderNumber', orders.order_number,
            'items', coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'name', items.product_name,
                    'size', nullif(items.size, ''),
                    'quantity', items.quantity,
                    'lineTotalAmount', items.line_total_amount
                  )
                  order by items.id
                )
                from public.merch_customer_order_items items
                where items.order_id = orders.id
              ),
              '[]'::jsonb
            ),
            'subtotalAmount', orders.subtotal_amount,
            'discountAmount', orders.discount_amount,
            'deliveryAmount', orders.delivery_amount,
            'totalAmount', orders.total_amount,
            'currency', orders.currency,
            'deliveryCity', orders.delivery_city,
            'deliveryAddress', orders.delivery_address,
            'deliveryEta', orders.delivery_eta,
            'enqueueContext', $2::jsonb
          ),
          now(),
          'pending',
          'order-paid:' || orders.id::text
        from public.merch_customer_orders orders
        where orders.id = $1::uuid
          and orders.status = 'paid'
          and exists (
            select 1
            from public.merch_customer_order_items items
            where items.order_id = orders.id
          )
        on conflict (idempotency_key) do nothing
        returning id, order_id, idempotency_key, status
      )
      select id, order_id, idempotency_key, status
      from inserted
      union all
      select id, order_id, idempotency_key, status
      from public.merch_email_outbox
      where idempotency_key = 'order-paid:' || $1::text
        and not exists (select 1 from inserted)
      limit 1
    `,
    [normalizedOrderId, JSON.stringify(boundedContext(context))],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("paid order snapshot is unavailable for email outbox");
  }
  return row;
}
