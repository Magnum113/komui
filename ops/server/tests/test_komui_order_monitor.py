from __future__ import annotations

import importlib.machinery
import importlib.util
import unittest
from pathlib import Path


MONITOR_PATH = Path(__file__).resolve().parents[1] / "komui-order-monitor"


def load_monitor_module():
    loader = importlib.machinery.SourceFileLoader("komui_order_monitor_test", str(MONITOR_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class OrderMonitorAlertTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.monitor = load_monitor_module()

    def empty_report(self) -> dict:
        return {
            "newOrders": {"count": 0, "items": []},
            "networkErrors": {"count": 0, "items": []},
            "initUnknowns": {"count": 0, "items": []},
            "duplicateOrders": {"count": 0, "items": []},
            "rapidCustomers": {"count": 0, "items": []},
            "repeatedFailures": {"count": 0, "items": []},
            "failureSpike": None,
            "ordersWithoutItems": {"count": 0, "items": []},
            "paymentReviews": {"count": 0, "items": []},
            "cdekEffectReviews": {"count": 0, "items": []},
            "cdekFailures": {"count": 0, "items": []},
            "paidWithoutShipment": [],
        }

    def test_empty_report_does_not_alert(self) -> None:
        body, active = self.monitor.build_alert(self.empty_report(), set())

        self.assertIsNone(body)
        self.assertEqual(active, set())

    def test_formats_duplicate_and_network_alert_without_full_phone(self) -> None:
        report = self.empty_report()
        report["networkErrors"] = {
            "count": 1,
            "items": [{"orderNumber": "KOM-101", "errorCode": "ETIMEDOUT"}],
        }
        report["duplicateOrders"] = {
            "count": 1,
            "items": [
                {
                    "previousOrderNumber": "KOM-100",
                    "orderNumber": "KOM-101",
                    "phoneTail": "9123",
                    "secondsApart": 1.25,
                }
            ],
        }

        body, _ = self.monitor.build_alert(report, set())

        self.assertIn("Т-Банк недоступен", body)
        self.assertIn("KOM-100 → KOM-101", body)
        self.assertIn("••••9123", body)
        self.assertNotIn("+7999", body)

    def test_formats_new_order_with_items_status_and_masked_phone(self) -> None:
        report = self.empty_report()
        report["newOrders"] = {
            "count": 1,
            "items": [
                {
                    "orderId": "11111111-1111-4111-8111-111111111111",
                    "orderNumber": "KOM-123456789",
                    "status": "pending_payment",
                    "phoneTail": "0015",
                    "deliveryCity": "Москва",
                    "deliveryPointCode": "MSK123",
                    "totalAmount": 325050,
                    "promoCode": "WELCOME",
                    "createdAt": "2026-08-21T10:15:00Z",
                    "items": [
                        {
                            "productName": "Худи Gravity",
                            "size": "XL",
                            "quantity": 2,
                            "lineTotalAmount": 290000,
                        }
                    ],
                }
            ],
        }

        body, _ = self.monitor.build_alert(report, set())

        self.assertIn("Новый заказ KOM-123456789", body)
        self.assertIn("21.08.2026, 13:15 МСК", body)
        self.assertIn("ожидает оплаты", body)
        self.assertIn("3 250,50 ₽", body)
        self.assertIn("Москва · ПВЗ MSK123", body)
        self.assertIn("Худи Gravity · XL × 2", body)
        self.assertIn("••••0015", body)
        self.assertNotIn("+79995330015", body)

    def test_new_order_sql_uses_bounded_cursor_window(self) -> None:
        sql = self.monitor.render_sql("2026-08-21T10:00:00Z", 5)

        self.assertIn("o.created_at > p.order_since_at", sql)
        self.assertIn("o.created_at <= p.checked_at", sql)
        self.assertIn("'newOrders'", sql)

    def test_overlap_filters_already_notified_orders(self) -> None:
        report = self.empty_report()
        report["newOrders"] = {
            "count": 2,
            "items": [
                {"orderId": "old-id", "orderNumber": "KOM-100"},
                {"orderId": "new-id", "orderNumber": "KOM-101"},
            ],
        }

        unseen = self.monitor.filter_notified_orders(report, {"old-id"})
        merged = self.monitor.merge_notified_order_ids(["old-id"], unseen)

        self.assertEqual(unseen, ["new-id"])
        self.assertEqual(report["newOrders"]["count"], 1)
        self.assertEqual(report["newOrders"]["items"][0]["orderNumber"], "KOM-101")
        self.assertEqual(merged, ["old-id", "new-id"])

    def test_paid_without_shipment_alerts_only_once_while_active(self) -> None:
        report = self.empty_report()
        report["paidWithoutShipment"] = [{"orderNumber": "KOM-777"}]

        first_body, active = self.monitor.build_alert(report, set())
        second_body, second_active = self.monitor.build_alert(report, active)

        self.assertIn("без отправления CDEK", first_body)
        self.assertIsNone(second_body)
        self.assertEqual(second_active, {"KOM-777"})

    def test_paid_without_shipment_requires_terminal_created_status(self) -> None:
        sql = self.monitor.render_sql("2026-08-30T10:00:00Z", 5)

        self.assertIn("from public.merch_cdek_shipments s", sql)
        self.assertIn("s.order_id = o.id", sql)
        self.assertIn("s.status = 'created'", sql)
        self.assertIn("o.status in ('paid', 'partially_refunded')", sql)
        self.assertNotIn("o.status in ('paid', 'authorized')", sql)
        self.assertNotIn(
            "select 1 from public.merch_cdek_shipments s where s.order_id = o.id",
            sql,
        )

    def test_effect_needs_review_is_visible_to_operator(self) -> None:
        report = self.empty_report()
        report["cdekEffectReviews"] = {
            "count": 1,
            "items": [
                {
                    "orderNumber": "KOM-778",
                    "effectType": "cdek_cancel",
                    "attempts": 12,
                    "lastError": "provider rejected request",
                }
            ],
        }

        body, _ = self.monitor.build_alert(report, set())

        self.assertIn("CDEK-действие требует ручной проверки", body)
        self.assertIn("KOM-778: cdek_cancel / 12 попыток", body)

    def test_initial_ambiguous_payment_is_visible_without_marking_it_failed(self) -> None:
        report = self.empty_report()
        report["initUnknowns"] = {
            "count": 1,
            "items": [
                {
                    "orderNumber": "KOM-779",
                    "errorCode": "UND_ERR_CONNECT_TIMEOUT",
                }
            ],
        }

        body, _ = self.monitor.build_alert(report, set())

        self.assertIn("Результат создания платежа уточняется", body)
        self.assertIn("KOM-779", body)
        self.assertIn("новый заказ заблокирован", body)

    def test_report_sql_reads_durable_effect_review_state(self) -> None:
        sql = self.monitor.render_sql("2026-08-30T10:00:00Z", 5)

        self.assertIn("from public.merch_order_effects e", sql)
        self.assertIn("e.status = 'needs_review'", sql)
        self.assertIn("'cdekEffectReviews'", sql)
        self.assertIn("pa.provider_status = 'INIT_UNKNOWN'", sql)
        self.assertIn("'initUnknowns'", sql)

    def test_state_timestamp_rejects_untrusted_sql_text(self) -> None:
        with self.assertRaises(ValueError):
            self.monitor.render_sql("2026-08-18'; drop table orders; --", 1)


if __name__ == "__main__":
    unittest.main()
