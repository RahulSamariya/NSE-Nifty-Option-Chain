"""Headless collector: saves option-chain snapshots to SQLite on a schedule.
No browser and no dashboard needed - leave it running during market hours.

Examples:
  py collector.py                                   (NIFTY, every 60 s)
  py collector.py --symbol NIFTY BANKNIFTY --interval 30
  py collector.py --symbol NIFTY --expiry 27-Oct-2026
  py collector.py --always                          (also outside market hours)

By default it only runs Mon-Fri 09:15-15:35 IST. Exchange holidays are not checked.
Stop with Ctrl+C.
"""
import argparse
import time

import nse_core as nc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--symbol", nargs="+", default=["NIFTY"])
    ap.add_argument("--kind", default="Indices", choices=["Indices", "Equity"])
    ap.add_argument("--expiry", default=None, help="e.g. 27-Oct-2026 (default: nearest expiry)")
    ap.add_argument("--interval", type=int, default=60, help="seconds between snapshots")
    ap.add_argument("--always", action="store_true", help="ignore market hours")
    a = ap.parse_args()

    client = None
    exp_cache = {}                      # symbol -> (fetched_at, [expiries])
    was_open = None
    print(f"Collector started: {a.symbol} every {a.interval}s -> {nc.DB_PATH}")

    def nearest(sym):
        t, ex = exp_cache.get(sym, (0, []))
        if not ex or time.time() - t > 3600:
            ex = nc.get_expiries(client, sym)
            exp_cache[sym] = (time.time(), ex)
        if not ex:
            raise RuntimeError("no expiries returned")
        return ex[0]

    try:
        while True:
            now = nc.ist_now()
            is_open = a.always or nc.market_open(now)
            if is_open != was_open:
                print(f"[{now:%a %H:%M:%S}] " + ("Collecting..." if is_open else
                      "Market closed - waiting (use --always to log anyway)"))
                was_open = is_open
            if not is_open:
                time.sleep(60)
                continue
            for sym in a.symbol:
                try:
                    if client is None:
                        client = nc.NSE()
                    expiry = a.expiry or nearest(sym)
                    raw = nc.get_chain(client, sym, expiry, a.kind)
                    df, spot, ts = nc.parse(raw)
                    new = nc.save_snapshot(df, sym, expiry, spot, ts)
                    print(f"[{now:%H:%M:%S}] {sym} {expiry} spot={spot} nse_ts={ts} -> "
                          f"{'saved' if new else 'unchanged'}")
                except Exception as e:  # noqa: BLE001
                    print(f"[{now:%H:%M:%S}] {sym}: {e}")
            time.sleep(a.interval)
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()
