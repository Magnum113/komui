import type { OrderPaidTemplateInput } from "./index";

export const orderPaidFixture: OrderPaidTemplateInput = {
  customerFirstName: "Иван",
  orderNumber: "KOM-123456789",
  items: [
    {
      name: "Футболка-варёнка Сатору Годжо",
      size: "M",
      quantity: 1,
      lineTotalAmount: 290_000,
      imageUrl:
        "https://komui.ru/assets/ozon-main/01-футболка-с-принтом-сатору-годжо.jpg",
    },
    {
      name: "Худи Gravity",
      size: "XL",
      quantity: 1,
      lineTotalAmount: 390_000,
      imageUrl:
        "https://komui.ru/assets/ozon-main/03-худи-с-вышивкой-gravity.jpg",
    },
  ],
  subtotalAmount: 680_000,
  discountAmount: 0,
  deliveryAmount: 35_000,
  totalAmount: 715_000,
  currency: "RUB",
  deliveryCity: "Москва",
  deliveryAddress: "ул. Тестовая, 1",
  deliveryEta: "Ориентировочно 2–3 рабочих дня",
  cdekNumber: "1598765432",
};
