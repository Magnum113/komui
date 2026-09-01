import assert from "node:assert/strict";
import test from "node:test";
import { orderPaidFixture } from "../src/email/templates/order-paid/fixture";
import { renderOrderPaidEmail } from "../src/email/templates/order-paid";

test("order_paid template renders matching HTML and plaintext order facts", () => {
  const rendered = renderOrderPaidEmail(orderPaidFixture);

  assert.equal(
    rendered.subject,
    "Оплата заказа KOM-123456789 подтверждена",
  );
  for (const value of [
    "KOM-123456789",
    "Футболка-варёнка Сатору Годжо",
    "Худи Gravity",
    "ул. Тестовая, 1",
    "Трек-номер пришлём отдельным письмом",
  ]) {
    assert.equal(rendered.text.includes(value), true, value);
    assert.equal(rendered.html.includes(value), true, value);
  }
  assert.match(rendered.text, /7\s150\s₽/);
  assert.match(rendered.html, /7\s150\s₽/);
  assert.match(rendered.text, /Товары: 6\s800\s₽/);
  assert.match(rendered.text, /Доставка: 350\s₽/);
  assert.match(rendered.html, /^<!doctype html>/);
  assert.match(rendered.html, /<meta name="viewport"/);
  assert.equal(rendered.text.includes("промокод"), false);
  assert.equal(rendered.text.includes("специальн"), false);
  assert.equal(rendered.text.includes("рекоменд"), false);
});

test("order_paid template escapes customer and product content", () => {
  const rendered = renderOrderPaidEmail({
    ...orderPaidFixture,
    customerFirstName: "<script>alert(1)</script>",
    items: [
      {
        ...orderPaidFixture.items[0],
        name: "Футболка <img src=x onerror=alert(1)>",
      },
    ],
    subtotalAmount: 290_000,
    deliveryAmount: 35_000,
    totalAmount: 325_000,
  });

  assert.equal(rendered.html.includes("<script>alert(1)</script>"), false);
  assert.equal(rendered.html.includes("<img src=x onerror=alert(1)>"), false);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("order_paid template rejects incomplete or invalid order data", () => {
  assert.throws(() =>
    renderOrderPaidEmail({
      ...orderPaidFixture,
      items: [],
    }),
  );
  assert.throws(() =>
    renderOrderPaidEmail({
      ...orderPaidFixture,
      totalAmount: -1,
    }),
  );
  assert.throws(() =>
    renderOrderPaidEmail({
      ...orderPaidFixture,
      items: [{ ...orderPaidFixture.items[0], quantity: 0 }],
    }),
  );
  assert.throws(() =>
    renderOrderPaidEmail({
      ...orderPaidFixture,
      totalAmount: 700_000,
    }),
  );
});
