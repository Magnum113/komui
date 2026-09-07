import type { RenderedEmail } from "../../unisenderGo";
import {
  compactEmailText,
  renderShipmentStatusEmail,
  requiredEmailText,
} from "../shipment-status";

export type ShipmentReadyTemplateInput = {
  customerFirstName: string;
  orderNumber: string;
  cdekNumber: string;
  deliveryPointType: "pickup_point" | "postamat";
  deliveryPointName?: string | null;
  deliveryPointCode?: string | null;
  deliveryCity: string;
  deliveryAddress: string;
  deliveryHours?: string | null;
  storageUntil?: string | null;
};

export function renderShipmentReadyEmail(
  input: ShipmentReadyTemplateInput,
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
  const deliveryPointName = compactEmailText(input.deliveryPointName, 160);
  const deliveryPointCode = compactEmailText(input.deliveryPointCode, 40);
  const deliveryHours = compactEmailText(input.deliveryHours, 160);
  const storageUntil = compactEmailText(input.storageUntil, 100);
  const pointLabel = input.deliveryPointType === "postamat" ? "Постамат" : "ПВЗ";
  const intro = customerFirstName
    ? `${customerFirstName}, посылка уже ждёт вас.`
    : "Посылка уже ждёт вас.";
  const pointTitle =
    [deliveryPointName, deliveryPointCode ? `${pointLabel} ${deliveryPointCode}` : ""]
      .filter(Boolean)
      .join(" · ") || `${pointLabel} СДЭК`;
  const destination = [deliveryCity, deliveryAddress].filter(Boolean).join(", ");

  return renderShipmentStatusEmail({
    subject: `Заказ ${orderNumber} можно забирать`,
    preheader:
      input.deliveryPointType === "postamat"
        ? "Посылка уже в выбранном постамате СДЭК."
        : "Посылка уже в выбранном пункте СДЭК.",
    badge: "МОЖНО ЗАБИРАТЬ",
    title:
      input.deliveryPointType === "postamat"
        ? "Заказ в постамате"
        : "Заказ ждёт вас",
    intro,
    orderNumber,
    cdekNumber,
    sectionLabel: "ГДЕ ЗАБРАТЬ",
    locationTitle: pointTitle,
    details: [
      { label: "Адрес", value: destination },
      { label: "Режим работы", value: deliveryHours },
      { label: "Бесплатное хранение до", value: storageUntil },
    ],
    buttonLabel: "Открыть отслеживание",
    note: "Если для выдачи нужен код, СДЭК пришлёт его отдельно.",
    textLead: intro,
  });
}
