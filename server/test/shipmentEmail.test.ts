import assert from "node:assert/strict";
import test from "node:test";
import { shipmentHandedOverFixture } from "../src/email/templates/shipment-handed-over/fixture";
import { renderShipmentHandedOverEmail } from "../src/email/templates/shipment-handed-over";
import { shipmentReadyFixture } from "../src/email/templates/shipment-ready/fixture";
import { renderShipmentReadyEmail } from "../src/email/templates/shipment-ready";

test("shipment_handed_over renders a compact tracking email", () => {
  const rendered = renderShipmentHandedOverEmail(shipmentHandedOverFixture);

  assert.equal(
    rendered.subject,
    "Заказ KOM-157914345 передан в СДЭК",
  );
  for (const value of [
    "Заказ в пути",
    "KOM-157914345",
    "10317634186",
    "Москва, ул. Тверская, 12, стр. 1",
    "10–12 сентября",
    "https://www.cdek.ru/ru/tracking?order_id=10317634186",
  ]) {
    assert.equal(rendered.text.includes(value), true, value);
    assert.equal(rendered.html.includes(value), true, value);
  }
  assert.match(rendered.html, /^<!doctype html>/);
  assert.match(rendered.html, /komui-wordmark-white@2x\.png/);
  assert.match(rendered.html, /komui-wordmark-dark@2x\.png/);
  assert.equal(rendered.html.includes("ВАШ ЗАКАЗ"), false);
  assert.equal(rendered.html.includes("ИТОГО"), false);
  assert.equal(rendered.text.includes("промокод"), false);
});

test("shipment_ready renders pickup point essentials", () => {
  const rendered = renderShipmentReadyEmail(shipmentReadyFixture);

  assert.equal(rendered.subject, "Заказ KOM-157914345 можно забирать");
  for (const value of [
    "Заказ ждёт вас",
    "СДЭК на Тверской · ПВЗ MSK1234",
    "Москва, ул. Тверская, 12, стр. 1",
    "ежедневно, 10:00–21:00",
    "15 сентября",
    "Открыть отслеживание",
  ]) {
    assert.equal(rendered.text.includes(value), true, value);
    assert.equal(rendered.html.includes(value), true, value);
  }
  assert.match(rendered.html, /МОЖНО ЗАБИРАТЬ/);
  assert.equal(rendered.text.includes("состав заказа"), false);
  assert.equal(rendered.text.includes("акци"), false);
});

test("shipment_ready supports postamats and omits unavailable details", () => {
  const rendered = renderShipmentReadyEmail({
    ...shipmentReadyFixture,
    deliveryPointType: "postamat",
    deliveryPointName: null,
    deliveryPointCode: "MSK999",
    deliveryHours: null,
    storageUntil: null,
  });

  assert.match(rendered.html, /Заказ в постамате/);
  assert.match(rendered.html, /Постамат MSK999/);
  assert.equal(rendered.html.includes("Режим работы"), false);
  assert.equal(rendered.html.includes("Бесплатное хранение до"), false);
});

test("shipment templates escape customer and delivery content", () => {
  const rendered = renderShipmentReadyEmail({
    ...shipmentReadyFixture,
    customerFirstName: "<script>alert(1)</script>",
    deliveryPointName: "ПВЗ <img src=x onerror=alert(1)>",
  });

  assert.equal(rendered.html.includes("<script>alert(1)</script>"), false);
  assert.equal(rendered.html.includes("<img src=x onerror=alert(1)>"), false);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("shipment templates reject missing identifiers and addresses", () => {
  assert.throws(() =>
    renderShipmentHandedOverEmail({
      ...shipmentHandedOverFixture,
      cdekNumber: "",
    }),
  );
  assert.throws(() =>
    renderShipmentReadyEmail({
      ...shipmentReadyFixture,
      deliveryAddress: "",
    }),
  );
});
