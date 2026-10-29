"""NSE to Supabase Real-Time Bridge Worker.

Continuously scrapes NSE Option Chain data via residential IP and synchronizes
it to Supabase for the Vercel-hosted Next.js web application. This worker is the
only component that talks to NSE; browsers only read the stored snapshot.

Usage (run from the repository root):
  python worker/bridge_worker.py
  python worker/bridge_worker.py --symbol NIFTY BANKNIFTY FINNIFTY --interval 30
  python worker/bridge_worker.py --once          # one cycle, then exit

``--once`` is what a hosted scheduler (systemd timer, Windows Task Scheduler,
cron, container job) should call every few minutes: it respects market hours and
the holiday calendar, writes at most one snapshot per symbol, and exits 0 when
nothing needed doing (market closed) and 1 when a collection failed.
"""

import argparse
import ctypes
import datetime as dt
import json
import math
import os
import sys
import time
from pathlib import Path

from supabase import Client, create_client

# repo layout: core/ holds nse_core.py, this file lives in worker/
ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "core"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import nse_core as nc

# Windows API to prevent system sleep while worker is running
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
MAX_SOURCE_AGE_SECONDS = 300
HISTORY_INTERVAL_SECONDS = 300
HOLIDAY_FILE = ROOT / "nse_holidays.txt"
PID_FILE = ROOT / ".collector.pid"
STOP_FILE = ROOT / ".collector.stop"
LOG_DIR = ROOT / "logs"
LOG_FILE = LOG_DIR / "collector.log"


def log_message(msg: str):
    """Print to console and append to logs/collector.log with IST timestamp."""
    try:
        now_str = f"[{nc.ist_now():%Y-%m-%d %H:%M:%S IST}]"
    except Exception:
        now_str = f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}]"
    line = f"{now_str} {msg}"
    print(line)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def mask_url(url: str | None) -> str:
    """Display URL safely without exposing path secrets."""
    if not url:
        return "not set"
    if "your-project" in url:
        return f"placeholder ('{url}')"
    try:
        from urllib.parse import urlparse
        p = urlparse(url)
        host = p.netloc
        masked = host[:4] + "***" + host[-8:] if len(host) > 12 else host[:4] + "***"
        return f"{p.scheme}://{masked}"
    except Exception:
        return url[:8] + "***"


def mask_key(key: str | None) -> str:
    """Display key metadata safely without revealing secret content."""
    if not key:
        return "not set"
    if "your-service-role-key" in key:
        return f"placeholder ('{key}')"
    prefix = key[:6] if len(key) >= 6 else key[:2]
    return f"configured (length {len(key)}, prefix '{prefix}***')"


def check_configuration():
    """Verify presence of required environment variables without leaking secrets."""
    url, key = load_env_credentials()
    env_file = ROOT / ".env"
    issues = []
    if not env_file.exists() and not (os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_KEY")):
        issues.append(f"No .env file found at {env_file}")
    if not url:
        issues.append("SUPABASE_URL is missing. Set it in .env (e.g. https://<project>.supabase.co).")
    elif "your-project" in url:
        issues.append("SUPABASE_URL still contains default placeholder 'your-project.supabase.co'.")
    if not key:
        issues.append("SUPABASE_KEY is missing. Set backend service-role key in .env.")
    elif "your-service-role-key" in key:
        issues.append("SUPABASE_KEY still contains default placeholder 'your-service-role-key'.")
    return url, key, issues


def interruptible_sleep(seconds: float) -> bool:
    """Sleep in 1s increments, returning True early if STOP_FILE is detected."""
    end_time = time.time() + max(0.0, seconds)
    while time.time() < end_time:
        if STOP_FILE.exists():
            return True
        time.sleep(min(1.0, max(0.1, end_time - time.time())))
    return False


def is_process_running(pid: int) -> bool:
    """Check if process with given PID exists (Windows/POSIX compatible)."""
    if sys.platform == "win32":
        try:
            import subprocess
            out = subprocess.check_output(
                f'tasklist /FI "PID eq {pid}" /NH',
                shell=True,
                stderr=subprocess.DEVNULL,
            ).decode(errors="ignore")
            return str(pid) in out
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def prevent_sleep():
    if sys.platform == "win32":
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED
            )
        except Exception:
            pass


