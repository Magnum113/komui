import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCdekOrderRequest,
  buildCdekPackages,
  cdekFirstError,
  cdekNumberFromResponse,
  cdekRequestState,
  createCdekOrder,
  quoteCdekDelivery,
} from "../src/cdek";
import { loadConfig } from "../src/config";

test("buildCdekPackages uses hoodie profile and preserves non-payment items", () => {
  const packages = buildCdekPackages("KOM-TEST", [
    {
      productId: "7c169f01-b459-4e25-b74f-a4909a1b4149",
      productName: "Худи KOMUI",
      size: "L",
      quantity: 2,
      unitPriceAmount: 4_900_00,
      productTypeSlug: "hoodie",
    },
  ]);

  assert.equal(packages.length, 1);
  assert.equal(packages[0].number, "KOM-TEST");
  assert.equal(packages[0].weight, 700);
  assert.equal(packages[0].items?.[0]?.payment.value, 0);
  assert.equal(packages[0].items?.[0]?.cost, 4900);
});

test("quoteCdekDelivery returns deterministic staging quote in mock mode", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
    CDEK_MOCK: "true",
  });

  const quote = await quoteCdekDelivery(config, {
    deliveryCityCode: 44,
    tariffCode: 136,
    packages: buildCdekPackages("KOM-TEST", [
      {
        productName: "Футболка",
        quantity: 1,
        unitPriceAmount: 2_500_00,
        productTypeSlug: "tshirt",
      },
    ]),
  });

  assert.equal(quote.amountKopecks, 39_000);
  assert.equal(quote.tariffCode, 136);
  assert.equal(quote.deliveryMode, 4);
});

test("buildCdekOrderRequest creates CDEK order payload", () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
    CDEK_MOCK: "true",
    CDEK_SHIPMENT_POINT: "MKHCH20",
    CDEK_SENDER_NAME: "Komui",
    CDEK_SENDER_PHONE: "+79995330015",
  });
  const packages = buildCdekPackages("KOM-123456789", [
    {
      productName: "Футболка",
      size: "M",
      quantity: 1,
      unitPriceAmount: 3_900_00,
      productTypeSlug: "tshirt",
    },
  ]);

  const payload = buildCdekOrderRequest(config, {
    number: "KOM-123456789",
    tariffCode: 136,
    deliveryPoint: "MSK123",
    recipientName: "Иван Иванов",
    recipientPhone: "+79990000000",
    packages,
    comment: "KOMUI KOM-123456789",
  });

  assert.equal(payload.type, 1);
  assert.equal(payload.number, "KOM-123456789");
  assert.equal(payload.tariff_code, 136);
  assert.equal(payload.shipment_point, "MKHCH20");
  assert.equal(payload.delivery_point, "MSK123");
  assert.equal(payload.sender.phones[0]?.number, "+79995330015");
  assert.equal(payload.recipient.phones[0]?.number, "+79990000000");
  assert.equal(payload.delivery_recipient_cost.value, 0);
  assert.equal(payload.packages[0]?.items?.[0]?.payment.value, 0);
});

test("CDEK order response helpers normalize states and errors", () => {
  const accepted = {
    requests: [{ state: "ACCEPTED", request_uuid: "req-1" }],
    related_entities: [{ type: "waybill", cdek_number: "1234567890" }],
  };

  assert.equal(cdekRequestState(accepted), "accepted");
  assert.equal(cdekNumberFromResponse(accepted), "1234567890");
  assert.equal(cdekFirstError(accepted), null);

  const invalid = {
    requests: [
      {
        state: "INVALID",
        errors: [{ code: "ERR", message: "Bad payload" }],
      },
    ],
  };

  assert.equal(cdekRequestState(invalid), "invalid");
  assert.deepEqual(cdekFirstError(invalid), {
    code: "ERR",
    message: "Bad payload",
  });
});

test("createCdekOrder returns deterministic mock order without network calls", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_staging",
    CDEK_MOCK: "true",
  });
  const packages = buildCdekPackages("KOM-123456789", [
    {
      productName: "Футболка",
      quantity: 1,
      unitPriceAmount: 3_900_00,
    },
  ]);

  const response = await createCdekOrder(config, {
    number: "KOM-123456789",
    tariffCode: 136,
    deliveryPoint: "KOMUI-STAGE-PVZ",
    recipientName: "Иван Иванов",
    recipientPhone: "+79990000000",
    packages,
  });

  assert.equal(response.entity?.uuid, "mock-cdek-order-KOM-123456789");
  assert.equal(response.requests?.[0]?.state, "ACCEPTED");
  assert.equal(cdekRequestState(response), "accepted");
  assert.equal(cdekNumberFromResponse(response), "MOCK-KOM-123456789");
});
