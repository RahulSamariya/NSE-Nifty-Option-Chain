"""Local helper that connects the web app to the Excel feature.

A browser page cannot start Excel, write a workbook or read a local file, so the
web app talks to this tiny server instead. It listens on loopback only.

    python excel/excel_server.py                 # http://127.0.0.1:8765
    python excel/excel_server.py --port 8765

Endpoints (all JSON unless noted)
  GET  /health                 helper + workbook + poller status
  GET  /live?interval=3        open the self-refreshing workbook; the interval is
                               how often the hidden poller fetches NSE, in
                               minutes (1-60). Restarts the poller if it is
                               already running, so the timer can be changed.
  POST /live {"interval": 3}   same as above
  GET  /download               fresh, fully styled .xlsx (file download)
  GET  /stop                   stop the hidden poller

Excel itself keeps reading the local CSV once a minute; the interval only
changes how often that CSV is refreshed from NSE. No need to close the
workbook when changing it.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
for _p in (ROOT, ROOT / "core", HERE):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import excel_auto as xa  # noqa: E402

OUT_DIR = xa.OUT_DIR
STATE_FILE = OUT_DIR / "excel_server_state.json"
SYMBOL = "NIFTY"          # same baked-in defaults as the bat files
KIND = "Indices"
DEFAULT_MINUTES = 1
MIN_MINUTES, MAX_MINUTES = 1, 60

_lock = threading.Lock()
_state = {"busy": False, "error": None, "note": None}


# ------------------------------------------------------------------ helpers
def _load_interval() -> int:
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return max(MIN_MINUTES, min(MAX_MINUTES, int(raw["interval"])))
    except Exception:
        return DEFAULT_MINUTES


def _save_interval(minutes: int) -> None:
    try:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"interval": int(minutes)}), encoding="utf-8")
    except OSError:
        pass


def _live_workbook() -> Path | None:
    try:
        books = sorted(
            OUT_DIR.glob("*_live.xlsx"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return None
    return books[0] if books else None


def _csv_stats(csv_path: Path | None) -> tuple[int, str | None, int | None]:
    """(strike rows, updated ISO local time, age seconds) from the poller CSV."""
    if csv_path is None or not csv_path.exists():
        return 0, None, None
    try:
        with csv_path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
            rows = list(csv.reader(fh))
    except OSError:
        return 0, None, None
    strikes = sum(1 for row in rows if len(row) > xa.N_CE and row[xa.N_CE].strip())
    try:
        mtime = csv_path.stat().st_mtime
    except OSError:
        return strikes, None, None
    return (
        strikes,
        dt.datetime.fromtimestamp(mtime).strftime("%Y-%m-%dT%H:%M:%S"),
        max(0, int(time.time() - mtime)),
    )


def _status() -> dict:
    book = _live_workbook()
    csv_path = book.with_suffix(".csv") if book else None
    rows, updated, age = _csv_stats(csv_path)
    symbol, expiry = SYMBOL, None
    if book is not None:
        stem = book.stem
        if stem.endswith("_live"):
            stem = stem[: -len("_live")]
        if "_" in stem:
            symbol, expiry = stem.split("_", 1)
        else:
            symbol = stem
    with _lock:
        busy, error, note = _state["busy"], _state["error"], _state["note"]
    return {
        "ok": True,
        "helper": "running",
        "com": xa.HAS_COM,
        "symbol": symbol,
        "expiry": expiry,
        "interval": _load_interval(),
        "running": bool(book) and xa._poller_running(book),
        "busy": busy,
        "error": error,
        "note": note,
        "rows": rows,
        "updated": updated,
        "age_seconds": age,
        "workbook": book.name if book else None,
        "folder": str(OUT_DIR),
    }


# ------------------------------------------------------------------ actions
def _start_live(minutes: int) -> bool:
    with _lock:
        if _state["busy"]:
            return False
        _state.update(busy=True, error=None, note="fetching from NSE")
    threading.Thread(target=_live_worker, args=(minutes,), daemon=True,
                     name="excel-live").start()
    return True


def _live_worker(minutes: int) -> None:
    try:
        # a new interval only takes effect in a new poller
        for book in OUT_DIR.glob("*_live.xlsx"):
            if xa._poller_running(book):
                xa.stop_poller(book)

        args = SimpleNamespace(
            symbol=SYMBOL,
            expiry=None,
            kind=KIND,
            interval=max(60, int(minutes) * 60),  # poller fetch rate (seconds)
            retries=3,
            out=str(OUT_DIR),
            no_open=False,
        )
        xa.mode_live(args)
        with _lock:
            _state["note"] = "live workbook ready"
    except Exception as exc:  # noqa: BLE001 - report, never crash the server
        with _lock:
            _state["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        with _lock:
            _state["busy"] = False


def _stop_pollers() -> int:
    stopped = 0
    for book in OUT_DIR.glob("*_live.xlsx"):
        if xa._poller_running(book):
            xa.stop_poller(book)
            stopped += 1
    return stopped


# ------------------------------------------------------------------ server
class Handler(BaseHTTPRequestHandler):
    server_version = "NSEExcelHelper/1.0"

    def log_message(self, fmt: str, *args) -> None:  # keep the console readable
        sys.stdout.write("[{:%H:%M:%S}] {} {}\n".format(
            dt.datetime.now(), self.command, fmt % args))
        sys.stdout.flush()

    # -- plumbing
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
        self.send_header("Access-Control-Max-Age", "600")
        # Chrome's Private Network Access preflight (https page -> localhost)
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def _json(self, payload: dict, code: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    # -- routes
    def _route(self, method: str) -> None:
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        try:
            if path == "/health":
                return self._json(_status())
            if path == "/live":
                minutes = parse_qs(url.query).get("interval", [None])[0]
                if method == "POST":
                    minutes = self._body_interval() or minutes
                return self._live(minutes)
            if path == "/stop":
                stopped = _stop_pollers()
                payload = _status()
                payload.update(ok=True, stopped=stopped)
                return self._json(payload)
            if path == "/download" and method == "GET":
                return self._download()
            return self._json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            return self._json({"ok": False,
                               "error": f"{type(exc).__name__}: {exc}"}, 500)

    def _body_interval(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if not length:
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return None
        return data.get("interval") if isinstance(data, dict) else None

    def _live(self, minutes) -> None:
        try:
            value = int(str(minutes).strip())
        except (TypeError, ValueError):
            payload = _status()
            payload.update(ok=False,
                           error="interval must be a whole number of minutes (1-60)")
            return self._json(payload, 400)

        value = max(MIN_MINUTES, min(MAX_MINUTES, value))
        _save_interval(value)
        started = _start_live(value)
        payload = _status()
        payload.update(ok=True, interval=value,
                       started=started,
                       note=None if started else "already starting - wait a moment",
                       error=None if started else payload.get("error"))
        return self._json(payload, 202 if started else 200)

    def _download(self) -> None:
        fetcher = xa.Fetcher(SYMBOL, None, KIND, 3)
        df, spot, ts, symbol, expiry = fetcher.get()
        pcr, max_pain, ce_oi, pe_oi = xa._summary_stats(df, spot)
        data = xa.build_workbook(df, spot, symbol, expiry, ts, pcr, max_pain,
                                 ce_oi, pe_oi)
        name = f"{symbol}_{expiry}.xlsx"
        self.send_response(200)
        self._cors()
        self.send_header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Local helper for the web app's Excel feature.")
    ap.add_argument("--host", default="127.0.0.1", help="loopback only (default)")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args(argv)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"NSE Excel helper -> http://{args.host}:{args.port}")
    print(f"output folder   -> {OUT_DIR}")
    print("keep this window open while using Excel in the web app; Ctrl+C stops it")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