def allow_sleep():
    if sys.platform == "win32":
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        except Exception:
            pass


def load_env_credentials():
    """Load SUPABASE_URL and SUPABASE_KEY from .env or environment."""
    env_file = Path(__file__).resolve().parent.parent / ".env"
    creds = {}
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                creds[k.strip()] = v.strip().strip("'\"")

    url = os.getenv("SUPABASE_URL") or creds.get("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY") or creds.get("SUPABASE_KEY")
    return url, key


def _is_positive_finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and number > 0


def validate_snapshot(df, spot, nse_timestamp, now=None):
    """Reject incomplete or stale source data before it can replace a snapshot."""
    source_time = nc.parse_nse_timestamp(nse_timestamp)
    if source_time is None:
        raise ValueError("NSE source timestamp is missing or invalid")
    if not _is_positive_finite(spot):
        raise ValueError("NSE spot value is missing or invalid")
    if df.empty or "STRIKE" not in df.columns:
        raise ValueError("NSE option-chain rows are empty or incomplete")
    if not df["STRIKE"].map(_is_positive_finite).all():
        raise ValueError("NSE option-chain contains an invalid strike")

    now = now or nc.ist_now()
    if now.tzinfo is None:
        now = now.replace(tzinfo=source_time.tzinfo)
    age_seconds = (now - source_time).total_seconds()
    if age_seconds < -60:
        raise ValueError("NSE source timestamp is in the future")
    if age_seconds > MAX_SOURCE_AGE_SECONDS:
        raise ValueError(f"NSE snapshot is stale ({age_seconds:.0f}s old)")
    return float(spot)


def upsert_live_snapshot(client, payload, now=None):
    """Upsert a validated snapshot and stamp database update time in UTC."""
    record = dict(payload)
    record["updated_at"] = (now or dt.datetime.now(dt.timezone.utc)).astimezone(
        dt.timezone.utc
    ).isoformat()
    result = client.table("option_chain_live").upsert(
        record, on_conflict="symbol,expiry"
    ).execute()
    error = getattr(result, "error", None)
    if error:
        raise RuntimeError(f"Supabase live snapshot upsert failed: {error}")
    return record


def insert_history_snapshot(client, payload):
    result = client.table("option_chain_history").insert(payload).execute()
    error = getattr(result, "error", None)
    if error:
        raise RuntimeError(f"Supabase history insert failed: {error}")


def build_payload(symbol, expiry, df, spot, nse_ts, summary):
    """Rows of the validated chain plus the metrics shown on the dashboard."""
    return {
        "symbol": symbol,
        "expiry": expiry,
        "spot": spot,
        "pcr": float(summary["pcr"]) if summary["pcr"] == summary["pcr"] else None,
        "max_pain": float(summary["max_pain"]) if summary["max_pain"] else None,
        "total_ce_oi": float(summary["ce_oi"]),
        "total_pe_oi": float(summary["pe_oi"]),
        "nse_timestamp": nse_ts,
        "raw_data": json.loads(df.to_json(orient="records")),
    }


