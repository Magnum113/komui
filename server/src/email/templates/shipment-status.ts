import type { RenderedEmail } from "../unisenderGo";

export type ShipmentStatusDetail = {
  label: string;
  value: string;
};

export type ShipmentStatusView = {
  subject: string;
  preheader: string;
  badge: string;
  title: string;
  intro: string;
  orderNumber: string;
  cdekNumber: string;
  sectionLabel: string;
  locationTitle: string;
  details: ShipmentStatusDetail[];
  buttonLabel: string;
  note: string;
  textLead: string;
};

export function compactEmailText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function requiredEmailText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const normalized = compactEmailText(value, maxLength);
  if (!normalized) {
    throw new Error(`Shipment email requires ${label}`);
  }
  return normalized;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cdekTrackingUrl(cdekNumber: string): string {
  return `https://www.cdek.ru/ru/tracking?order_id=${encodeURIComponent(cdekNumber)}`;
}

export function renderShipmentStatusEmail(
  input: ShipmentStatusView,
): RenderedEmail {
  const subject = requiredEmailText(input.subject, "a subject", 180);
  const preheader = requiredEmailText(input.preheader, "a preheader", 220);
  const badge = requiredEmailText(input.badge, "a status badge", 40);
  const title = requiredEmailText(input.title, "a title", 100);
  const intro = requiredEmailText(input.intro, "introductory text", 260);
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
  const sectionLabel = requiredEmailText(
    input.sectionLabel,
    "a section label",
    60,
  );
  const locationTitle = requiredEmailText(
    input.locationTitle,
    "a delivery location",
    240,
  );
  const buttonLabel = requiredEmailText(
    input.buttonLabel,
    "a button label",
    80,
  );
  const note = requiredEmailText(input.note, "a delivery note", 240);
  const textLead = requiredEmailText(input.textLead, "plain-text copy", 260);
  const details = input.details
    .slice(0, 6)
    .map((detail) => ({
      label: compactEmailText(detail.label, 60),
      value: compactEmailText(detail.value, 240),
    }))
    .filter((detail) => detail.label && detail.value);
  const trackingUrl = cdekTrackingUrl(cdekNumber);

  const detailRows = details
    .map(
      (detail) => `<tr>
        <td style="padding:12px 0;border-top:1px solid #e5e7ef;font-size:13px;line-height:1.45;color:#73788b;vertical-align:top;">${escapeHtml(detail.label)}</td>
        <td style="padding:12px 0 12px 20px;border-top:1px solid #e5e7ef;font-size:14px;line-height:1.45;font-weight:700;color:#14151c;text-align:right;vertical-align:top;">${escapeHtml(detail.value)}</td>
      </tr>`,
    )
    .join("");
  const textDetails = details
    .map((detail) => `${detail.label}: ${detail.value}`)
    .join("\n");

  return {
    subject,
    text: [
      title,
      textLead,
      "",
      `Заказ: ${orderNumber}`,
      `Трек-номер: ${cdekNumber}`,
      "",
      locationTitle,
      textDetails,
      "",
      `${buttonLabel}: ${trackingUrl}`,
      note,
      "",
      "Если нужно что-то уточнить, ответьте на это письмо.",
      "",
      "KOMUI",
      "ИП Кадимагомедов Магомедсайгид Алиевич",
      "ИНН 053602598018 · ОГРНИП 325050000200836",
      "https://komui.ru",
    ]
      .filter((line, index, lines) => line || lines[index - 1])
      .join("\n"),
    html: `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(subject)}</title>
  <style>
    @media only screen and (max-width: 640px) {
      .page-pad { padding: 12px 8px !important; }
      .hero-pad { padding: 22px 20px 24px !important; }
      .content-pad { padding: 24px 20px !important; }
      .footer-pad { padding: 20px !important; }
      .hero-title { font-size: 32px !important; }
      .summary-cell { display: block !important; width: auto !important; text-align: left !important; }
      .summary-gap { display: block !important; width: auto !important; height: 10px !important; }
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
                  <td align="right"><span style="display:inline-block;padding:8px 12px;border-radius:999px;background:#ffffff;color:#1238ff;font-size:12px;line-height:1;font-weight:800;letter-spacing:.04em;">${escapeHtml(badge)}</span></td>
                </tr>
              </table>
              <h1 class="hero-title" style="margin:40px 0 10px;font-size:40px;line-height:1.05;letter-spacing:-.03em;color:#ffffff;">${escapeHtml(title)}</h1>
              <p style="margin:0;font-size:17px;line-height:1.55;color:#e9edff;">${escapeHtml(intro)}</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:24px;border-collapse:separate;">
                <tr>
                  <td class="summary-cell" style="padding:15px 16px;border-radius:16px;background:#ffffff;background:rgba(255,255,255,.14);">
                    <div style="font-size:11px;line-height:1.2;font-weight:700;letter-spacing:.09em;color:#d8dfff;">НОМЕР ЗАКАЗА</div>
                    <div style="margin-top:6px;font-size:16px;line-height:1.3;font-weight:800;color:#ffffff;">${escapeHtml(orderNumber)}</div>
                  </td>
                  <td class="summary-gap" width="12" style="width:12px;"></td>
                  <td class="summary-cell" style="padding:15px 16px;border-radius:16px;background:#ffffff;background:rgba(255,255,255,.14);text-align:right;">
                    <div style="font-size:11px;line-height:1.2;font-weight:700;letter-spacing:.09em;color:#d8dfff;">ТРЕК-НОМЕР</div>
                    <div style="margin-top:6px;font-size:16px;line-height:1.3;font-weight:800;color:#ffffff;">${escapeHtml(cdekNumber)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="content-pad" style="padding:30px;background:#ffffff;border-right:1px solid #e5e7ef;border-left:1px solid #e5e7ef;">
              <div style="font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.09em;color:#1238ff;">${escapeHtml(sectionLabel)}</div>
              <div style="margin-top:10px;font-size:22px;line-height:1.3;font-weight:850;color:#14151c;">${escapeHtml(locationTitle)}</div>
              ${detailRows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:18px;">${detailRows}</table>` : ""}

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:24px;">
                <tr>
                  <td align="center" style="border-radius:14px;background:#1238ff;">
                    <a href="${escapeHtml(trackingUrl)}" target="_blank" style="display:block;padding:15px 22px;border-radius:14px;background:#1238ff;color:#ffffff;text-decoration:none;font-size:16px;line-height:1.25;font-weight:800;text-align:center;">${escapeHtml(buttonLabel)}&nbsp; →</a>
                  </td>
                </tr>
              </table>
              <div style="margin-top:12px;font-size:12px;line-height:1.5;color:#8a8fa3;text-align:center;">${escapeHtml(note)}</div>

              <div style="margin-top:28px;padding:20px;border-radius:18px;background:#14151c;color:#ffffff;">
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
              <div style="margin-top:10px;font-size:11px;line-height:1.5;color:#a0a4b3;">Служебное письмо по заказу ${escapeHtml(orderNumber)}.</div>
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
