import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const checkoutHtml = readFileSync(
  new URL("../../checkout.html", import.meta.url),
  "utf8",
);
const paymentResultHtml = readFileSync(
  new URL("../../payment-result.html", import.meta.url),
  "utf8",
);

test("checkout keeps the idempotency draft and redirects ambiguous Init to status polling", () => {
  assert.match(checkoutHtml, /error\.code==='payment_reconciliation_pending'/);
  assert.match(checkoutHtml, /komui-payment-session:'\+pendingOrder/);
  assert.match(
    checkoutHtml,
    /location\.assign\('\/payment-result\?status=pending&order='/,
  );

  const pendingBranch = checkoutHtml.slice(
    checkoutHtml.indexOf("error.code==='payment_reconciliation_pending'"),
    checkoutHtml.indexOf("throw error;"),
  );
  assert.doesNotMatch(pendingBranch, /clearPaymentDraft\(\)/);
});

test("payment result copy distinguishes review, failure and refunds", () => {
  assert.match(
    paymentResultHtml,
    /Банк вернул неоднозначный результат\. Заказ не отмечен оплаченным/,
  );
  assert.match(paymentResultHtml, /Не создавайте повторный платёж/);
  assert.doesNotMatch(paymentResultHtml, /до проверки суммы/);
  assert.match(paymentResultHtml, /if\(result\.status==='refunded'\)\{refunded\(false\)/);
  assert.match(
    paymentResultHtml,
    /if\(result\.status==='partially_refunded'\)\{refunded\(true\)/,
  );
  assert.match(paymentResultHtml, /Банк подтвердил полный возврат по заказу/);
  assert.match(paymentResultHtml, /Банк подтвердил частичный возврат по заказу/);
  assert.doesNotMatch(
    paymentResultHtml,
    /\['payment_failed','canceled','refunded'\]/,
  );
});
