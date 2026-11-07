import datetime as dt
import os
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

# ---------------------------------------------------------------------------
# Production log isolation.
#
# The unit suite must never write to logs/collector.log: mocked fetches and
# fake Supabase writes would pollute the historical record. The snapshot below
# is taken before any test runs and re-checked in tearDownModule(), i.e. after
# the whole suite, so a leak anywhere fails the run.
# ---------------------------------------------------------------------------
PRODUCTION_LOG = bridge_worker.LOG_FILE
_PRODUCTION_LOG_EXISTED = PRODUCTION_LOG.exists()
_PRODUCTION_LOG_BYTES = PRODUCTION_LOG.read_bytes() if _PRODUCTION_LOG_EXISTED else None


def tearDownModule():
    if not _PRODUCTION_LOG_EXISTED:
        if PRODUCTION_LOG.exists():
            raise AssertionError(
                f"Unit tests created the production log {PRODUCTION_LOG}; it must stay untouched."
            )
        return
    current = PRODUCTION_LOG.read_bytes()
    if current != _PRODUCTION_LOG_BYTES:
        raise AssertionError(
            f"Unit tests modified the production log {PRODUCTION_LOG} "
            f"({len(_PRODUCTION_LOG_BYTES)} bytes before, {len(current)} bytes after). "
            "Tests must redirect logging with configure_log_file()."
        )



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

    def test_declared_muhurat_window_matches_the_official_fo_session(self):
        # NSE special live trading session, Sunday 08-Nov-2026: the equity
        # derivatives segment this collector scrapes trades 14:20-15:40 IST
        # (equity cash market trades 14:20-15:30 IST; pre-open 14:05-14:20).
        # The earlier 18:00-19:15 entry would have slept through the session.
        self.assertEqual(
            nse_core.SPECIAL_SESSIONS_2026[dt.date(2026, 11, 8)],
            (dt.time(14, 20), dt.time(15, 40)),
        )

    def test_muhurat_session_is_open_only_between_1420_and_1540_ist(self):
        cases = [
            (dt.datetime(2026, 11, 8, 14, 19, tzinfo=IST), False),  # before open
            (dt.datetime(2026, 11, 8, 14, 20, tzinfo=IST), True),   # first minute
            (dt.datetime(2026, 11, 8, 14, 30, tzinfo=IST), True),   # mid-session
            (dt.datetime(2026, 11, 8, 15, 30, tzinfo=IST), True),   # equity close
            (dt.datetime(2026, 11, 8, 15, 35, tzinfo=IST), True),   # F&O still open
            (dt.datetime(2026, 11, 8, 15, 40, tzinfo=IST), True),   # last minute
            (dt.datetime(2026, 11, 8, 15, 41, tzinfo=IST), False),  # after close
            (dt.datetime(2026, 11, 8, 12, 0, tzinfo=IST), False),   # Sunday midday
            (dt.datetime(2026, 11, 8, 18, 30, tzinfo=IST), False),  # old wrong window
        ]
        for moment, expected in cases:
            with self.subTest(moment=moment.isoformat()):
                self.assertEqual(nse_core.market_open(moment), expected)

    def test_muhurat_special_session_does_not_leak_to_neighbouring_days(self):
        # Saturday 07-Nov: no special session, weekend gate holds.
        self.assertFalse(nse_core.market_open(dt.datetime(2026, 11, 7, 14, 30, tzinfo=IST)))
        # Sunday 08-Nov outside the window stays closed.
        self.assertFalse(nse_core.market_open(dt.datetime(2026, 11, 8, 9, 30, tzinfo=IST)))
        # Monday 09-Nov is an ordinary trading day (NSE's nearest NIFTY expiry),
        # governed by the normal weekday window, not by the special session.
        self.assertTrue(nse_core.market_open(dt.datetime(2026, 11, 9, 14, 30, tzinfo=IST)))
        self.assertFalse(nse_core.market_open(dt.datetime(2026, 11, 9, 16, 0, tzinfo=IST)))

    def test_muhurat_session_wins_even_if_the_date_is_listed_as_a_holiday(self):
        # The special session is checked before the holiday calendar, so a
        # future edit that adds 2026-11-08 to nse_holidays.txt cannot silently
        # disable collection during the officially scheduled session.
        self.assertTrue(
            nse_core.market_open(
                dt.datetime(2026, 11, 8, 14, 30, tzinfo=IST),
                holidays={dt.date(2026, 11, 8)},
            )
        )

    def test_verified_2026_holidays_from_file_close_the_market(self):
        holidays = nse_core.load_holidays(ROOT / "nse_holidays.txt")
        self.assertIn(dt.date(2026, 1, 26), holidays)
        self.assertIn(dt.date(2026, 10, 2), holidays)
        self.assertIn(dt.date(2026, 12, 25), holidays)

        republic_day = dt.datetime(2026, 1, 26, 11, 0, tzinfo=IST)
        self.assertFalse(nse_core.market_open(republic_day, holidays=holidays))

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


