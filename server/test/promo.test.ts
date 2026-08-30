import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDiscount,
  markPromoRedemptionRedeemed,
  normalizePromoCode,
  promoPhoneHash,
} from "../src/promo";

test("calculateDiscount caps percent and delivery discounts safely", () => {
  assert.deepEqual(
    calculateDiscount(
      {
        discount_type: "percent",
        discount_value: 2000,
        max_discount_amount: 500_00,
      },
      10_000_00,
      390_00,
    ),
    {
      discountAmount: 500_00,
      deliveryDiscountAmount: 0,
      totalDiscountAmount: 500_00,
      chargedDeliveryAmount: 390_00,
    },
  );

  assert.deepEqual(
    calculateDiscount(
      {
        discount_type: "free_delivery",
        discount_value: 0,
        max_discount_amount: 300_00,
      },
      10_000_00,
      390_00,
    ),
    {
      discountAmount: 0,
      deliveryDiscountAmount: 300_00,
      totalDiscountAmount: 300_00,
      chargedDeliveryAmount: 90_00,
    },
  );
});

test("promo helpers normalize code and hash phone without raw phone retention", () => {
  assert.equal(normalizePromoCode(" komui 10 "), "KOMUI10");
  assert.equal(promoPhoneHash("+7 (999) 533-00-15").length, 64);
});

test("late authoritative payment confirmation reclaims a released promo reservation", async () => {
  let parameters: unknown[] = [];
  await markPromoRedemptionRedeemed(
    {
      query: async (_sql: string, values: unknown[] = []) => {
        parameters = values;
        return { rows: [] };
      },
    },
    "7c169f01-b459-4e25-b74f-a4909a1b4149",
  );

  assert.deepEqual(parameters[1], ["reserved", "released", "redeemed"]);
});
