import type { RenderedEmail } from "../../unisenderGo";

export type OrderPaidItem = {
  name: string;
  size: string | null;
  quantity: number;
  lineTotalAmount: number;
};

export type OrderPaidTemplateInput = {
  customerFirstName: string;
  orderNumber: string;
  items: OrderPaidItem[];
  subtotalAmount: number;
  discountAmount: number;
  deliveryAmount: number;
  totalAmount: number;
  currency: string;
  deliveryCity: string;
  deliveryAddress: string;
  deliveryEta?: string | null;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compactText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function formatMoney(amount: number, currency: string): string {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("Order email amount must be a non-negative integer");
  }
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: currency || "RUB",
    maximumFractionDigits: 0,
  }).format(amount / 100);
}

function normalizedInput(input: OrderPaidTemplateInput) {
  const customerFirstName = compactText(input.customerFirstName, 80);
  const orderNumber = compactText(input.orderNumber, 80);
  const deliveryCity = compactText(input.deliveryCity, 100);
  const deliveryAddress = compactText(input.deliveryAddress, 220);
  const deliveryEta = compactText(input.deliveryEta, 100);
  const items = input.items
    .slice(0, 100)
    .map((item) => ({
      name: compactText(item.name, 160),
      size: compactText(item.size, 20) || null,
      quantity: Number(item.quantity),
      lineTotalAmount: Number(item.lineTotalAmount),
    }));

  if (!orderNumber || items.length === 0) {
    throw new Error("Order email requires an order number and at least one item");
  }
  for (const item of items) {
    if (
      !item.name ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      !Number.isInteger(item.lineTotalAmount) ||
      item.lineTotalAmount < 0
    ) {
      throw new Error("Order email contains an invalid item");
    }
  }
  const subtotalAmount = Number(input.subtotalAmount);
  const discountAmount = Number(input.discountAmount);
  const deliveryAmount = Number(input.deliveryAmount);
  const totalAmount = Number(input.totalAmount);
  for (const amount of [
    subtotalAmount,
    discountAmount,
    deliveryAmount,
    totalAmount,
  ]) {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error("Order email contains an invalid amount");
    }
  }
  const itemSubtotal = items.reduce(
    (sum, item) => sum + item.lineTotalAmount,
    0,
  );
  if (
    itemSubtotal !== subtotalAmount ||
    subtotalAmount - discountAmount + deliveryAmount !== totalAmount
  ) {
    throw new Error("Order email amounts are inconsistent");
  }

  return {
    customerFirstName,
    orderNumber,
    deliveryCity,
    deliveryAddress,
    deliveryEta,
    items,
    subtotalAmount,
    discountAmount,
    deliveryAmount,
    totalAmount,
    subtotal: formatMoney(subtotalAmount, input.currency),
    discount: formatMoney(discountAmount, input.currency),
    delivery: formatMoney(deliveryAmount, input.currency),
    total: formatMoney(totalAmount, input.currency),
    currency: input.currency,
  };
}