RUN_NOW = dt.datetime(2026, 10, 23, 15, 30, tzinfo=IST)


def run_worker_once(*, market_open=True, chain=None,
                    credentials=("http://stub", "key"),
                    log_path=None, trigger=None, symbols=("NIFTY",)):
    """Run ``main() --once`` with mocked NSE/Supabase and optional log redirect.

    Returns a namespace with the exit code, the captured log text (when
    ``log_path`` redirects file logging), the fake Supabase client and the NSE
    factory mock so callers can assert on every side effect.
    """
    supabase = FakeSupabase()
    nse = FakeNSE(chain or chain_response())
    nse_factory = mock.MagicMock(return_value=nse)
    if log_path is not None:
        bridge_worker.configure_log_file(log_path)
    try:
        with (
            mock.patch.object(bridge_worker, "load_env_credentials", return_value=credentials),
            mock.patch.object(bridge_worker, "create_client", return_value=supabase),
            mock.patch.object(nse_core, "ist_now", return_value=RUN_NOW),
            mock.patch.object(nse_core, "NSE", nse_factory),
            mock.patch.object(nse_core, "market_open", return_value=market_open),
        ):
            if trigger:
                with mock.patch.dict(os.environ, {"NSE_COLLECTOR_TRIGGER": trigger}):
                    code = bridge_worker.main(["--once", "--symbol", *symbols])
            else:
                code = bridge_worker.main(["--once", "--symbol", *symbols])
    finally:
        if log_path is not None:
            bridge_worker.reset_log_file()
    text = ""
    if log_path is not None and Path(log_path).exists():
        text = Path(log_path).read_text(encoding="utf-8")
    return SimpleNamespace(code=code, text=text, supabase=supabase, nse_factory=nse_factory)


class LogIsolationTests(unittest.TestCase):
    """Unit tests must never append to the production logs/collector.log."""

    def test_running_main_from_a_test_leaves_the_production_log_untouched(self):
        before = PRODUCTION_LOG.read_bytes() if PRODUCTION_LOG.exists() else None
        result = run_worker_once()
        after = PRODUCTION_LOG.read_bytes() if PRODUCTION_LOG.exists() else None
        self.assertEqual(result.code, 0)
        self.assertEqual(len(result.supabase.table_client.writes), 2)  # the cycle really ran
        self.assertEqual(before, after)

    def test_an_explicit_redirect_captures_the_run_instead(self):
        with tempfile.TemporaryDirectory() as folder:
            log_path = Path(folder) / "collector.log"
            result = run_worker_once(log_path=log_path)
            self.assertEqual(result.code, 0)
            self.assertTrue(log_path.exists())
            self.assertIn("[ONE-SHOT] Start:", result.text)
            self.assertIn("stage=write-live OK", result.text)

    def test_log_resolution_prefers_explicit_redirect_then_env_then_guards(self):
        bridge_worker.reset_log_file()
        try:
            # 1. explicit redirect wins even with a test runner loaded
            with tempfile.TemporaryDirectory() as folder:
                target = Path(folder) / "redirected.log"
                bridge_worker.configure_log_file(target)
                self.assertEqual(bridge_worker.resolve_log_file(), target)

            # 2. NSE_COLLECTOR_LOG=off forces console-only output
            bridge_worker.reset_log_file()
            with mock.patch.dict(os.environ, {"NSE_COLLECTOR_LOG": "off"}):
                self.assertIsNone(bridge_worker.resolve_log_file())

            # 3. NSE_COLLECTOR_LOG=<path> redirects explicitly
            with mock.patch.dict(os.environ, {"NSE_COLLECTOR_LOG": str(ROOT / "logs" / "other.log")}):
                self.assertEqual(bridge_worker.resolve_log_file(), ROOT / "logs" / "other.log")

            # 4. with a test runner loaded (and nothing else set) the answer is
            #    console-only, even though main() arms file logging
            bridge_worker.reset_log_file()
            bridge_worker._file_logging_armed = True
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(bridge_worker.resolve_log_file())
        finally:
            bridge_worker.reset_log_file()
            bridge_worker._file_logging_armed = False

    def test_run_cycle_can_log_through_an_injected_sink(self):
        supabase = FakeSupabase()
        lines = []
        bridge_worker.run_cycle(
            supabase, FakeNSE(chain_response()), ["NIFTY"], now=RUN_NOW, log=lines.append
        )
        self.assertEqual(len(lines), 4)
        self.assertEqual(len(supabase.table_client.writes), 2)


