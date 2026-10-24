"""NSE to Supabase Real-Time Bridge Worker.

Continuously scrapes NSE Option Chain data via residential IP and synchronizes
it to Supabase for the Vercel-hosted Next.js web application.

Usage:
  python bridge_worker.py
  python bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30 --always
"""

import argparse
import ctypes
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

from supabase import Client, create_client
import nse_core as nc

# Windows API to prevent system sleep while worker is running
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


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
    env_file = Path(__file__).resolve().parent / ".env"
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
        print("  SUPABASE_KEY=your-anon-or-service-role-key\n")
        sys.exit(1)

    sb: Client = create_client(supabase_url, supabase_key)
    print(f"[*] Connected to Supabase: {supabase_url}")
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
                try:
                    expiries = nc.get_expiries(client, sym)
                    if not expiries:
                        continue
                    expiry = expiries[0]

                    raw = nc.get_chain(client, sym, expiry, kind="Indices")
                    df, spot, nse_ts = nc.parse(raw)
                    summary = nc.summarize(df, spot)

                    # Prepare raw data payload
                    rows = df.to_dict(orient="records")
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

                    # 1. Upsert Live Snapshot (overwrites existing row for symbol+expiry)
                    sb.table("option_chain_live").upsert(
                        payload, on_conflict="symbol,expiry"
                    ).execute()

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
                        sb.table("option_chain_history").insert(history_payload).execute()
                        last_history_time[sym] = time.time()

                    print(f"[{now:%H:%M:%S}] {sym:<10} | Spot: {spot:<8} | PCR: {payload['pcr'] or 0:.2f} | "
                          f"MaxPain: {payload['max_pain'] or 0} -> Synced to Supabase ✓")

                except Exception as exc:
                    print(f"[{now:%H:%M:%S}] {sym} Error: {exc}")
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
