"""NSE to Supabase Real-Time Bridge Worker.

Continuously scrapes NSE Option Chain data via residential IP and synchronizes
it to Supabase for the Vercel-hosted Next.js web application.

Usage (run from the repository root):
  python worker/bridge_worker.py
  python worker/bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30 --always
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


def main():
    parser = argparse.ArgumentParser(description="NSE to Supabase Bridge Worker")
    parser.add_argument("--symbol", nargs="+", default=["NIFTY", "BANKNIFTY"],
                        help="Symbols to monitor (default: NIFTY BANKNIFTY)")
    parser.add_argument("--interval", type=int, default=30,
                        help="Polling interval in seconds (default: 30)")
    parser.add_argument("--always", action="store_true",
                        help="Poll outside Indian market hours (testing mode)")
    args = parser.parse_args()

    supabase_url, supabase_key = load_env_credentials()
    if not supabase_url or not supabase_key:
        print("\n[!] Supabase credentials not found!")
        print("Please create a .env file in this directory with:")
        print("  SUPABASE_URL=https://your-project.supabase.co")
        print("  SUPABASE_KEY=your-service-role-key (backend only)\n")
        sys.exit(1)

    sb: Client = create_client(supabase_url, supabase_key)
    print("[*] Connected to Supabase")
    print(f"[*] Monitoring symbols: {args.symbol} every {args.interval}s")
    print("[*] Press Ctrl+C to terminate.\n")

    prevent_sleep()
    client = nc.NSE()
    last_history_time = {}

    try:
        while True:
            now = nc.ist_now()
            is_open = args.always or nc.market_open(now)

            if not is_open:
                print(f"[{now:%H:%M:%S}] Market closed (Mon-Fri 09:15-15:35 IST). Waiting 60s...")
                time.sleep(60)
                continue

            for sym in args.symbol:
                nse_ts = "unavailable"
                try:
                    expiries = nc.get_expiries(client, sym)
                    if not expiries:
                        continue
                    expiry = expiries[0]

                    raw = nc.get_chain(client, sym, expiry, kind="Indices")
                    df, spot, nse_ts = nc.parse(raw)
                    spot = validate_snapshot(df, spot, nse_ts)
                    summary = nc.summarize(df, spot)

                    rows = json.loads(df.to_json(orient="records"))
                    payload = {
                        "symbol": sym,
                        "expiry": expiry,
                        "spot": spot,
                        "pcr": float(summary["pcr"]) if summary["pcr"] == summary["pcr"] else None,
                        "max_pain": float(summary["max_pain"]) if summary["max_pain"] else None,
                        "total_ce_oi": float(summary["ce_oi"]),
                        "total_pe_oi": float(summary["pe_oi"]),
                        "nse_timestamp": nse_ts,
                        "raw_data": rows,
                    }

                    upsert_live_snapshot(sb, payload)
                    print(f"[{now:%H:%M:%S}] {sym:<10} | NSE source: {nse_ts} | "
                          "live snapshot upserted successfully")

                    # 2. Append 5-Minute History Record for Trends
                    last_t = last_history_time.get(sym, 0)
                    if time.time() - last_t >= 300:  # 300 seconds = 5 minutes
                        history_payload = {
                            "symbol": sym,
                            "expiry": expiry,
                            "spot": spot,
                            "pcr": payload["pcr"],
                            "max_pain": payload["max_pain"],
                            "total_ce_oi": payload["total_ce_oi"],
                            "total_pe_oi": payload["total_pe_oi"],
                            "nse_timestamp": nse_ts,
                        }
                        insert_history_snapshot(sb, history_payload)
                        last_history_time[sym] = time.time()
                        print(f"[{now:%H:%M:%S}] {sym:<10} | NSE source: {nse_ts} | "
                              "history record inserted successfully")

                except Exception as exc:
                    print(f"[{now:%H:%M:%S}] {sym} | NSE source: {nse_ts} | FAILED: {exc}")
                    # Re-warm session on network errors
                    try:
                        client = nc.NSE()
                    except Exception:
                        pass

            time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\n[*] Bridge worker stopped by user.")
    finally:
        allow_sleep()


if __name__ == "__main__":
    main()
