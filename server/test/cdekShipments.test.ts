import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { createCdekShipmentForOrder } from "../src/cdekShipments";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import { HttpError } from "../src/errors";

const orderId = "7c169f01-b459-4e25-b74f-a4909a1b4149";
const orderNumber = "KOM-123456789";

type Shipment = {
  id: number;
  order_id: string;
  status: string;
  cdek_uuid: string | null;
  cdek_number: string | null;
};

type FakeState = {
  shipment: Shipment | null;
  resetCalls: number;
  insertCalls: number;
  resultCalls: number;
  failedCalls: number;
  canceledCalls: number;
};

type FakeDbOptions = {
  initialOrderStatus?: string;
  currentOrderStatus?: string;
  beforeCreationCancelStatus?: string;
};

function config() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://komui_app:secret@127.0.0.1:5432/komui_test",
    CDEK_MOCK: "true",
    CDEK_CREATE_SHIPMENTS: "true",
    CDEK_TARIFF_CODE: "136",
  });
}

function fakeDb(
  existing: Shipment | null = {
    id: 31,
    order_id: orderId,
    status: "failed",
    cdek_uuid: null,
    cdek_number: null,
  },
  options: FakeDbOptions = {},
): { db: Db; state: FakeState } {
  const state: FakeState = {
    shipment: existing,
    resetCalls: 0,
    insertCalls: 0,
    resultCalls: 0,
    failedCalls: 0,
    canceledCalls: 0,
  };

  const query = async <T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[] }> => {
    if (sql.includes("select status") && sql.includes("merch_customer_orders")) {
      return {
        rows: [
          { status: options.currentOrderStatus ?? "paid" } as unknown as T,
        ],
      };
    }
    if (sql.includes("from public.merch_customer_orders")) {
      return {
        rows: [
          {
            id: orderId,
            order_number: orderNumber,
            status: options.initialOrderStatus ?? "paid",
            customer_first_name: "Test",
            customer_last_name: "Customer",
            customer_phone: "+79990000000",
            delivery_point_code: "PVZ-1",
            delivery_city: "Test",
            delivery_address: "Test",
            metadata: {},
          } as unknown as T,
        ],
      };
    }
    if (
      sql.includes("from public.merch_cdek_shipments") &&
      sql.includes("select id")
    ) {
      return {
        rows: state.shipment ? [state.shipment as unknown as T] : [],
      };
    }
    if (sql.includes("from public.merch_customer_order_items")) {
      return {
        rows: [
          {
            product_id: null,
            offer_id: "offer-1",
            sku: "sku-1",
            product_name: "Футболка",
            size: "M",
            quantity: 1,
            unit_price_amount: 300_000,
            product_snapshot: { product_type_slug: "tshirt" },
          } as unknown as T,
        ],
      };
    }
    if (sql.includes("insert into public.merch_cdek_shipments")) {
      state.insertCalls += 1;
      state.shipment = {
        id: 32,
        order_id: orderId,
        status: "creating",
        cdek_uuid: null,
        cdek_number: null,
      };
      return { rows: [state.shipment as unknown as T] };
    }
    if (
      sql.includes("update public.merch_cdek_shipments") &&
      /set\s+status = 'creating'/.test(sql)
    ) {
      state.resetCalls += 1;
      const resettable = Boolean(
        state.shipment &&
          ["pending", "failed", "invalid", "creating"].includes(
            state.shipment.status,
          ),
      );
      if (resettable && state.shipment) state.shipment.status = "creating";
      return {
        rows: resettable && state.shipment
          ? ([{ id: state.shipment.id }] as unknown as T[])
          : [],
      };
    }
    if (
      sql.includes("update public.merch_cdek_shipments") &&
      sql.includes("response_payload")
    ) {
      state.resultCalls += 1;
      if (!state.shipment) throw new Error("shipment missing");
      const expectedStatuses = values[8] as string[];
      if (!expectedStatuses.includes(state.shipment.status)) {
        return { rows: [] };
      }
      state.shipment = {
        ...state.shipment,
        status: String(values[1]),
        cdek_uuid: values[2] ? String(values[2]) : null,
        cdek_number: values[3] ? String(values[3]) : null,
      };
      return { rows: [state.shipment as unknown as T] };
    }
    if (
      sql.includes("update public.merch_cdek_shipments") &&
      sql.includes("status = 'failed'")
    ) {
      state.failedCalls += 1;
      const expectedStatuses = values[2] as string[];
      if (state.shipment && expectedStatuses.includes(state.shipment.status)) {
        state.shipment.status = "failed";
        return { rows: [state.shipment as unknown as T] };
      }
      return { rows: [] };
    }
    if (
      sql.includes("update public.merch_cdek_shipments") &&
      sql.includes("order_not_fulfillable")
    ) {
      state.canceledCalls += 1;
      if (state.shipment && options.beforeCreationCancelStatus) {
        state.shipment.status = options.beforeCreationCancelStatus;
      }
      if (
        state.shipment?.status === "creating" &&
        state.shipment.cdek_uuid === null
      ) {
        state.shipment.status = "deleted";
        return { rows: [state.shipment as unknown as T] };
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  return {
    state,
    db: { query } as unknown as Db,
  };
}

test("ambiguous create retry adopts an existing CDEK order without POST", async () => {
  const { db, state } = fakeDb();
  let lookupCalls = 0;
  let createCalls = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        getOrderByImNumber: async (_config, number) => {
          lookupCalls += 1;
          assert.equal(number, orderNumber);
          return {
            entity: {
              uuid: "adopted-uuid",
              number,
              cdek_number: "1234567890",
            },
            requests: [{ type: "GET", state: "SUCCESSFUL" }],
          };
        },
        createOrder: async () => {
          createCalls += 1;
          throw new Error("POST must not run after reconciliation succeeds");
        },
      },
    },
    { orderId },
  );

  assert.equal(lookupCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(state.resetCalls, 1);
  assert.equal(state.resultCalls, 1);
  assert.equal(shipment?.status, "created");
  assert.equal(shipment?.cdek_uuid, "adopted-uuid");
  assert.equal(shipment?.cdek_number, "1234567890");
});

