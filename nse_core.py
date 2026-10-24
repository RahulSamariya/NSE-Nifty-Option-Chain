"""Shared NSE logic (no Streamlit): client, parsing, formatting, analytics, SQLite storage.
Used by app.py (dashboard) and collector.py (headless logger)."""
import datetime as dt
import json
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path

import numpy as np
import pandas as pd
import requests

BASE = "https://www.nseindia.com"
HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "referer": BASE + "/option-chain",
}

INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]

# json field -> column name
FIELDS = {
    "openInterest": "OI",
    "changeinOpenInterest": "CHNG_IN_OI",
    "pchangeinOpenInterest": "PCHNG_IN_OI",
    "totalTradedVolume": "VOLUME",
    "impliedVolatility": "IV",
    "lastPrice": "LTP",
    "change": "CHNG",
    "pChange": "PCHNG",
    "buyPrice1": "BID",
    "buyQuantity1": "BID_QTY",
    "sellPrice1": "ASK",
    "sellQuantity1": "ASK_QTY",
}
DEFAULT_COLS = ["OI", "CHNG_IN_OI", "VOLUME", "IV", "LTP"]

# NSE website column order: (column, decimals shown)
CE_SPEC = [("OI", 0), ("CHNG_IN_OI", 0), ("VOLUME", 0), ("IV", 2), ("LTP", 2),
           ("CHNG", 2), ("BID_QTY", 0), ("BID", 2), ("ASK", 2), ("ASK_QTY", 0)]
PE_SPEC = [("BID_QTY", 0), ("BID", 2), ("ASK", 2), ("ASK_QTY", 0), ("CHNG", 2),
           ("LTP", 2), ("IV", 2), ("VOLUME", 0), ("CHNG_IN_OI", 0), ("OI", 0)]
ALL_NSE_FIELDS = [n for n, _ in CE_SPEC]

APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / "nse_history.db"
CONFIG_PATH = APP_DIR / "config.json"

DEFAULTS = {
    "kind": "Indices", "symbol": "NIFTY", "view_mode": "NSE website format",
    "fields": ALL_NSE_FIELDS, "custom_cols": DEFAULT_COLS, "atm_n": 0,
    "highlight_atm": False, "auto": False, "interval": 60, "log": False,
}


def load_config():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg: dict):
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- NSE client
class NSE:
    """requests.Session that fetches its own NSE cookies (no browser needed)."""

    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update(HEADERS)
        self._warm()

    def _warm(self):
        self.s.get(BASE, timeout=10)
        self.s.get(BASE + "/option-chain", timeout=10)

    def get(self, path, params=None):
        last = None
        for _ in range(3):
            try:
                r = self.s.get(BASE + path, params=params, timeout=10)
                last = r.status_code
                if r.status_code == 200 and r.text.strip():
                    return r.json()
            except (requests.RequestException, ValueError):
                last = "network/parse error"
            try:
                self._warm()
            except requests.RequestException:
                pass
            time.sleep(1.5)
        raise RuntimeError(f"NSE request failed ({last}) for {path}")


def get_expiries(client, symbol):
    d = client.get("/api/option-chain-contract-info", {"symbol": symbol})
    ex = d.get("expiryDates") or (d.get("records") or {}).get("expiryDates") or []
    return list(ex)


def get_chain(client, symbol, expiry, kind="Indices"):
    return client.get(
        "/api/option-chain-v3", {"type": kind, "symbol": symbol, "expiry": expiry}
    )


def ist_now():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30)))


def market_open(now=None):
    """Mon-Fri 09:15-15:35 IST. Exchange holidays are NOT checked."""
    now = now or ist_now()
    return now.weekday() < 5 and dt.time(9, 15) <= now.time() <= dt.time(15, 35)


# ------------------------------------------------------------------- parsing
def parse(data: dict):
    rec = data["records"]
    spot = rec.get("underlyingValue")
    ts = rec.get("timestamp")
    rows = []
    for item in rec["data"]:
        ce, pe = item.get("CE") or {}, item.get("PE") or {}
        strike = ce.get("strikePrice") or pe.get("strikePrice") or item.get("strikePrice")
        if strike is None:
            continue
        row = {"STRIKE": strike}
        for k, name in FIELDS.items():
            row["CE_" + name] = ce.get(k)
            row["PE_" + name] = pe.get(k)
        rows.append(row)
    df = pd.DataFrame(rows).sort_values("STRIKE").reset_index(drop=True)
    return df, spot, ts


def trim_atm(df: pd.DataFrame, spot, n):
    if not n or spot is None or df.empty:
        return df
    i = (df["STRIKE"] - spot).abs().idxmin()
    return df.iloc[max(0, i - n): i + n + 1]


