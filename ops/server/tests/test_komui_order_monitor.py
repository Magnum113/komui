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
            "networkErrors": {"count": 0, "items": []},
            "duplicateOrders": {"count": 0, "items": []},
            "rapidCustomers": {"count": 0, "items": []},
            "repeatedFailures": {"count": 0, "items": []},
            "failureSpike": None,
            "ordersWithoutItems": {"count": 0, "items": []},
            "paymentReviews": {"count": 0, "items": []},
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

    def test_paid_without_shipment_alerts_only_once_while_active(self) -> None:
        report = self.empty_report()
        report["paidWithoutShipment"] = [{"orderNumber": "KOM-777"}]

        first_body, active = self.monitor.build_alert(report, set())
        second_body, second_active = self.monitor.build_alert(report, active)

        self.assertIn("без отправления CDEK", first_body)
        self.assertIsNone(second_body)
        self.assertEqual(second_active, {"KOM-777"})

    def test_state_timestamp_rejects_untrusted_sql_text(self) -> None:
        with self.assertRaises(ValueError):
            self.monitor.render_sql("2026-08-18'; drop table orders; --", 1)


if __name__ == "__main__":
    unittest.main()