test("ambiguous create retry never repeats POST after an empty lookup", async () => {
  const { db, state } = fakeDb();
  let createCalls = 0;

  await assert.rejects(
    createCdekShipmentForOrder(
      {
        config: config(),
        db,
        provider: {
          getOrderByImNumber: async () => null,
          createOrder: async () => {
            createCalls += 1;
            return {};
          },
        },
      },
      { orderId },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "cdek_reconciliation_pending");
      assert.equal(error.statusCode, 503);
      return true;
    },
  );

  assert.equal(state.resetCalls, 1);
  assert.equal(state.failedCalls, 1);
  assert.equal(state.shipment?.status, "failed");
  assert.equal(createCalls, 0);
});

test("first CDEK create does not perform reconciliation lookup", async () => {
  const { db, state } = fakeDb(null);
  let lookupCalls = 0;
  let createCalls = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        getOrderByImNumber: async () => {
          lookupCalls += 1;
          return null;
        },
        createOrder: async (_config, payload) => {
          createCalls += 1;
          return {
            entity: {
              uuid: "first-uuid",
              number: payload.number,
              cdek_number: "1111111111",
            },
            requests: [{ type: "CREATE", state: "SUCCESSFUL" }],
          };
        },
      },
    },
    { orderId },
  );

  assert.equal(state.insertCalls, 1);
  assert.equal(lookupCalls, 0);
  assert.equal(createCalls, 1);
  assert.equal(shipment?.cdek_uuid, "first-uuid");
});

test("a queued paid shipment still creates after the order becomes partially refunded", async () => {
  const { db, state } = fakeDb(null, {
    initialOrderStatus: "partially_refunded",
    currentOrderStatus: "partially_refunded",
  });
  let createCalls = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async (_config, payload) => {
          createCalls += 1;
          return {
            entity: {
              uuid: "partial-refund-shipment-uuid",
              number: payload.number,
              cdek_number: "6767676767",
            },
            requests: [{ type: "CREATE", state: "SUCCESSFUL" }],
          };
        },
      },
    },
    { orderId },
  );

  assert.equal(createCalls, 1);
  assert.equal(state.insertCalls, 1);
  assert.equal(shipment?.status, "created");
  assert.equal(shipment?.cdek_uuid, "partial-refund-shipment-uuid");
});

test("direct partial-refund payment review does not create a shipment", async () => {
  const { db, state } = fakeDb(null, {
    initialOrderStatus: "payment_review",
    currentOrderStatus: "payment_review",
  });
  let createCalls = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async () => {
          createCalls += 1;
          return {};
        },
      },
    },
    { orderId },
  );

  assert.equal(shipment, null);
  assert.equal(createCalls, 0);
  assert.equal(state.insertCalls, 0);
});