export function renderOrderPaidEmail(
  input: OrderPaidTemplateInput,
): RenderedEmail {
  const order = normalizedInput(input);
  const greeting = order.customerFirstName
    ? `${order.customerFirstName}, оплата заказа подтверждена.`
    : "Оплата заказа подтверждена.";
  const destination = [order.deliveryCity, order.deliveryAddress]
    .filter(Boolean)
    .join(", ");

  const itemRows = order.items
    .map((item) => {
      const details = [
        item.size ? `Размер ${escapeHtml(item.size)}` : "",
        `${item.quantity} шт.`,
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e8eaf2;vertical-align:top;">
            <div style="font-size:16px;line-height:1.35;font-weight:700;color:#15161d;">${escapeHtml(item.name)}</div>
            <div style="margin-top:4px;font-size:14px;line-height:1.4;color:#656b80;">${details}</div>
          </td>
          <td style="padding:14px 0 14px 16px;border-bottom:1px solid #e8eaf2;vertical-align:top;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;font-weight:700;color:#15161d;">${escapeHtml(formatMoney(item.lineTotalAmount, order.currency))}</td>
        </tr>`;
    })
    .join("");

  const textItems = order.items
    .map((item) => {
      const size = item.size ? `, размер ${item.size}` : "";
      return `• ${item.name}${size}, ${item.quantity} шт. — ${formatMoney(item.lineTotalAmount, order.currency)}`;
    })
    .join("\n");
  const deliveryText = destination
    ? `Доставка СДЭК: ${destination}${order.deliveryEta ? `. ${order.deliveryEta}` : ""}.`
    : "Доставка: выбранный пункт СДЭК.";
  const amountText = [
    `Товары: ${order.subtotal}`,
    order.discountAmount > 0 ? `Скидка: −${order.discount}` : "",
    `Доставка: ${order.delivery}`,
    `Итого: ${order.total}`,
  ].filter(Boolean);
  const discountRow = order.discountAmount > 0
    ? `<tr>
                  <td style="padding:6px 0;font-size:15px;line-height:1.4;color:#656b80;">Скидка</td>
                  <td style="padding:6px 0 6px 16px;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;color:#147a44;">−${escapeHtml(order.discount)}</td>
                </tr>`
    : "";

  return {
    subject: `Оплата заказа ${order.orderNumber} подтверждена`,
    text: [
      greeting,
      "",
      `Заказ ${order.orderNumber}`,
      textItems,
      "",
      ...amountText,
      "",
      deliveryText,
      "Трек-номер пришлём отдельным письмом, когда передадим заказ в СДЭК.",
      "",
      "Если нужно что-то уточнить, ответьте на это письмо.",
      "KOMUI",
    ].join("\n"),
    html: `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(`Оплата заказа ${order.orderNumber} подтверждена`)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f5fb;color:#15161d;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Заказ ${escapeHtml(order.orderNumber)} оплачен. Трек-номер СДЭК пришлём отдельно.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f5fb;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e1e4ef;border-radius:24px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 12px;">
              <div style="font-size:24px;line-height:1;font-weight:900;letter-spacing:.04em;color:#15161d;">KOMUI<span style="color:#163cff;">.</span></div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;">
              <div style="display:inline-block;padding:7px 11px;border-radius:999px;background:#e9f8ef;color:#147a44;font-size:13px;line-height:1.2;font-weight:700;">Заказ оплачен</div>
              <h1 style="margin:18px 0 10px;font-size:30px;line-height:1.15;color:#15161d;">${escapeHtml(greeting)}</h1>
              <p style="margin:0;font-size:16px;line-height:1.55;color:#656b80;">Начинаем готовить заказ ${escapeHtml(order.orderNumber)}.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:24px;border-top:1px solid #e8eaf2;">
                ${itemRows}
                <tr>
                  <td style="padding:18px 0 6px;font-size:15px;line-height:1.4;color:#656b80;">Товары</td>
                  <td style="padding:18px 0 6px 16px;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;color:#4f5568;">${escapeHtml(order.subtotal)}</td>
                </tr>
                ${discountRow}
                <tr>
                  <td style="padding:6px 0 14px;font-size:15px;line-height:1.4;color:#656b80;">Доставка</td>
                  <td style="padding:6px 0 14px 16px;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;color:#4f5568;">${escapeHtml(order.delivery)}</td>
                </tr>
                <tr>
                  <td style="padding:16px 0 0;border-top:1px solid #e8eaf2;font-size:17px;line-height:1.4;font-weight:800;color:#15161d;">Итого</td>
                  <td style="padding:16px 0 0 16px;border-top:1px solid #e8eaf2;text-align:right;white-space:nowrap;font-size:20px;line-height:1.4;font-weight:900;color:#15161d;">${escapeHtml(order.total)}</td>
                </tr>
              </table>
              <div style="margin-top:26px;padding:18px;border-radius:16px;background:#f3f5fb;">
                <div style="font-size:14px;line-height:1.3;font-weight:800;color:#15161d;">Доставка СДЭК</div>
                <div style="margin-top:6px;font-size:15px;line-height:1.5;color:#4f5568;">${escapeHtml(destination || "Выбранный пункт СДЭК")}${order.deliveryEta ? `<br>${escapeHtml(order.deliveryEta)}` : ""}</div>
              </div>
              <p style="margin:24px 0 0;font-size:15px;line-height:1.55;color:#4f5568;">Трек-номер пришлём отдельным письмом, когда передадим заказ в СДЭК.</p>
              <p style="margin:10px 0 0;font-size:15px;line-height:1.55;color:#4f5568;">Если нужно что-то уточнить, ответьте на это письмо.</p>
            </td>
          </tr>
        </table>
        <div style="max-width:600px;padding:16px 12px 0;font-size:12px;line-height:1.5;color:#8a90a3;text-align:center;">Служебное письмо по заказу ${escapeHtml(order.orderNumber)}.</div>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
