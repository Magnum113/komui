import type { RenderedEmail } from "../../unisenderGo";

export type OrderPaidItem = {
  name: string;
  size: string | null;
  quantity: number;
  lineTotalAmount: number;
  imageUrl?: string | null;
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
  cdekNumber?: string | null;
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

function publicImageUrl(value: unknown): string | null {
  const raw = compactText(value, 500);
  if (!raw) return null;
  try {
    const url = new URL(raw, "https://komui.ru/");
    if (
      url.protocol !== "https:" ||
      !["komui.ru", "www.komui.ru"].includes(url.hostname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function cdekTrackingUrl(value: unknown): string | null {
  const number = compactText(value, 80);
  if (!number) return null;
  return `https://www.cdek.ru/ru/tracking?order_id=${encodeURIComponent(number)}`;
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
  const cdekNumber = compactText(input.cdekNumber, 80) || null;
  const items = input.items.slice(0, 100).map((item) => ({
    name: compactText(item.name, 160),
    size: compactText(item.size, 20) || null,
    quantity: Number(item.quantity),
    lineTotalAmount: Number(item.lineTotalAmount),
    imageUrl: publicImageUrl(item.imageUrl),
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
    cdekNumber,
    trackingUrl: cdekTrackingUrl(cdekNumber),
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
    ? `${order.customerFirstName}, спасибо за заказ!`
    : "Спасибо за заказ!";
  const destination = [order.deliveryCity, order.deliveryAddress]
    .filter(Boolean)
    .join(", ");

  const itemRows = order.items
    .map((item) => {
      const details = [
        item.size ? `Размер: ${escapeHtml(item.size)}` : "",
        `${item.quantity} шт.`,
      ]
        .filter(Boolean)
        .join(" · ");
      const imageCell = item.imageUrl
        ? `<td class="item-image-cell" width="88" style="width:88px;padding:16px 16px 16px 0;border-bottom:1px solid #e5e7ef;vertical-align:middle;">
            <img class="item-image" src="${escapeHtml(item.imageUrl)}" width="72" alt="" style="display:block;width:72px;max-width:72px;height:auto;border:0;border-radius:14px;background:#f1f2f7;box-shadow:inset 0 0 0 1px rgba(20,21,28,.08);">
          </td>`
        : "";
      return `
        <tr>
          ${imageCell}
          <td style="padding:16px 0;border-bottom:1px solid #e5e7ef;vertical-align:middle;">
            <div style="font-size:16px;line-height:1.35;font-weight:700;color:#14151c;">${escapeHtml(item.name)}</div>
            <div style="margin-top:6px;font-size:14px;line-height:1.4;color:#656a7e;">${details}</div>
          </td>
          <td width="98" style="width:98px;padding:16px 0 16px 12px;border-bottom:1px solid #e5e7ef;vertical-align:middle;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;font-weight:700;color:#14151c;">${escapeHtml(formatMoney(item.lineTotalAmount, order.currency))}</td>
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
  const trackingText = order.trackingUrl
    ? `Отследить заказ в СДЭК: ${order.trackingUrl}`
    : "Трек-номер СДЭК создаётся. Он появится после оформления отправления.";
  const amountText = [
    `Товары: ${order.subtotal}`,
    order.discountAmount > 0 ? `Скидка: −${order.discount}` : "",
    `Доставка: ${order.delivery}`,
    `Итого: ${order.total}`,
  ].filter(Boolean);
  const discountRow = order.discountAmount > 0
    ? `<tr>
          <td style="padding:6px 0;font-size:15px;line-height:1.4;color:#656a7e;">Скидка</td>
          <td style="padding:6px 0 6px 16px;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;color:#147a44;">−${escapeHtml(order.discount)}</td>
        </tr>`
    : "";
  const trackingBlock = order.trackingUrl
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:18px;">
        <tr>
          <td align="center" style="border-radius:14px;background:#1238ff;">
            <a href="${escapeHtml(order.trackingUrl)}" target="_blank" style="display:block;padding:15px 22px;border-radius:14px;background:#1238ff;color:#ffffff;text-decoration:none;font-size:16px;line-height:1.25;font-weight:800;text-align:center;">Отследить в СДЭК&nbsp; →</a>
          </td>
        </tr>
      </table>
      <div style="margin-top:10px;font-size:12px;line-height:1.45;color:#8a8fa3;text-align:center;">Трек-номер: ${escapeHtml(order.cdekNumber)}</div>`
    : `<div style="margin-top:14px;padding:12px 14px;border-radius:12px;background:#ffffff;color:#656a7e;font-size:13px;line-height:1.5;">Трек-номер создаётся. После оформления отправления заказ можно будет отслеживать на сайте СДЭК.</div>`;

  const preheader = order.trackingUrl
    ? `Заказ ${order.orderNumber} оплачен — ссылка СДЭК уже внутри.`
    : `Заказ ${order.orderNumber} оплачен и передан в обработку.`;

  return {
    subject: `Оплата заказа ${order.orderNumber} подтверждена`,
    text: [
      "Оплата прошла",
      greeting,
      `Заказ ${order.orderNumber}`,
      "",
      textItems,
      "",
      ...amountText,
      "",
      deliveryText,
      trackingText,
      "",
      "Что дальше: мы соберём заказ, передадим его в СДЭК и обновим статус доставки.",
      "Если нужно что-то уточнить, ответьте на это письмо.",
      "",
      "KOMUI",
      "ИП Кадимагомедов Магомедсайгид Алиевич",
      "ИНН 053602598018 · ОГРНИП 325050000200836",
      "https://komui.ru",
    ].join("\n"),
    html: `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(`Оплата заказа ${order.orderNumber} подтверждена`)}</title>
  <style>
    @media only screen and (max-width: 640px) {
      .page-pad { padding: 12px 8px !important; }
      .hero-pad { padding: 22px 20px 24px !important; }
      .content-pad { padding: 24px 20px !important; }
      .footer-pad { padding: 20px !important; }
      .hero-title { font-size: 32px !important; }
      .summary-total { font-size: 25px !important; }
      .item-image-cell { width: 68px !important; padding-right: 12px !important; }
      .item-image { width: 58px !important; max-width: 58px !important; border-radius: 12px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f4f5fa;color:#14151c;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f5fa;">
    <tr>
      <td class="page-pad" align="center" style="padding:26px 12px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;">
          <tr>
            <td class="hero-pad" style="padding:28px 30px 30px;border-radius:26px 26px 0 0;background:#1238ff;background-image:linear-gradient(135deg,#0026f9 0%,#173cff 58%,#6f83ff 100%);color:#ffffff;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td><a href="https://komui.ru" style="display:inline-block;text-decoration:none;"><img src="https://komui.ru/assets/email/komui-wordmark-white@2x.png" width="120" alt="KOMUI" style="display:block;width:120px;max-width:120px;height:auto;border:0;"></a></td>
                  <td align="right"><span style="display:inline-block;padding:8px 12px;border-radius:999px;background:#ffffff;color:#1238ff;font-size:12px;line-height:1;font-weight:800;letter-spacing:.04em;">✓ ОПЛАЧЕНО</span></td>
                </tr>
              </table>
              <h1 class="hero-title" style="margin:40px 0 10px;font-size:40px;line-height:1.05;letter-spacing:-.03em;color:#ffffff;">Оплата прошла</h1>
              <p style="margin:0;font-size:17px;line-height:1.55;color:#e9edff;">${escapeHtml(greeting)} Мы уже начинаем готовить его к отправке.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:24px;border-collapse:separate;">
                <tr>
                  <td style="padding:15px 16px;border-radius:16px;background:#ffffff;background:rgba(255,255,255,.14);">
                    <div style="font-size:11px;line-height:1.2;font-weight:700;letter-spacing:.09em;color:#d8dfff;">НОМЕР ЗАКАЗА</div>
                    <div style="margin-top:6px;font-size:16px;line-height:1.3;font-weight:800;color:#ffffff;">${escapeHtml(order.orderNumber)}</div>
                  </td>
                  <td width="12" style="width:12px;"></td>
                  <td style="padding:15px 16px;border-radius:16px;background:#ffffff;background:rgba(255,255,255,.14);text-align:right;">
                    <div style="font-size:11px;line-height:1.2;font-weight:700;letter-spacing:.09em;color:#d8dfff;">ИТОГО</div>
                    <div class="summary-total" style="margin-top:4px;font-size:28px;line-height:1.15;font-weight:900;color:#ffffff;white-space:nowrap;">${escapeHtml(order.total)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="content-pad" style="padding:30px;background:#ffffff;border-right:1px solid #e5e7ef;border-left:1px solid #e5e7ef;">
              <div style="font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.09em;color:#1238ff;">ВАШ ЗАКАЗ</div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:6px;">
                ${itemRows}
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:16px;">
                <tr>
                  <td style="padding:6px 0;font-size:15px;line-height:1.4;color:#656a7e;">Товары</td>
                  <td style="padding:6px 0 6px 16px;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;color:#52566a;">${escapeHtml(order.subtotal)}</td>
                </tr>
                ${discountRow}
                <tr>
                  <td style="padding:6px 0 14px;font-size:15px;line-height:1.4;color:#656a7e;">Доставка</td>
                  <td style="padding:6px 0 14px 16px;text-align:right;white-space:nowrap;font-size:15px;line-height:1.4;color:#52566a;">${escapeHtml(order.delivery)}</td>
                </tr>
                <tr>
                  <td style="padding:16px 0 0;border-top:1px solid #e5e7ef;font-size:17px;line-height:1.4;font-weight:800;color:#14151c;">Итого</td>
                  <td style="padding:16px 0 0 16px;border-top:1px solid #e5e7ef;text-align:right;white-space:nowrap;font-size:22px;line-height:1.3;font-weight:900;color:#14151c;">${escapeHtml(order.total)}</td>
                </tr>
              </table>

              <div style="margin-top:30px;padding:20px;border-radius:18px;background:#f1f3ff;border:1px solid #e0e5ff;">
                <div style="font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.09em;color:#1238ff;">ДОСТАВКА СДЭК</div>
                <div style="margin-top:9px;font-size:16px;line-height:1.45;font-weight:700;color:#14151c;">${escapeHtml(destination || "Выбранный пункт СДЭК")}</div>
                ${order.deliveryEta ? `<div style="margin-top:6px;font-size:14px;line-height:1.45;color:#656a7e;">${escapeHtml(order.deliveryEta)}</div>` : ""}
                ${trackingBlock}
              </div>

              <div style="margin-top:30px;font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.09em;color:#1238ff;">ЧТО ДАЛЬШЕ</div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:14px;">
                <tr>
                  <td width="36" valign="top" style="width:36px;padding:0 12px 16px 0;"><div style="width:28px;height:28px;border-radius:50%;background:#e8f7ef;color:#16834f;font-size:16px;line-height:28px;font-weight:900;text-align:center;">✓</div></td>
                  <td valign="top" style="padding:2px 0 16px;font-size:15px;line-height:1.5;color:#14151c;"><strong>Оплата подтверждена</strong><br><span style="color:#656a7e;">Заказ принят в работу.</span></td>
                </tr>
                <tr>
                  <td width="36" valign="top" style="width:36px;padding:0 12px 16px 0;"><div style="width:28px;height:28px;border-radius:50%;background:#eef1ff;color:#1238ff;font-size:13px;line-height:28px;font-weight:900;text-align:center;">2</div></td>
                  <td valign="top" style="padding:2px 0 16px;font-size:15px;line-height:1.5;color:#14151c;"><strong>Соберём и упакуем</strong><br><span style="color:#656a7e;">Проверим состав заказа перед передачей.</span></td>
                </tr>
                <tr>
                  <td width="36" valign="top" style="width:36px;padding:0 12px 0 0;"><div style="width:28px;height:28px;border-radius:50%;background:#eef1ff;color:#1238ff;font-size:13px;line-height:28px;font-weight:900;text-align:center;">3</div></td>
                  <td valign="top" style="padding:2px 0 0;font-size:15px;line-height:1.5;color:#14151c;"><strong>Передадим в СДЭК</strong><br><span style="color:#656a7e;">Статус доставки обновится у перевозчика.</span></td>
                </tr>
              </table>

              <div style="margin-top:30px;padding:20px;border-radius:18px;background:#14151c;color:#ffffff;">
                <div style="font-size:17px;line-height:1.35;font-weight:800;">Остались вопросы?</div>
                <div style="margin-top:7px;font-size:14px;line-height:1.55;color:#c8cbd6;">Ответьте на это письмо — мы увидим сообщение и поможем с заказом.</div>
              </div>

            </td>
          </tr>
          <tr>
            <td class="footer-pad" style="padding:24px 30px;border:1px solid #e5e7ef;border-top:0;border-radius:0 0 26px 26px;background:#f8f9fc;color:#73788b;text-align:center;">
              <div><a href="https://komui.ru" style="display:inline-block;text-decoration:none;"><img src="https://komui.ru/assets/email/komui-wordmark-dark@2x.png" width="120" alt="KOMUI" style="display:block;width:120px;max-width:120px;height:auto;border:0;margin:0 auto;"></a></div>
              <div style="margin-top:14px;font-size:12px;line-height:1.65;">
                <a href="https://komui.ru/seller" style="color:#52566a;text-decoration:underline;">Продавец</a>&nbsp;&nbsp;·&nbsp;&nbsp;
                <a href="https://komui.ru/offer" style="color:#52566a;text-decoration:underline;">Оферта</a>&nbsp;&nbsp;·&nbsp;&nbsp;
                <a href="https://komui.ru/returns" style="color:#52566a;text-decoration:underline;">Возврат</a>&nbsp;&nbsp;·&nbsp;&nbsp;
                <a href="https://komui.ru/privacy" style="color:#52566a;text-decoration:underline;">Конфиденциальность</a>
              </div>
              <div style="margin-top:12px;font-size:9px;line-height:1.5;color:#a8acba;">ИП Кадимагомедов Магомедсайгид Алиевич<br>ИНН 053602598018 · ОГРНИП 325050000200836</div>
              <div style="margin-top:10px;font-size:11px;line-height:1.5;color:#a0a4b3;">Служебное письмо по заказу ${escapeHtml(order.orderNumber)}.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