test("SUCCESSFUL create without UUID stays accepted and later reconciles without another POST", async () => {
  const { db, state } = fakeDb(null);
  let createCalls = 0;
  let numberLookups = 0;

  const ambiguous = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async (_config, payload) => {
          createCalls += 1;
          return {
            entity: { number: payload.number },
            requests: [{ type: "CREATE", state: "SUCCESSFUL" }],
          };
        },
      },
    },
    { orderId },
  );

  assert.equal(createCalls, 1);
  assert.equal(ambiguous?.status, "accepted");
  assert.equal(ambiguous?.cdek_uuid, null);

  const reconciled = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        getOrderByImNumber: async (_config, number) => {
          numberLookups += 1;
          assert.equal(number, orderNumber);
          return {
            entity: {
              uuid: "late-visible-uuid",
              im_number: number,
              cdek_number: "1212121212",
            },
            requests: [{ type: "GET", state: "SUCCESSFUL" }],
          };
        },
        createOrder: async () => {
          createCalls += 1;
          throw new Error("ambiguous create must never repeat POST");
        },
      },
    },
    { orderId },
  );

  assert.equal(numberLookups, 1);
  assert.equal(createCalls, 1);
  assert.equal(reconciled?.status, "created");
  assert.equal(reconciled?.cdek_uuid, "late-visible-uuid");
  assert.equal(reconciled?.cdek_number, "1212121212");
});

test("fresh SUCCESSFUL response with a foreign merchant number is rejected", async () => {
  const { db, state } = fakeDb(null);
  let exactLookups = 0;
  let createCalls = 0;

  await assert.rejects(
    createCdekShipmentForOrder(
      {
        config: config(),
        db,
        provider: {
          createOrder: async () => {
            createCalls += 1;
            return {
              entity: {
                uuid: "foreign-provider-uuid",
                number: "KOM-FOREIGN",
              },
              requests: [{ type: "CREATE", state: "SUCCESSFUL" }],
            };
          },
          getOrderByUuid: async () => {
            exactLookups += 1;
            return {};
          },
        },
      },
      { orderId },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "cdek_create_identity_mismatch");
      return true;
    },
  );

  assert.equal(createCalls, 1);
  assert.equal(exactLookups, 0);
  assert.equal(state.resultCalls, 0);
  assert.equal(state.failedCalls, 1);
  assert.equal(state.shipment?.status, "failed");
  assert.equal(state.shipment?.cdek_uuid, null);
});

test("fresh SUCCESSFUL response with UUID but no merchant number waits for exact identity", async () => {
  const { db, state } = fakeDb(null);
  let createCalls = 0;
  let exactLookups = 0;
  let numberLookups = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async () => {
          createCalls += 1;
          return {
            entity: { uuid: "fresh-provider-uuid" },
            requests: [{ type: "CREATE", state: "SUCCESSFUL" }],
          };
        },
        getOrderByUuid: async (_config, uuid) => {
          exactLookups += 1;
          assert.equal(uuid, "fresh-provider-uuid");
          return {
            entity: {
              uuid,
              im_number: orderNumber,
              cdek_number: "3434343434",
            },
            requests: [{ type: "GET", state: "SUCCESSFUL" }],
          };
        },
        getOrderByImNumber: async () => {
          numberLookups += 1;
          return null;
        },
      },
    },
    { orderId },
  );

  assert.equal(createCalls, 1);
  assert.equal(exactLookups, 1);
  assert.equal(numberLookups, 0);
  assert.equal(state.resultCalls, 1);
  assert.equal(shipment?.status, "created");
  assert.equal(shipment?.cdek_uuid, "fresh-provider-uuid");
  assert.equal(shipment?.cdek_number, "3434343434");
});

test("fresh exact follow-up cannot replace the UUID returned by POST", async () => {
  const { db, state } = fakeDb(null);
  let createCalls = 0;
  let exactLookups = 0;

  await assert.rejects(
    createCdekShipmentForOrder(
      {
        config: config(),
        db,
        provider: {
          createOrder: async () => {
            createCalls += 1;
            return {
              entity: { uuid: "post-response-uuid" },
              requests: [{ type: "CREATE", state: "SUCCESSFUL" }],
            };
          },
          getOrderByUuid: async (_config, uuid) => {
            exactLookups += 1;
            assert.equal(uuid, "post-response-uuid");
            return {
              entity: {
                uuid: "different-follow-up-uuid",
                number: orderNumber,
                cdek_number: "4545454545",
              },
              requests: [{ type: "GET", state: "SUCCESSFUL" }],
            };
          },
        },
      },
      { orderId },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "cdek_create_identity_mismatch");
      assert.equal(error.details.uuidMatches, false);
      return true;
    },
  );

  assert.equal(createCalls, 1);
  assert.equal(exactLookups, 1);
  assert.equal(state.resultCalls, 0);
  assert.equal(state.failedCalls, 1);
  assert.equal(state.shipment?.status, "failed");
  assert.equal(state.shipment?.cdek_uuid, null);
});