def run_cycle(sb, nse_client, symbols, last_history_time=None, now=None):
    """Collect one snapshot per symbol and write the valid ones.

    A failure for one symbol (NSE timeout, stale timestamp, bad chain, database
    error) is reported and never blocks the others. The previously stored
    snapshot is left untouched because a row is only written after validation.

    Returns a dict with the (possibly re-created) NSE client, the symbols that
    succeeded/failed, and the number of live and history writes.
    """
    now = now or nc.ist_now()
    last_history_time = {} if last_history_time is None else last_history_time
    succeeded, failed, errors = [], [], []
    live_writes = 0
    history_writes = 0

    for sym in symbols:
        nse_ts = "unavailable"
        try:
            expiries = nc.get_expiries(nse_client, sym)
            if not expiries:
                raise ValueError("NSE returned no expiries for this symbol")
            expiry = expiries[0]

            raw = nc.get_chain(nse_client, sym, expiry, kind="Indices")
            df, spot, nse_ts = nc.parse(raw)
            spot = validate_snapshot(df, spot, nse_ts, now=now)
            summary = nc.summarize(df, spot)
            payload = build_payload(sym, expiry, df, spot, nse_ts, summary)

            upsert_live_snapshot(sb, payload, now=now)
            live_writes += 1
            log_message(
                f"{sym:<10} | NSE source: {nse_ts} | spot: {spot:.2f} | "
                "live snapshot upserted successfully"
            )

            # Append a history point at most every five minutes.
            if time.time() - last_history_time.get(sym, 0) >= HISTORY_INTERVAL_SECONDS:
                insert_history_snapshot(
                    sb,
                    {
                        "symbol": sym,
                        "expiry": expiry,
                        "spot": spot,
                        "pcr": payload["pcr"],
                        "max_pain": payload["max_pain"],
                        "total_ce_oi": payload["total_ce_oi"],
                        "total_pe_oi": payload["total_pe_oi"],
                        "nse_timestamp": nse_ts,
                    },
                )
                last_history_time[sym] = time.time()
                history_writes += 1
                log_message(
                    f"{sym:<10} | NSE source: {nse_ts} | "
                    "history record inserted successfully"
                )

            succeeded.append(sym)
        except Exception as exc:  # noqa: BLE001 - one symbol must not stop the rest
            failed.append(sym)
            errors.append(f"{sym}: {exc}")
            log_message(f"{sym:<10} | NSE source: {nse_ts} | FAILED: {exc}")
            # Re-warm the session after a network error.
            try:
                nse_client = nc.NSE()
            except Exception:
                pass

    return {
        "client": nse_client,
        "succeeded": succeeded,
        "failed": failed,
        "errors": errors,
        "live_writes": live_writes,
        "history_writes": history_writes,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="NSE to Supabase Bridge Worker")
    parser.add_argument("--symbol", nargs="+", default=["NIFTY", "BANKNIFTY", "FINNIFTY"],
                        help="Symbols to monitor (default: NIFTY BANKNIFTY FINNIFTY)")
    parser.add_argument("--interval", type=int, default=30,
                        help="Polling interval in seconds (default: 30)")
    parser.add_argument("--always", action="store_true",
                        help="Poll outside Indian market hours and on holidays (testing mode)")
    parser.add_argument("--once", action="store_true",
                        help="Run a single collection cycle and exit (for cron / scheduled jobs)")
    parser.add_argument("--holidays", default=str(HOLIDAY_FILE),
                        help="Holiday calendar file, one YYYY-MM-DD per line "
                             f"(default: {HOLIDAY_FILE.name})")
    args = parser.parse_args(argv)

    symbols = []
    for raw_symbol in args.symbol:
        symbol = raw_symbol.strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    if not symbols:
        print("[!] --symbol needs at least one symbol")
        return 2

    try:
        holidays = nc.load_holidays(args.holidays)
    except (OSError, ValueError) as exc:
        print(f"[!] Could not read the holiday calendar: {exc}")
        return 2

    supabase_url, supabase_key = load_env_credentials()
    if not supabase_url or not supabase_key:
        print("\n[!] Supabase credentials not found!")
        print("Please create a .env file in this directory with:")
        print("  SUPABASE_URL=https://your-project.supabase.co")
        print("  SUPABASE_KEY=your-service-role-key (backend only)")
        print("On a hosted worker, set them as environment variables instead.\n")
        return 1

    sb: Client = create_client(supabase_url, supabase_key)
    calendar_note = (
        f"{len(holidays)} holiday(s) from {Path(args.holidays).name}"
        if holidays
        else f"no holidays in {Path(args.holidays).name} (weekdays only)"
    )

    if args.once:
        print("[*] Connected to Supabase")
        print(f"[*] Monitoring symbols: {symbols}")
        print(f"[*] Market calendar: Mon-Fri 09:15-15:35 IST; {calendar_note}")
        now = nc.ist_now()
        if not (args.always or nc.market_open(now, holidays=holidays)):
            print(
                f"[{now:%H:%M:%S}] Market closed (weekend or exchange holiday): "
                "single cycle skipped, nothing was written."
            )
            return 0

        try:
            nse_client = nc.NSE()
        except Exception as exc:  # session warm-up can fail without network
            print(f"[!] Could not start the NSE client: {exc}")
            return 1

        result = run_cycle(sb, nse_client, symbols)
        print(
            f"[*] Single cycle finished: {len(result['succeeded'])} symbol(s) written, "
            f"{len(result['failed'])} failed."
        )
        return 0 if not result["failed"] else 1

    # Continuous running mode
    # 1. Manage PID file for safe stop
    if PID_FILE.exists():
        try:
            old_pid = int(PID_FILE.read_text().strip())
            if is_process_running(old_pid) and old_pid != os.getpid():
                log_message(f"[WARNING] Another collector instance may be running (PID: {old_pid}).")
                log_message("          Run Stop-Live-Collector.bat first or remove .collector.pid if stale.")
        except Exception:
            pass
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass
    if STOP_FILE.exists():
        try:
            STOP_FILE.unlink()
        except Exception:
            pass

    log_message("================================================================")
    log_message("  NSE Option Chain - Live Market Data Collector Started")
    log_message("================================================================")
    log_message(f"Process PID:      {os.getpid()}")
    log_message(f"Supabase Target:  {mask_url(supabase_url)}")
    log_message(f"Supabase Key:     {mask_key(supabase_key)}")
    log_message(f"Symbols:          {', '.join(symbols)}")
    log_message(f"Polling Interval: {args.interval}s")
    log_message(f"Market Calendar:  Mon-Fri 09:15-15:35 IST; {calendar_note}")

    # Pre-flight query to check database status
    try:
        live_res = sb.table("option_chain_live").select("symbol,expiry,spot,nse_timestamp,updated_at").order("updated_at", desc=True).limit(3).execute()
        if live_res.data:
            log_message(f"Current database state ({len(live_res.data)} snapshot(s) found):")
            for r in live_res.data:
                log_message(f"  - {r.get('symbol')} {r.get('expiry')}: Spot={r.get('spot')}, NSE TS={r.get('nse_timestamp')}, DB Written={r.get('updated_at')}")
        else:
            log_message("Database state: option_chain_live is empty.")
    except Exception as db_err:
        log_message(f"[WARNING] Could not read database status check: {db_err}")

    log_message("[*] Press Ctrl+C in this terminal or run Stop-Live-Collector.bat to stop.")

    prevent_sleep()
    try:
        nse_client = nc.NSE()
    except Exception as exc:
        log_message(f"[!] Session warm-up warning: {exc}")
        nse_client = None

    last_history_time = {}

    try:
        while True:
            if STOP_FILE.exists():
                log_message("[*] Stop signal detected (.collector.stop). Exiting gracefully...")
                break

            now = nc.ist_now()
            if not (args.always or nc.market_open(now, holidays=holidays)):
                log_message(
                    "Market is closed (Mon-Fri 09:15-15:35 IST, exchange holidays excluded). "
                    "Waiting 60s for next market session..."
                )
                if interruptible_sleep(60):
                    log_message("[*] Stop signal detected during market-closed wait. Exiting...")
                    break
                continue

            if nse_client is None:
                try:
                    nse_client = nc.NSE()
                except Exception as exc:
                    log_message(f"[!] Could not connect to NSE: {exc}")
                    if interruptible_sleep(args.interval):
                        break
                    continue

            result = run_cycle(sb, nse_client, symbols, last_history_time, now=now)
            nse_client = result["client"]

            if interruptible_sleep(args.interval):
                log_message("[*] Stop signal detected. Exiting...")
                break

    except KeyboardInterrupt:
        log_message("[*] Bridge worker stopped by user (Ctrl+C).")
    finally:
        allow_sleep()
        if PID_FILE.exists():
            try:
                PID_FILE.unlink()
            except Exception:
                pass
        if STOP_FILE.exists():
            try:
                STOP_FILE.unlink()
            except Exception:
                pass
        log_message("[*] Collector process terminated cleanly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
