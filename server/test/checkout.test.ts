import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKETING_CONSENT_SOURCE,
  MARKETING_CONSENT_VERSION,
  marketingConsentEvidence,
  normalizePhone,
  orderNumber,
  validateClientIdentity,
  validatedCart,
} from "../src/checkout";

test("marketing consent evidence records an explicit version and source", () => {
  const acceptedAt = "2026-08-31T18:30:00.000Z";

  assert.deepEqual(marketingConsentEvidence(true, acceptedAt), {
    at: acceptedAt,
    version: MARKETING_CONSENT_VERSION,
    source: MARKETING_CONSENT_SOURCE,
  });
  assert.deepEqual(marketingConsentEvidence(false, acceptedAt), {
    at: null,
    version: null,
    source: null,
  });
});

test("orderNumber uses compact numeric format", () => {
  assert.match(orderNumber(), /^KOM-\d{9}$/);
});

test("validatedCart accepts UUID product ids and safe quantities", () => {
  assert.deepEqual(
    validatedCart([
      {
        id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
        size: "m",
        qty: 2,
      },
    ]),
    [
      {
        id: "7c169f01-b459-4e25-b74f-a4909a1b4149",
        size: "M",
        qty: 2,
      },
    ],
  );
});

test("checkout identity and phone validation reject unsafe input", () => {
  assert.equal(normalizePhone("8 (999) 533-00-15"), "+79995330015");
  assert.throws(() => normalizePhone("+1 555 0100"));
  assert.throws(() => validatedCart([{ id: "not-a-uuid", size: "M", qty: 1 }]));
  assert.throws(() =>
    validateClientIdentity(
      "7c169f01-b459-4e25-b74f-a4909a1b4149",
      "short-token",
    ),
  );
});