test("an existing created shipment converges without another provider POST", async () => {
  const { db } = fakeDb({
    id: 37,
    order_id: orderId,
    status: "created",
    cdek_uuid: "existing-provider-uuid",
    cdek_number: "5656565656",
  });
  let createCalls = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async () => {
          createCalls += 1;
          return {};
        },
      },
    },
    { orderId },
  );

  assert.equal(createCalls, 0);
  assert.equal(shipment?.status, "created");
  assert.equal(shipment?.cdek_uuid, "existing-provider-uuid");
});

test("mismatching or incomplete lookup never repeats CDEK POST", async (context) => {
  for (const scenario of ["mismatch", "ambiguous"] as const) {
    await context.test(scenario, async () => {
      const { db, state } = fakeDb();
      let createCalls = 0;
      await assert.rejects(
        createCdekShipmentForOrder(
          {
            config: config(),
            db,
            provider: {
              getOrderByImNumber: async () =>
                scenario === "mismatch"
                  ? {
                      entity: {
                        uuid: "foreign-uuid",
                        number: "KOM-DIFFERENT",
                      },
                      requests: [{ type: "GET", state: "SUCCESSFUL" }],
                    }
                  : {
                      entity: { uuid: "unknown-owner-uuid" },
                      requests: [{ type: "GET", state: "SUCCESSFUL" }],
                    },
              createOrder: async () => {
                createCalls += 1;
                return {};
              },
            },
          },
          { orderId },
        ),
        (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(
            error.code,
            scenario === "mismatch"
              ? "cdek_reconciliation_mismatch"
              : "cdek_reconciliation_pending",
          );
          if (scenario === "ambiguous") assert.equal(error.statusCode, 503);
          return true;
        },
      );
      assert.equal(createCalls, 0);
      assert.equal(state.resetCalls, 1);
      assert.equal(state.failedCalls, 1);
    });
  }
});

test("lookup network ambiguity defers the effect without repeating POST", async () => {
  const { db, state } = fakeDb();
  let createCalls = 0;

  await assert.rejects(
    createCdekShipmentForOrder(
      {
        config: config(),
        db,
        provider: {
          getOrderByImNumber: async () => {
            throw new TypeError("fetch failed");
          },
          createOrder: async () => {
            createCalls += 1;
            return {};
          },
        },
      },
      { orderId },
    ),
    /fetch failed/,
  );

  assert.equal(createCalls, 0);
  assert.equal(state.resetCalls, 1);
  assert.equal(state.failedCalls, 1);
});

test("known CDEK UUID cannot fall through to POST after provider miss", async (context) => {
  for (const providerDetails of [
    { providerStatus: 404 },
    { providerStatus: 400, providerErrorCode: "v2_entity_not_found" },
  ]) {
    await context.test(JSON.stringify(providerDetails), async () => {
      const { db, state } = fakeDb({
        id: 33,
        order_id: orderId,
        status: "failed",
        cdek_uuid: "known-provider-uuid",
        cdek_number: null,
      });
      let uuidLookups = 0;
      let numberLookups = 0;
      let createCalls = 0;

      await assert.rejects(
        createCdekShipmentForOrder(
          {
            config: config(),
            db,
            provider: {
              getOrderByUuid: async () => {
                uuidLookups += 1;
                throw new HttpError(400, "cdek_request_failed", "Not found", {
                  ...providerDetails,
                });
              },
              getOrderByImNumber: async () => {
                numberLookups += 1;
                return null;
              },
              createOrder: async () => {
                createCalls += 1;
                return {};
              },
            },
          },
          { orderId },
        ),
        (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.code, "cdek_reconciliation_pending");
          assert.equal(error.statusCode, 503);
          return true;
        },
      );

      assert.equal(uuidLookups, 1);
      assert.equal(numberLookups, 1);
      assert.equal(createCalls, 0);
      assert.equal(state.resetCalls, 1);
      assert.equal(state.failedCalls, 1);
    });
  }
});

test("known CDEK UUID is adopted through exact GET before im_number lookup", async () => {
  const { db } = fakeDb({
    id: 34,
    order_id: orderId,
    status: "failed",
    cdek_uuid: "known-provider-uuid",
    cdek_number: null,
  });
  let numberLookups = 0;
  let createCalls = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        getOrderByUuid: async (_config, uuid) => ({
          entity: {
            uuid,
            number: orderNumber,
            cdek_number: "2222222222",
          },
          requests: [{ type: "GET", state: "SUCCESSFUL" }],
        }),
        getOrderByImNumber: async () => {
          numberLookups += 1;
          return null;
        },
        createOrder: async () => {
          createCalls += 1;
          return {};
        },
      },
    },
    { orderId },
  );

  assert.equal(numberLookups, 0);
  assert.equal(createCalls, 0);
  assert.equal(shipment?.cdek_uuid, "known-provider-uuid");
  assert.equal(shipment?.cdek_number, "2222222222");
});

