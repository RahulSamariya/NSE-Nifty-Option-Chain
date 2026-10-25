import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pandas as pd

# repo layout: these tests live in tests/, code lives in core/ and worker/
ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "core", ROOT / "worker"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import bridge_worker
import nse_core


IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


class FakeTable:
    def __init__(self, error=None):
        self.error = error
        self.payload = None
        self.writes = []

    def upsert(self, payload, on_conflict):
        self.payload = payload
        self.on_conflict = on_conflict
        self.writes.append(("upsert", payload))
        return self

    def insert(self, payload):
        self.payload = payload
        self.writes.append(("insert", payload))
        return self

    def execute(self):
        return SimpleNamespace(error=self.error)


class FakeSupabase:
    def __init__(self, error=None):
        self.table_client = FakeTable(error)
        self.tables = []

    def table(self, name):
        self.table_name = name
        self.tables.append(name)
        return self.table_client


class FakeNSE:
    """Stands in for nse_core.NSE without opening a network session."""

    def __init__(self, chain_response, expiries=("27-Oct-2026",)):
        self.chain_response = chain_response
        self.expiries = list(expiries)
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, params))
        if path.endswith("contract-info"):
            return {"expiryDates": self.expiries}
        return self.chain_response


def chain_response(timestamp="23-Oct-2026 15:30:00", spot=200):
    return {
        "records": {
            "underlyingValue": spot,
            "timestamp": timestamp,
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


class MarketCalendarTests(unittest.TestCase):
    def test_market_is_open_only_on_weekdays_between_0915_and_1535(self):
        friday = dt.datetime(2026, 10, 23, tzinfo=IST)
        self.assertTrue(nse_core.market_open(friday.replace(hour=9, minute=15)))
        self.assertTrue(nse_core.market_open(friday.replace(hour=15, minute=35)))
        self.assertFalse(nse_core.market_open(friday.replace(hour=9, minute=14)))
        self.assertFalse(nse_core.market_open(friday.replace(hour=15, minute=36)))
        self.assertFalse(nse_core.market_open(dt.datetime(2026, 10, 24, 11, tzinfo=IST)))
        self.assertFalse(nse_core.market_open(dt.datetime(2026, 10, 25, 11, tzinfo=IST)))

    def test_holidays_close_the_market_and_accept_dates_or_iso_strings(self):
        friday = dt.datetime(2026, 10, 23, 11, tzinfo=IST)
        self.assertTrue(nse_core.market_open(friday))
        self.assertFalse(nse_core.market_open(friday, holidays={dt.date(2026, 10, 23)}))
        self.assertFalse(nse_core.market_open(friday, holidays={"2026-10-23"}))
        # A holiday on another date changes nothing.
        self.assertTrue(nse_core.market_open(friday, holidays={"2026-11-09"}))

    def test_load_holidays_reads_comments_and_blank_lines(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "nse_holidays.txt"
            path.write_text(
                "# NSE holidays\n"
                "\n"
                "2026-01-26  # Republic Day\n"
                "2026-03-04\n"
                "   \n",
                encoding="utf-8",
            )
            self.assertEqual(
                nse_core.load_holidays(path),
                {dt.date(2026, 1, 26), dt.date(2026, 3, 4)},
            )

    def test_load_holidays_rejects_malformed_dates_with_a_line_number(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "nse_holidays.txt"
            path.write_text("2026-01-26\n26-Jan-2026\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, r":2: expected an ISO date"):
                nse_core.load_holidays(path)

    def test_missing_holiday_file_means_weekdays_only(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(nse_core.load_holidays(Path(folder) / "absent.txt"), set())


class WorkerCycleTests(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 23, 15, 30, tzinfo=IST)

    def test_single_cycle_writes_one_live_and_one_history_row(self):
        supabase = FakeSupabase()
        nse = FakeNSE(chain_response())

        result = bridge_worker.run_cycle(supabase, nse, ["NIFTY"], now=self.NOW)

        self.assertEqual(result["succeeded"], ["NIFTY"])
        self.assertEqual(result["failed"], [])
        self.assertEqual(result["live_writes"], 1)
        self.assertEqual(result["history_writes"], 1)
        self.assertEqual(set(supabase.tables), {"option_chain_live", "option_chain_history"})

        actions = [action for action, _ in supabase.table_client.writes]
        self.assertEqual(actions, ["upsert", "insert"])
        live_payload = supabase.table_client.writes[0][1]
        self.assertEqual(live_payload["symbol"], "NIFTY")
        self.assertEqual(live_payload["expiry"], "27-Oct-2026")
        self.assertEqual(live_payload["nse_timestamp"], "23-Oct-2026 15:30:00")
        self.assertEqual(live_payload["updated_at"], "2026-10-23T10:00:00+00:00")
        self.assertEqual(len(live_payload["raw_data"]), 2)

    def test_a_stale_chain_is_never_written(self):
        supabase = FakeSupabase()
        stale = FakeNSE(chain_response(timestamp="23-Oct-2026 10:00:00"))

        with mock.patch.object(nse_core, "NSE", return_value=stale):
            result = bridge_worker.run_cycle(supabase, stale, ["NIFTY"], now=self.NOW)

        self.assertEqual(result["succeeded"], [])
        self.assertEqual(result["failed"], ["NIFTY"])
        self.assertEqual(result["live_writes"], 0)
        self.assertEqual(supabase.table_client.writes, [])
        self.assertIn("stale", result["errors"][0])

    def test_one_failing_symbol_does_not_stop_the_others(self):
        supabase = FakeSupabase()

        class MixedNSE(FakeNSE):
            def get(self, path, params=None):
                if path.endswith("contract-info") and params.get("symbol") == "BANKNIFTY":
                    return {"expiryDates": []}
                return super().get(path, params)

        nse = MixedNSE(chain_response())
        with mock.patch.object(nse_core, "NSE", return_value=nse):
            result = bridge_worker.run_cycle(
                supabase, nse, ["BANKNIFTY", "NIFTY"], now=self.NOW
            )

        self.assertEqual(result["failed"], ["BANKNIFTY"])
        self.assertEqual(result["succeeded"], ["NIFTY"])
        self.assertIn("no expiries", result["errors"][0])

    def test_history_is_throttled_but_live_snapshot_still_updates(self):
        supabase = FakeSupabase()
        last_history = {"NIFTY": bridge_worker.time.time()}

        result = bridge_worker.run_cycle(
            supabase, FakeNSE(chain_response()), ["NIFTY"], last_history, now=self.NOW
        )

        self.assertEqual(result["live_writes"], 1)
        self.assertEqual(result["history_writes"], 0)
        self.assertEqual([action for action, _ in supabase.table_client.writes], ["upsert"])


class WorkerOnceModeTests(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 23, 15, 30, tzinfo=IST)

    def run_once(self, *, market_open=True, chain=None, credentials=("http://stub", "key")):
        supabase = FakeSupabase()
        nse = FakeNSE(chain or chain_response())
        with (
            mock.patch.object(bridge_worker, "load_env_credentials", return_value=credentials),
            mock.patch.object(bridge_worker, "create_client", return_value=supabase),
            mock.patch.object(nse_core, "ist_now", return_value=self.NOW),
            mock.patch.object(nse_core, "NSE", return_value=nse),
            mock.patch.object(nse_core, "market_open", return_value=market_open),
        ):
            code = bridge_worker.main(["--once", "--symbol", "NIFTY"])
        return code, supabase

    def test_once_writes_a_snapshot_and_exits_zero(self):
        code, supabase = self.run_once()
        self.assertEqual(code, 0)
        self.assertEqual(supabase.table_name, "option_chain_history")
        self.assertEqual(len(supabase.table_client.writes), 2)

    def test_once_exits_zero_without_writing_when_the_market_is_closed(self):
        code, supabase = self.run_once(market_open=False)
        self.assertEqual(code, 0)
        self.assertEqual(supabase.table_client.writes, [])

    def test_once_exits_one_when_collection_fails(self):
        code, supabase = self.run_once(chain=chain_response(timestamp="22-Oct-2026 10:00:00"))
        self.assertEqual(code, 1)
        self.assertEqual(supabase.table_client.writes, [])

    def test_once_exits_one_without_credentials(self):
        code, _ = self.run_once(credentials=(None, None))
        self.assertEqual(code, 1)

    def test_once_rejects_a_malformed_holiday_calendar_before_touching_nse(self):
        with tempfile.TemporaryDirectory() as folder:
            calendar = Path(folder) / "nse_holidays.txt"
            calendar.write_text("26-Jan-2026\n", encoding="utf-8")
            with (
                mock.patch.object(
                    bridge_worker, "load_env_credentials", return_value=("http://stub", "key")
                ),
                mock.patch.object(nse_core, "ist_now", return_value=self.NOW),
                mock.patch.object(nse_core, "NSE") as nse_factory,
            ):
                code = bridge_worker.main(["--once", "--holidays", str(calendar)])
        self.assertEqual(code, 2)
        nse_factory.assert_not_called()

    def test_market_open_check_uses_the_holiday_calendar(self):
        with (
            mock.patch.object(bridge_worker, "load_env_credentials", return_value=("http://stub", "key")),
            mock.patch.object(bridge_worker, "create_client", return_value=FakeSupabase()),
            mock.patch.object(nse_core, "ist_now", return_value=self.NOW),
            mock.patch.object(nse_core, "NSE", return_value=FakeNSE(chain_response())),
        ):
            code = bridge_worker.main(
                ["--once", "--symbol", "NIFTY", "--holidays", str(ROOT / "nse_holidays.txt")]
            )
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()