class OneShotAuditLogTests(unittest.TestCase):
    """Every scheduled --once run must leave a complete, secret-free record."""

    def test_allowed_run_records_start_calendar_stages_and_end(self):
        with tempfile.TemporaryDirectory() as folder:
            result = run_worker_once(log_path=Path(folder) / "audit.log", trigger="scheduled")
            text = result.text

        self.assertEqual(result.code, 0)
        self.assertEqual(len(result.supabase.table_client.writes), 2)
        self.assertRegex(
            text,
            r"\[ONE-SHOT\] Start: 2026-10-23 15:30:00 IST trigger=scheduled pid=\d+",
        )
        self.assertIn("[ONE-SHOT] Symbols: NIFTY", text)
        self.assertIn("[ONE-SHOT] Calendar: ", text)
        self.assertIn("[ONE-SHOT] Calendar decision: ALLOWED at 2026-10-23 15:30:00 IST", text)
        for stage in (
            "stage=fetch OK",
            "stage=validate OK",
            "stage=write-live OK",
            "stage=write-history OK",
        ):
            self.assertIn(stage, text)
        self.assertIn("1 succeeded, 0 failed", text)
        self.assertRegex(
            text,
            r"\[ONE-SHOT\] End: status=completed exit=0 trigger=scheduled "
            r"end=2026-10-23 15:30:00 IST",
        )
        self.assertLess(text.index("[ONE-SHOT] Start:"), text.index("[ONE-SHOT] End:"))

    def test_blocked_run_is_recorded_without_fetching_or_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            result = run_worker_once(
                log_path=Path(folder) / "audit.log", market_open=False, trigger="scheduled"
            )
            text = result.text

        self.assertEqual(result.code, 0)
        self.assertIn("[ONE-SHOT] Calendar decision: BLOCKED at 2026-10-23 15:30:00 IST", text)
        self.assertIn("no NSE fetch, no database write", text)
        self.assertIn("End: status=blocked-market-closed exit=0", text)
        self.assertNotIn("stage=", text)
        self.assertNotIn("live snapshot upserted", text)
        self.assertEqual(result.supabase.table_client.writes, [])
        self.assertEqual(result.supabase.tables, [])
        result.nse_factory.assert_not_called()

    def test_failed_run_records_the_failing_stage_and_exit_code(self):
        with tempfile.TemporaryDirectory() as folder:
            result = run_worker_once(
                log_path=Path(folder) / "audit.log",
                chain=chain_response(timestamp="22-Oct-2026 10:00:00"),
            )
            text = result.text

        self.assertEqual(result.code, 1)
        self.assertIn("stage=validate FAILED", text)
        self.assertIn("Error: NIFTY:", text)
        self.assertIn("End: status=failed exit=1", text)
        self.assertEqual(result.supabase.table_client.writes, [])

    def test_manual_and_scheduled_runs_are_distinguishable(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            scheduled = run_worker_once(log_path=folder / "s.log", trigger="scheduled")
            manual = run_worker_once(log_path=folder / "m.log", trigger="manual")
            inherited = run_worker_once(log_path=folder / "i.log")  # parent decides

        self.assertIn("trigger=scheduled", scheduled.text)
        self.assertIn("trigger=manual", manual.text)
        self.assertEqual(inherited.code, 0)
        # This suite runs under a plain interpreter, never under Task Scheduler.
        self.assertIn("trigger=manual", inherited.text)

    def test_once_mode_never_creates_the_daemon_pid_file(self):
        existed = bridge_worker.PID_FILE.exists()
        result = run_worker_once()
        self.assertEqual(result.code, 0)
        self.assertEqual(bridge_worker.PID_FILE.exists(), existed)

    def test_audit_log_never_contains_credentials(self):
        key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.top-secret-service-role-key"
        with tempfile.TemporaryDirectory() as folder:
            result = run_worker_once(
                log_path=Path(folder) / "audit.log",
                credentials=("https://example-project.supabase.co", key),
            )
        self.assertEqual(result.code, 0)
        self.assertNotIn(key, result.text)
        self.assertNotIn(key[:12], result.text)
        self.assertIn("key: configured (length", result.text)  # metadata only


class StageLoggingTests(unittest.TestCase):
    """run_cycle labels fetch / validate / write outcomes per symbol."""

    def test_success_path_logs_every_stage_in_order(self):
        supabase = FakeSupabase()
        lines = []
        bridge_worker.run_cycle(
            supabase, FakeNSE(chain_response()), ["NIFTY"], now=RUN_NOW, log=lines.append
        )
        joined = "\n".join(lines)
        positions = [joined.index(f"stage={s} OK") for s in
                     ("fetch", "validate", "write-live", "write-history")]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("NIFTY", joined)

    def test_validation_failure_is_labelled_with_the_failing_stage(self):
        supabase = FakeSupabase()
        lines = []
        bridge_worker.run_cycle(
            supabase,
            FakeNSE(chain_response(timestamp="22-Oct-2026 10:00:00")),
            ["NIFTY"],
            now=RUN_NOW,
            log=lines.append,
        )
        self.assertIn("stage=validate FAILED", "\n".join(lines))
        self.assertEqual(supabase.table_client.writes, [])

    def test_fetch_failure_is_labelled_with_the_failing_stage(self):
        supabase = FakeSupabase()
        lines = []
        bridge_worker.run_cycle(
            supabase, FakeNSE(chain_response(), expiries=()), ["NIFTY"],
            now=RUN_NOW, log=lines.append,
        )
        self.assertIn("stage=fetch FAILED", "\n".join(lines))
        self.assertIn("no expiries", "\n".join(lines))
        self.assertEqual(supabase.table_client.writes, [])

    def test_one_symbol_failure_does_not_hide_the_other_symbols_stages(self):
        supabase = FakeSupabase()

        class MixedNSE(FakeNSE):
            def get(self, path, params=None):
                if "FINNIFTY" in str(params):
                    raise RuntimeError("connection reset")
                return super().get(path, params)

        lines = []
        bridge_worker.run_cycle(
            supabase, MixedNSE(chain_response()), ["NIFTY", "FINNIFTY"],
            now=RUN_NOW, log=lines.append,
        )
        joined = "\n".join(lines)
        self.assertIn("stage=write-history OK", joined)
        self.assertIn("stage=fetch FAILED", joined)
        self.assertIn("connection reset", joined)


class TriggerDetectionTests(unittest.TestCase):
    """Scheduled runs must be told apart from manually launched ones."""

    def test_scheduler_host_processes_are_detected(self):
        for name in ("svchost.exe", "taskeng.exe", "taskhostw.exe", "taskschd.exe",
                     "Svchost.EXE"):
            self.assertEqual(bridge_worker.detect_trigger(name), "scheduled", name)

    def test_any_other_parent_means_manual(self):
        for name in ("powershell.exe", "cmd.exe", "python.exe", "explorer.exe", None):
            if name is None:
                # Falls back to the real parent process of this test run.
                self.assertIn(
                    bridge_worker.detect_trigger(None), {"scheduled", "manual"}
                )
            else:
                self.assertEqual(bridge_worker.detect_trigger(name), "manual", name)

    def test_env_override_wins_over_the_parent_guess(self):
        with mock.patch.dict(os.environ, {"NSE_COLLECTOR_TRIGGER": "scheduled"}):
            self.assertEqual(bridge_worker.detect_trigger("python.exe"), "scheduled")
        with mock.patch.dict(os.environ, {"NSE_COLLECTOR_TRIGGER": "manual"}):
            self.assertEqual(bridge_worker.detect_trigger("svchost.exe"), "manual")
        with mock.patch.dict(os.environ, {"NSE_COLLECTOR_TRIGGER": "nonsense"}):
            self.assertEqual(bridge_worker.detect_trigger("svchost.exe"), "scheduled")

    def test_key_masking_never_echoes_key_material(self):
        key = "abcdefghijklmnop"
        masked = bridge_worker.mask_key(key)
        self.assertNotIn("abc", masked)
        self.assertNotIn(key, masked)
        self.assertEqual(bridge_worker.mask_key(None), "not set")


class ScheduledTaskScriptTests(unittest.TestCase):
    """The install/uninstall scripts must encode the required task contract."""

    TASK_NAME = "NSE Option Chain Live Collector"
    INSTALL = ROOT / "scripts" / "Install-Collector-ScheduledTask.ps1"
    UNINSTALL = ROOT / "scripts" / "Uninstall-Collector-ScheduledTask.ps1"
    EXPECTED_ARGS = "worker\\bridge_worker.py --once --symbol NIFTY BANKNIFTY FINNIFTY"

    def install_text(self):
        self.assertTrue(self.INSTALL.exists(), "install script is missing")
        return self.INSTALL.read_text(encoding="utf-8")

    def uninstall_text(self):
        self.assertTrue(self.UNINSTALL.exists(), "uninstall script is missing")
        return self.UNINSTALL.read_text(encoding="utf-8")

    def test_install_script_builds_the_required_command_and_arguments(self):
        text = self.install_text()
        self.assertIn(f"[string]$TaskName = '{self.TASK_NAME}'", text)
        self.assertIn(f"[string]$WorkerArgs = '{self.EXPECTED_ARGS}'", text)
        self.assertIn("-Execute $PythonPath", text)
        self.assertIn("-Argument $WorkerArgs", text)
        self.assertIn("-WorkingDirectory $repoRoot", text)
        self.assertIn("worker\\bridge_worker.py", text)
        self.assertIn("--once", text)

    def test_install_script_targets_the_exact_repository_interpreter(self):
        text = self.install_text()
        self.assertIn(str(sys.executable), text)

    def test_install_script_never_uses_forbidden_modes_or_launchers(self):
        text = self.install_text()
        self.assertNotIn("run_bridge.bat", text)
        self.assertNotIn("Start-Live-Collector.bat", text)
        # "--always" may appear only as a pattern that is explicitly rejected.
        offending = [
            line for line in text.splitlines()
            if "--always" in line and "-match" not in line
        ]
        self.assertEqual(offending, [], f"--always must never be actionable: {offending}")

    def test_install_script_configures_safe_scheduling(self):
        text = self.install_text()
        self.assertIn("-MultipleInstances IgnoreNew", text)  # no overlapping runs
        self.assertIn("-StartWhenAvailable", text)
        self.assertIn("-LogonType Interactive", text)  # no stored password
        self.assertIn("New-ScheduledTaskTrigger -Daily", text)  # weekends included
        self.assertIn("-RepetitionInterval", text)
        self.assertIn("-RepetitionDuration", text)
        self.assertIn("-ExecutionTimeLimit", text)
        self.assertIn("-RestartCount", text)
        self.assertNotIn("-LogonType Password", text)
        self.assertNotIn("-RunLevel Highest", text)

    def test_overlapping_invocations_cannot_stack(self):
        text = self.install_text()
        self.assertIn("-MultipleInstances IgnoreNew", text)
        self.assertIn("--once", text)  # each run exits after a single cycle
        self.assertNotIn("--interval", text)  # no long-lived polling loop

    def test_uninstall_script_removes_only_the_collector_task(self):
        text = self.uninstall_text()
        self.assertIn(f"[string]$TaskName = '{self.TASK_NAME}'", text)
        self.assertIn("Unregister-ScheduledTask -TaskName $TaskName", text)
        self.assertNotIn("-TaskName *", text)
        self.assertNotIn("$TaskName*", text)

    def test_install_and_uninstall_agree_on_the_task_name(self):
        self.assertIn(
            f"'{self.TASK_NAME}'", self.uninstall_text()
        )


if __name__ == "__main__":
    unittest.main()