test("accepted CDEK shipment reconciles to created or invalid without another POST", async (context) => {
  for (const scenario of ["created", "invalid"] as const) {
    await context.test(scenario, async () => {
      const { db, state } = fakeDb({
        id: 35,
        order_id: orderId,
        status: "accepted",
        cdek_uuid: "accepted-provider-uuid",
        cdek_number: null,
      });
      let exactLookups = 0;
      let numberLookups = 0;
      let createCalls = 0;

      const shipment = await createCdekShipmentForOrder(
        {
          config: config(),
          db,
          provider: {
            getOrderByUuid: async (_config, uuid) => {
              exactLookups += 1;
              return {
                entity: {
                  uuid,
                  ...(scenario === "created"
                    ? { im_number: orderNumber }
                    : { number: orderNumber }),
                  ...(scenario === "created"
                    ? { cdek_number: "3333333333" }
                    : {}),
                },
                requests: [
                  scenario === "created"
                    ? { type: "CREATE", state: "SUCCESSFUL" }
                    : {
                        type: "CREATE",
                        state: "INVALID",
                        errors: [
                          {
                            code: "invalid_order",
                            message: "Provider rejected the order",
                          },
                        ],
                      },
                ],
              };
            },
            getOrderByImNumber: async () => {
              numberLookups += 1;
              return null;
            },
            createOrder: async () => {
              createCalls += 1;
              return {};
            },
          },
        },
        { orderId },
      );

      assert.equal(exactLookups, 1);
      assert.equal(numberLookups, 0);
      assert.equal(createCalls, 0);
      assert.equal(state.resetCalls, 0);
      assert.equal(state.resultCalls, 1);
      assert.equal(shipment?.status, scenario);
    });
  }
});

test("refund race preserves an existing ambiguous shipment for cancellation reconciliation", async () => {
  const { db, state } = fakeDb(
    {
      id: 36,
      order_id: orderId,
      status: "failed",
      cdek_uuid: null,
      cdek_number: null,
    },
    { currentOrderStatus: "refunded" },
  );
  let createCalls = 0;

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async () => {
          createCalls += 1;
          return {};
        },
      },
    },
    { orderId },
  );

  assert.equal(shipment, null);
  assert.equal(createCalls, 0);
  assert.equal(state.resetCalls, 0);
  assert.equal(state.canceledCalls, 0);
  assert.equal(state.shipment?.status, "failed");
});

test("provider result CAS cannot resurrect a shipment being deleted", async () => {
  const { db, state } = fakeDb(null);

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async (_config, payload) => {
          if (!state.shipment) throw new Error("shipment missing");
          state.shipment.status = "deleting";
          return {
            entity: {
              uuid: "concurrent-provider-uuid",
              number: payload.number,
              cdek_number: "4444444444",
            },
            requests: [{ type: "CREATE", state: "SUCCESSFUL" }],
          };
        },
      },
    },
    { orderId },
  );

  assert.equal(state.resultCalls, 1);
  assert.equal(shipment?.status, "deleting");
  assert.equal(shipment?.cdek_uuid, null);
  assert.equal(state.shipment?.status, "deleting");
});

test("provider failure CAS cannot overwrite a shipment being deleted", async () => {
  const { db, state } = fakeDb(null);

  const shipment = await createCdekShipmentForOrder(
    {
      config: config(),
      db,
      provider: {
        createOrder: async () => {
          if (!state.shipment) throw new Error("shipment missing");
          state.shipment.status = "deleting";
          throw new TypeError("provider connection closed");
        },
      },
    },
    { orderId },
  );

  assert.equal(state.failedCalls, 1);
  assert.equal(shipment?.status, "deleting");
  assert.equal(state.shipment?.status, "deleting");
});

test("local creation-cancel CAS cannot overwrite concurrent deletion", async () => {
  const { db, state } = fakeDb(null, {
    currentOrderStatus: "refunded",
    beforeCreationCancelStatus: "deleting",
  });

  const shipment = await createCdekShipmentForOrder(
    { config: config(), db },
    { orderId },
  );

  assert.equal(state.canceledCalls, 1);
  assert.equal(shipment?.status, "deleting");
  assert.equal(state.shipment?.status, "deleting");
});
