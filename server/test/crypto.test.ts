import assert from "node:assert/strict";
import test from "node:test";
import {
  createTbankToken,
  safeEqual,
  sanitizedTbankPayload,
  sha256Hex,
} from "../src/crypto";

test("createTbankToken signs sorted scalar fields and ignores nested fields", () => {
  const token = createTbankToken(
    {
      TerminalKey: "T",
      Amount: 100,
      OrderId: "42",
      Success: true,
      DATA: { ignored: true },
      Receipt: { ignored: true },
      Token: "old-token",
    },
    "pwd",
  );

  assert.equal(
    token,
    "53b37ce800c3ea3d6b5a500809e43e97cfc07b7764363889fcf98d2b36273cce",
  );
});

test("safeEqual compares hashes without leaking Token in sanitized payload", () => {
  const hash = sha256Hex("payload");

  assert.equal(safeEqual(hash.toUpperCase(), hash), true);
  assert.equal(safeEqual(hash, sha256Hex("other")), false);
  assert.deepEqual(sanitizedTbankPayload({ Token: "secret", Status: "OK" }), {
    Status: "OK",
  });
});
