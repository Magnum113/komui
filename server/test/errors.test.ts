import assert from "node:assert/strict";
import test from "node:test";
import { errorDiagnostic } from "../src/errors";

test("errorDiagnostic includes nested fetch cause and code", () => {
  const cause = Object.assign(new Error("self-signed certificate in certificate chain"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });
  const error = new TypeError("fetch failed", { cause });

  assert.deepEqual(errorDiagnostic(error), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
    message: "fetch failed: self-signed certificate in certificate chain",
  });
});