def fmt_in(x, d=0):
    """Indian digit grouping (1,05,611), '-' for zero/empty, like the NSE page."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return "-"
    if x != x or x == 0:
        return "-"
    s = f"{abs(x):.{d}f}"
    ip, _, fp = s.partition(".")
    if len(ip) > 3:
        head, tail = ip[:-3], ip[-3:]
        head = re.sub(r"(?<=\d)(?=(\d\d)+$)", ",", head)
        ip = head + "," + tail
    out = ip + ("." + fp if fp else "")
    return ("-" if x < 0 else "") + out


# ----------------------------------------------------------------- analytics
def max_pain(df: pd.DataFrame):
    """Strike where total payout to option BUYERS at expiry would be lowest."""
    if df.empty:
        return None
    s = df["STRIKE"].to_numpy(dtype=float)
    ce = pd.to_numeric(df["CE_OI"], errors="coerce").fillna(0).to_numpy()
    pe = pd.to_numeric(df["PE_OI"], errors="coerce").fillna(0).to_numpy()
    k = s[:, None]
    pain = (ce[None, :] * np.maximum(0, k - s[None, :])).sum(axis=1) \
        + (pe[None, :] * np.maximum(0, s[None, :] - k)).sum(axis=1)
    return float(s[pain.argmin()])


def summarize(df: pd.DataFrame, spot):
    ce = pd.to_numeric(df["CE_OI"], errors="coerce").fillna(0)
    pe = pd.to_numeric(df["PE_OI"], errors="coerce").fillna(0)
    out = {"ce_oi": float(ce.sum()), "pe_oi": float(pe.sum())}
    out["pcr"] = out["pe_oi"] / out["ce_oi"] if out["ce_oi"] else float("nan")
    out["max_pain"] = max_pain(df)
    out["max_ce_strike"] = float(df.loc[ce.idxmax(), "STRIKE"]) if ce.max() > 0 else None
    out["max_pe_strike"] = float(df.loc[pe.idxmax(), "STRIKE"]) if pe.max() > 0 else None
    return out


# ------------------------------------------------------------ SQLite storage
_DATA_COLS = ["STRIKE"] + [f"{side}_{n}" for n in FIELDS.values() for side in ("CE", "PE")]


def db_connect():
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.execute(
        "CREATE TABLE IF NOT EXISTS snapshots ("
        "symbol TEXT, expiry TEXT, ts_iso TEXT, nse_ts TEXT, logged_at TEXT, spot REAL, "
        + ", ".join(f"{c} REAL" for c in _DATA_COLS) + ")"
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_snap ON snapshots(symbol, expiry, ts_iso)")
    return con


def _ts_iso(ts):
    try:
        return dt.datetime.strptime(ts, "%d-%b-%Y %H:%M:%S").isoformat(sep=" ")
    except (TypeError, ValueError):
        return dt.datetime.now().isoformat(sep=" ", timespec="seconds")


def save_snapshot(full: pd.DataFrame, symbol, expiry, spot, ts) -> bool:
    """Store one full snapshot. Returns False if this NSE timestamp is already stored."""
    iso = _ts_iso(ts)
    with closing(db_connect()) as con:
        if con.execute(
            "SELECT 1 FROM snapshots WHERE symbol=? AND expiry=? AND ts_iso=? LIMIT 1",
            (symbol, expiry, iso),
        ).fetchone():
            return False
        d = full.reindex(columns=_DATA_COLS).apply(pd.to_numeric, errors="coerce")
        d.insert(0, "spot", spot)
        d.insert(0, "logged_at", dt.datetime.now().isoformat(sep=" ", timespec="seconds"))
        d.insert(0, "nse_ts", ts)
        d.insert(0, "ts_iso", iso)
        d.insert(0, "expiry", expiry)
        d.insert(0, "symbol", symbol)
        d.to_sql("snapshots", con, if_exists="append", index=False)
        con.commit()
    return True


def history_days(symbol, expiry):
    with closing(db_connect()) as con:
        rows = con.execute(
            "SELECT DISTINCT substr(ts_iso,1,10) FROM snapshots "
            "WHERE symbol=? AND expiry=? ORDER BY 1 DESC", (symbol, expiry)).fetchall()
    return [r[0] for r in rows]


def load_history(symbol, expiry, day=None):
    q = "SELECT * FROM snapshots WHERE symbol=? AND expiry=?"
    params = [symbol, expiry]
    if day:
        q += " AND substr(ts_iso,1,10)=?"
        params.append(str(day))
    q += " ORDER BY ts_iso, STRIKE"
    with closing(db_connect()) as con:
        df = pd.read_sql_query(q, con, params=params)
    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts_iso"])
    return df
