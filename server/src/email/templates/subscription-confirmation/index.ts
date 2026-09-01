import type { RenderedEmail } from "../../unisenderGo";

export type SubscriptionConfirmationTemplateInput = {
  confirmationUrl: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validatedConfirmationUrl(value: unknown): string {
  const raw = String(value ?? "").trim().slice(0, 1_000);
  const url = new URL(raw);
  if (
    url.protocol !== "https:"
    || !["komui.ru", "www.komui.ru", "stage.komui.ru"].includes(url.hostname)
    || url.pathname !== "/email-confirm"
    || !new URLSearchParams(url.hash.slice(1)).get("token")
  ) {
    throw new Error("Subscription confirmation email contains an invalid URL");
  }
  return url.toString();
}

export function renderSubscriptionConfirmationEmail(
  input: SubscriptionConfirmationTemplateInput,
): RenderedEmail {
  const url = validatedConfirmationUrl(input.confirmationUrl);
  const subject = "Подтвердите подписку на письма KOMUI";

  return {
    subject,
    text: [
      "Подтвердите подписку",
      "",
      "Вы оставили этот адрес на сайте KOMUI.",
      "Чтобы получать новости о дропах и специальных предложениях, подтвердите подписку:",
      url,
      "",
      "Ссылка действует 24 часа. Если это были не вы, просто проигнорируйте письмо.",
      "",
      "KOMUI",
      "https://komui.ru",
      "Отписаться: {{UnsubscribeUrl}}",
    ].join("\n"),
    html: `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5fa;color:#14151c;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Один клик — и подписка на письма KOMUI активна.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f5fa;">
    <tr>
      <td align="center" style="padding:26px 12px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e1e4ef;border-radius:24px;overflow:hidden;">
          <tr>
            <td style="padding:26px 28px;background:#1238ff;">
              <a href="https://komui.ru" style="display:inline-block;text-decoration:none;"><img src="https://komui.ru/assets/email/komui-wordmark-white@2x.png" width="120" alt="KOMUI" style="display:block;width:120px;max-width:120px;height:auto;border:0;"></a>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 28px 32px;">
              <div style="font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#1238ff;">Почти готово</div>
              <h1 style="margin:12px 0 14px;font-size:34px;line-height:1.08;letter-spacing:-.025em;color:#14151c;">Подтвердите подписку</h1>
              <p style="margin:0;font-size:16px;line-height:1.6;color:#5f6478;">Вы оставили этот адрес на сайте KOMUI. Подтвердите, что хотите получать новости о дропах и специальных предложениях.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:26px;">
                <tr>
                  <td align="center" style="border-radius:14px;background:#1238ff;">
                    <a href="${escapeHtml(url)}" target="_blank" style="display:block;padding:16px 22px;border-radius:14px;background:#1238ff;color:#ffffff;text-decoration:none;font-size:16px;line-height:1.25;font-weight:800;text-align:center;">Подтвердить подписку&nbsp; →</a>
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:#8a8fa3;">Ссылка действует 24 часа. Если это были не вы, просто проигнорируйте письмо.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;border-top:1px solid #e8eaf2;background:#fafbfe;font-size:11px;line-height:1.5;color:#9a9fb1;">
              KOMUI · <a href="https://komui.ru" style="color:#73798d;text-decoration:underline;">komui.ru</a>
              <span style="color:#c5c9d5;"> · </span>
              <a href="{{UnsubscribeUrl}}" style="color:#9a9fb1;text-decoration:underline;">Отписаться</a>
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
