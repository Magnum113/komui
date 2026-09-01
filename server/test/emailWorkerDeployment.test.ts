import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const deploy = readFileSync(
  new URL("../../ops/server/komui-deploy-from-git", import.meta.url),
  "utf8",
);
const stagingUnit = readFileSync(
  new URL("../../ops/server/komui-email-worker.service", import.meta.url),
  "utf8",
);
const productionUnit = readFileSync(
  new URL(
    "../../ops/server/komui-production-email-worker.service",
    import.meta.url,
  ),
  "utf8",
);
const stagingWebhookNginx = readFileSync(
  new URL(
    "../../ops/server/komui-stage-unisender-webhook.nginx",
    import.meta.url,
  ),
  "utf8",
);

test("deploy refuses partial email source/schema rollouts", () => {
  assert.match(deploy, /email_mvp_database_signature\(\)/);
  assert.match(deploy, /enforce_email_mvp_compatibility\(\)/);
  assert.match(deploy, /partial email-MVP source set/);
  assert.match(deploy, /email-MVP source\/schema mismatch/);
  assert.match(deploy, /server\/src\/email\/unisenderWebhook\.ts/);
  assert.equal(
    deploy.match(/enforce_email_mvp_compatibility$/gm)?.length,
    2,
  );
});

test("staging and production workers use separate release and env paths", () => {
  assert.match(stagingUnit, /EnvironmentFile=\/etc\/komui\/backend\.env/);
  assert.doesNotMatch(stagingUnit, /backend-staging\.env/);
  assert.match(stagingUnit, /\/opt\/komui\/current\/backend\/dist\/emailWorker\.js/);
  assert.match(productionUnit, /backend-production\.env/);
  assert.match(
    productionUnit,
    /\/opt\/komui\/production-current\/backend\/dist\/emailWorker\.js/,
  );
  for (const unit of [stagingUnit, productionUnit]) {
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /ProtectSystem=strict/);
    assert.match(unit, /Restart=on-failure/);
  }
});

test("staging webhook route bypasses Basic Auth only for the signed callback", () => {
  assert.match(
    stagingWebhookNginx,
    /location = \/api\/v1\/webhooks\/unisender-go/,
  );
  assert.match(stagingWebhookNginx, /auth_basic off/);
  assert.match(
    stagingWebhookNginx,
    /proxy_pass http:\/\/127\.0\.0\.1:3000\/v1\/webhooks\/unisender-go/,
  );
  assert.match(stagingWebhookNginx, /client_max_body_size 1m/);
});
