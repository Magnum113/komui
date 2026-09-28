import type { PoolClient } from "pg";
import { renderShipmentStatusEmail } from "./templates/shipment-status";

export type OzonEmailEvent = "shipment_handed_over" | "shipment_ready";

export function renderOzonShipmentEmail(input: {
  customerFirstName: string; orderNumber: string; cdekNumber: string;
  deliveryCity: string; deliveryAddress: string; deliveryHours?: string | null;
}, event: OzonEmailEvent) {
  const ready = event === "shipment_ready";
  const title = ready ? "Заказ ждёт вас" : "Заказ в пути";
  const intro = ready ? "Посылка поступила в выбранный пункт Ozon. Код получения доступен в приложении Ozon." : "Ozon принял посылку. Следите за доставкой в приложении Ozon.";
  return renderShipmentStatusEmail({
    deliveryProvider: "ozon", subject: `Заказ ${input.orderNumber} ${ready ? "можно забирать" : "передан в Ozon"}`,
    preheader: intro, badge: ready ? "МОЖНО ЗАБИРАТЬ" : "В ПУТИ", title, intro,
    orderNumber: input.orderNumber, cdekNumber: input.cdekNumber,
    sectionLabel: ready ? "ГДЕ ЗАБРАТЬ" : "ДОСТАВКА OZON",
    locationTitle: [input.deliveryCity, input.deliveryAddress].filter(Boolean).join(", "),
    details: input.deliveryHours ? [{ label: "Режим работы", value: input.deliveryHours }] : [],
    buttonLabel: "Открыть Ozon", note: "Откройте раздел «Ozon Доставка» в приложении Ozon для статуса и кода получения.", textLead: intro,
  });
}

/** Called only for a verified current physical status inside the shipment transaction. */
export async function enqueueOzonShippingEmail(client: Pick<PoolClient, "query">, orderId: string, event: OzonEmailEvent, postingNumber: string): Promise<void> {
  await client.query(`
    /* ozon_delivery:enqueue_email */
    insert into public.merch_email_outbox
      (order_id,contact_id,event_type,message_class,recipient_email,template_key,payload,idempotency_key)
    select o.id,c.id,$2,'transactional',lower(btrim(o.customer_email)),$2,
      jsonb_build_object('schemaVersion',1,'deliveryProvider','ozon',
        'customerFirstName',left(o.customer_first_name,80),'orderNumber',o.order_number,
        'cdekNumber',$3::text,'deliveryCity',left(o.delivery_city,100),'deliveryAddress',left(o.delivery_address,220),
        'deliveryPointType','pickup_point','deliveryPointCode',left(o.delivery_point_code,40),
        'deliveryHours',left(o.delivery_hours,160)),
      replace($2::text,'_','-') || ':' || o.id::text || ':ozon:' || $3::text
    from public.merch_customer_orders o
    left join public.merch_email_contacts c on c.email_normalized=lower(btrim(o.customer_email))
    where o.id=$1::uuid and o.delivery_provider='ozon'
      and o.status in ('paid','partially_refunded')
      and o.fulfillment_status not in ('canceled','returned')
      and o.customer_email is not null and btrim(o.customer_email) <> ''
    on conflict (idempotency_key) do nothing
  `, [orderId,event,postingNumber]);
}
