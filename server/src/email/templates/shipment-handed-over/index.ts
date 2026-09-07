import type { RenderedEmail } from "../../unisenderGo";
import {
  compactEmailText,
  renderShipmentStatusEmail,
  requiredEmailText,
} from "../shipment-status";

export type ShipmentHandedOverTemplateInput = {
  customerFirstName: string;
  orderNumber: string;
  cdekNumber: string;
  deliveryCity: string;
  deliveryAddress: string;
  estimatedDeliveryDate?: string | null;
};

export function renderShipmentHandedOverEmail(
  input: ShipmentHandedOverTemplateInput,
): RenderedEmail {
  const customerFirstName = compactEmailText(input.customerFirstName, 80);
  const orderNumber = requiredEmailText(
    input.orderNumber,
    "an order number",
    80,
  );
  const cdekNumber = requiredEmailText(
    input.cdekNumber,
    "a CDEK tracking number",
    80,
  );
  const deliveryCity = compactEmailText(input.deliveryCity, 100);
  const deliveryAddress = requiredEmailText(
    input.deliveryAddress,
    "a delivery address",
    220,
  );
  const estimatedDeliveryDate = compactEmailText(
    input.estimatedDeliveryDate,
    100,
  );
  const destination = [deliveryCity, deliveryAddress].filter(Boolean).join(", ");
  const intro = customerFirstName
    ? `${customerFirstName}, СДЭК принял посылку. Теперь её можно отслеживать.`
    : "СДЭК принял посылку. Теперь её можно отслеживать.";

  return renderShipmentStatusEmail({
    subject: `Заказ ${orderNumber} передан в СДЭК`,
    preheader: "Посылка принята СДЭК и отправилась к вам.",
    badge: "В ПУТИ",
    title: "Заказ в пути",
    intro,
    orderNumber,
    cdekNumber,
    sectionLabel: "ДОСТАВКА",
    locationTitle: destination,
    details: estimatedDeliveryDate
      ? [{ label: "Ожидаемая доставка", value: estimatedDeliveryDate }]
      : [],
    buttonLabel: "Отследить в СДЭК",
    note: "Актуальные статусы и сроки показывает СДЭК.",
    textLead: intro,
  });
}
