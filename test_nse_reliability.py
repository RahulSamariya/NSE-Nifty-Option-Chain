import datetime as dt
import unittest
from types import SimpleNamespace

import pandas as pd

import bridge_worker
import nse_core


IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


class FakeTable:
    def __init__(self, error=None):
        self.error = error
        self.payload = None

    def upsert(self, payload, on_conflict):
        self.payload = payload
        self.on_conflict = on_conflict
        return self

    def insert(self, payload):
        self.payload = payload
        return self

    def execute(self):
        return SimpleNamespace(error=self.error)


class FakeSupabase:
    def __init__(self, error=None):
        self.table_client = FakeTable(error)

    def table(self, name):
        self.table_name = name
        return self.table_client


class ReliabilityTests(unittest.TestCase):
    def test_timestamp_is_parsed_as_ist_and_invalid_values_are_rejected(self):
        parsed = nse_core.parse_nse_timestamp("23-Oct-2026 15:30:00")
        self.assertEqual(parsed.utcoffset(), dt.timedelta(hours=5, minutes=30))
        self.assertEqual(parsed.hour, 15)
        self.assertIsNone(nse_core.parse_nse_timestamp("not a timestamp"))
        self.assertIsNone(nse_core.parse_nse_timestamp(None))

    def test_parser_and_analytics_handle_option_chain_rows(self):
        response = {
            "records": {
                "underlyingValue": 200,
                "timestamp": "23-Oct-2026 15:30:00",
                "data": [
                    {
                        "strikePrice": 100,
                        "CE": {"strikePrice": 100, "openInterest": 0},
                        "PE": {"strikePrice": 100, "openInterest": 10},
                    },
                    {
                        "strikePrice": 200,
                        "CE": {"strikePrice": 200, "openInterest": 10},
                        "PE": {"strikePrice": 200, "openInterest": 0},
                    },
                ],
            }
        }
        frame, spot, source_time = nse_core.parse(response)
        metrics = nse_core.summarize(frame, spot)
        self.assertEqual(spot, 200)
        self.assertEqual(source_time, "23-Oct-2026 15:30:00")
        self.assertEqual(metrics["pcr"], 1)
        self.assertEqual(metrics["max_pain"], 100)

    def test_parser_rejects_missing_records_without_network_access(self):
        with self.assertRaisesRegex(ValueError, "records object"):
            nse_core.parse({})

    def test_worker_rejects_stale_or_missing_timestamp(self):
        frame = pd.DataFrame({"STRIKE": [24000]})
        source_now = dt.datetime(2026, 10, 23, 15, 30, tzinfo=IST)
        self.assertEqual(
            bridge_worker.validate_snapshot(
                frame, 24600, "23-Oct-2026 15:30:00", now=source_now
            ),
            24600,
        )
        with self.assertRaisesRegex(ValueError, "stale"):
            bridge_worker.validate_snapshot(
                frame,
                24600,
                "23-Oct-2026 15:30:00",
                now=source_now + dt.timedelta(minutes=5, seconds=1),
            )
        with self.assertRaisesRegex(ValueError, "timestamp"):
            bridge_worker.validate_snapshot(frame, 24600, None, now=source_now)

    def test_upsert_stamps_database_time_and_preserves_source_time(self):
        client = FakeSupabase()
        source_time = "23-Oct-2026 15:30:00"
        now = dt.datetime(2026, 10, 23, 15, 30, tzinfo=IST)
        result = bridge_worker.upsert_live_snapshot(
            client,
            {"symbol": "NIFTY", "nse_timestamp": source_time},
            now=now,
        )
        self.assertEqual(client.table_name, "option_chain_live")
        self.assertEqual(client.table_client.on_conflict, "symbol,expiry")
        self.assertEqual(result["updated_at"], "2026-10-23T10:00:00+00:00")
        self.assertEqual(result["nse_timestamp"], source_time)

    def test_failed_supabase_upsert_is_not_reported_as_success(self):
        client = FakeSupabase(error="permission denied")
        with self.assertRaisesRegex(RuntimeError, "permission denied"):
            bridge_worker.upsert_live_snapshot(
                client,
                {"symbol": "NIFTY", "nse_timestamp": "23-Oct-2026 15:30:00"},
            )

    def test_failed_history_insert_is_not_reported_as_success(self):
        client = FakeSupabase(error="permission denied")
        with self.assertRaisesRegex(RuntimeError, "history insert failed"):
            bridge_worker.insert_history_snapshot(
                client, {"symbol": "NIFTY", "expiry": "27-Oct-2026"}
            )


if __name__ == "__main__":
    unittest.main()