"""One-click NSE Option Chain -> Excel automation.

A standalone feature. It imports core/nse_core.py (read-only) for fetching/parsing
and never touches the dashboard, the worker or the web app.

Modes (run from the repository root)
------------------------------------
  python excel/excel_auto.py            ONE CLICK : fetch -> write formatted .xlsx -> open it
  python excel/excel_auto.py --live     workbook that keeps itself refreshed (best mode)
  python excel/excel_auto.py --watch    headless : rewrite the workbook every N seconds

Defaults are baked in, so nothing has to be configured:
  symbol  = NIFTY      expiry = nearest one from NSE      view = FULL chain (all strikes)
  layout  = NSE website style, Indian number format, ITM/ATM shading, frozen headers

--live writes <symbol>_<expiry>_live.csv and attaches a native Excel TEXT data
connection to <symbol>_<expiry>_live.xlsx. Excel itself reloads that file on open
and on a timer - no macro, no .xlsm, no Trust Center setting. A hidden background
process keeps the CSV current and exits by itself when you close the workbook.

Output goes to excel/excel_output/ (git-ignored).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import math
import os
import subprocess
import sys
import time
from pathlib import Path

# repo layout: core/ holds nse_core.py, this file lives in excel/
ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "core"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import nse_core as nc

try:  # optional: only needed for the Excel data connection
    import pythoncom
    import win32com.client

    HAS_COM = True
except Exception:  # pragma: no cover
    HAS_COM = False


# ---------------------------------------------------------------- layout
# outputs stay inside the excel/ feature folder (git-ignored)
OUT_DIR = Path(__file__).resolve().parent / "excel_output"
PAD_ROWS = 400  # fixed CSV/xlsx block so old rows are always overwritten

CE = list(nc.CE_SPEC)  # [(column, decimals), ...]  order = NSE website
PE = list(nc.PE_SPEC)
N_CE, N_PE = len(CE), len(PE)
TOTAL = N_CE + 1 + N_PE  # 21 -> A..U
SPACER = TOTAL  # 0-based 21 -> column V
SUM_W = TOTAL + 1  # 0-based 22 -> column W
SUM_X = TOTAL + 2  # 0-based 23 -> column X
NCOLS = TOTAL + 3  # 24

# specs in sheet order: (prefix, column name, decimals)
SPECS = [("CE_", n, d) for n, d in CE] + [("", "STRIKE", 0)] + \
        [("PE_", n, d) for n, d in PE]

HDR_FILL = "3A2F86"
ITM_FILL = "EFE9CF"
ATM_FILL = "FFE066"

FMT_INT = "#,##,##0;[Red]-#,##,##0"
FMT_DEC = "#,##,##0.00;[Red]-#,##,##0.00"
FMT_PCR = "0.00"
FMT_SIGNED_INT = "+#,##0;[Red]-#,##0;0"
FMT_SIGNED_DEC = "+#,##0.00;[Red]-#,##0.00;0.00"

# summary block: sheet row -> (label, value, number format)
SUMMARY_ROWS = [
    ("SYMBOL", "text"),
    ("EXPIRY", "dd-mmm-yyyy"),
    ("SPOT", FMT_DEC),
    ("PCR (OI)", FMT_PCR),
    ("MAX PAIN", FMT_DEC),
    ("TOTAL CE OI", FMT_INT),
    ("TOTAL PE OI", FMT_INT),
    ("NSE TIMESTAMP", "dd-mmm-yyyy hh:mm:ss"),
    ("UPDATED (IST)", "yyyy-mm-dd hh:mm:ss"),
]


def _fmt_for(name: str, dec: int) -> str:
    if name == "CHNG":
        return FMT_SIGNED_DEC
    if name == "CHNG_IN_OI":
        return FMT_SIGNED_INT
    return FMT_INT if dec == 0 else FMT_DEC


COL_FMTS = [_fmt_for(n, d) for _, n, d in SPECS]  # 21 number formats


def _num(x):
    """Cell value -> int/float/None so Excel stores real numbers, not text."""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    if f == int(f) and abs(f) < 1e15:
        return int(f)
    return f


def _summary_values(spot, symbol, expiry, ts, pcr, max_pain, ce_oi, pe_oi):
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return [
        (symbol, None),
        (expiry, None),
        (_num(spot), None),
        (_num(pcr) if pcr == pcr else None, None),
        (_num(max_pain), None),
        (_num(ce_oi), None),
        (_num(pe_oi), None),
        (ts, None),
        (now, None),
    ]


def _expiry_passed(expiry: str) -> bool:
    """True once the expiry date is behind us (weekly NSE rollover)."""
    try:
        return dt.datetime.strptime(str(expiry), "%d-%b-%Y").date() < dt.date.today()
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------- fetching
class Fetcher:
    """Keeps one warm NSE session alive and returns a parsed chain."""

    def __init__(self, symbol="NIFTY", expiry=None, kind="Indices", retries=3):
        self.symbol = symbol
        self.expiry = expiry
        self.kind = kind
        self.retries = max(1, retries)
        self.client = None

    def get(self):
        last = None
        for attempt in range(self.retries):
            try:
                if self.expiry and _expiry_passed(self.expiry):
                    self.expiry = None  # rolled over -> pick the new nearest
                if self.client is None:
                    self.client = nc.NSE()
                if not self.expiry:
                    ex = nc.get_expiries(self.client, self.symbol)
                    if not ex:
                        raise RuntimeError("NSE returned no expiry dates")
                    self.expiry = ex[0]
                raw = nc.get_chain(self.client, self.symbol, self.expiry, self.kind)
                df, spot, ts = nc.parse(raw)
                if df.empty:
                    raise RuntimeError("NSE returned an empty option chain")
                return df, spot, ts, self.symbol, self.expiry
            except Exception as e:  # noqa: BLE001 - keep polling through NSE hiccups
                last = e
                self.client = None  # force a fresh session (re-warm cookies)
                if attempt + 1 < self.retries:
                    time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"could not fetch from NSE: {last}")


# ---------------------------------------------------------------- CSV (live source)
def build_csv(df, spot, symbol, expiry, ts, pcr, max_pain, ce_oi, pe_oi) -> str:
    """NSE layout as raw numbers -> source for Excel's auto-refreshing query."""
    grid = [[""] * NCOLS for _ in range(2 + PAD_ROWS)]

    # row 1: CALLS / PUTS bands (never merged -> refresh can't wipe them)
    grid[0][0] = "CALLS"
    grid[0][N_CE + 1] = "PUTS"

    # row 2: column headers
    grid[1][:TOTAL] = [n.replace("_", " ") for n, _, _ in SPECS]
    grid[0][SUM_W] = "SUMMARY"
    grid[1][SUM_W], grid[1][SUM_X] = "METRIC", "VALUE"

    # rows 3..11: summary block (refreshed together with the chain)
    for i, (label, _fmt) in enumerate(SUMMARY_ROWS):
        grid[2 + i][SUM_W] = label
    values = _summary_values(spot, symbol, expiry, ts, pcr, max_pain, ce_oi, pe_oi)
    for i, (value, _fmt) in enumerate(values):
        grid[2 + i][SUM_X] = "" if value is None else value

    # rows 3.. : the chain
    for r, (_, row) in enumerate(df.iterrows()):
        rr = 2 + r
        if rr >= len(grid):
            break
        for c, (pre, name, _d) in enumerate(SPECS):
            grid[rr][c] = _num(row[pre + name])

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerows(grid)
    return buf.getvalue()


def write_text(path: Path, text: str) -> None:
    """Atomic-ish write so Excel never reads a half-written CSV."""
    tmp = path.with_name(path.name + ".tmp")
    last = None
    for _ in range(12):
        try:
            tmp.write_text(text, encoding="utf-8", newline="")
            os.replace(tmp, path)
            return
        except OSError as e:  # Excel is reading/holding it
            last = e
            time.sleep(0.25)
    raise RuntimeError(f"could not write {path.name}: {last}")


# ---------------------------------------------------------------- workbook
def build_workbook(df, spot, symbol, expiry, ts, pcr, max_pain, ce_oi, pe_oi) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    wb = Workbook()
    ws = wb.active
    ws.title = "OptionChain"
    ws.sheet_view.showGridLines = False

    hdr_fill = PatternFill("solid", fgColor=HDR_FILL)
    itm_fill = PatternFill("solid", fgColor=ITM_FILL)
    atm_fill = PatternFill("solid", fgColor=ATM_FILL)
    lbl_fill = PatternFill("solid", fgColor="F2F2F2")
    white = Font(color="FFFFFF", bold=True, size=10)
    bold = Font(bold=True, size=10)
    base = Font(size=10)
    center = Alignment(horizontal="center", vertical="center")
    across = Alignment(horizontal="centerContinuous", vertical="center")
    right = Alignment(horizontal="right", vertical="center")
    side = Side(style="thin", color="ECECEC")
    row_border = Border(bottom=side)
    box = Border(left=side, right=side, top=side, bottom=side)

    # ── row 1: CALLS / PUTS (centerContinuous, NOT merged: live-safe)
    for c in range(1, N_CE + 1):
        cell = ws.cell(1, c)
        cell.fill, cell.font, cell.alignment = hdr_fill, white, across
    ws.cell(1, 1, "CALLS")
    for c in range(N_CE + 2, TOTAL + 1):
        cell = ws.cell(1, c)
        cell.fill, cell.font, cell.alignment = hdr_fill, white, across
    ws.cell(1, N_CE + 2, "PUTS")

    # ── row 2: column headers
    for c, (pre, name, _d) in enumerate(SPECS, start=1):
        cell = ws.cell(2, c, name.replace("_", " "))
        cell.fill, cell.font, cell.alignment = hdr_fill, white, center

    # ── summary block header (columns W:X, beside the CALLS/PUTS band)
    for c in (SUM_W + 1, SUM_X + 1):
        cell = ws.cell(1, c)
        cell.fill, cell.font, cell.alignment = hdr_fill, white, across
    ws.cell(1, SUM_W + 1, "SUMMARY")
    ws.cell(2, SUM_W + 1, "METRIC")
    ws.cell(2, SUM_X + 1, "VALUE")
    for c in (SUM_W + 1, SUM_X + 1):
        cell = ws.cell(2, c)
        cell.fill, cell.font, cell.alignment = hdr_fill, white, center

    # ── number formats across the whole padded block (keeps refresh pretty)
    for rr in range(3, 3 + PAD_ROWS):
        for c in range(1, TOTAL + 1):
            ws.cell(rr, c).number_format = COL_FMTS[c - 1]
    for i, (_label, fmt) in enumerate(SUMMARY_ROWS):
        if fmt != "text":
            ws.cell(3 + i, SUM_X + 1).number_format = fmt

    # ── chain rows
    atm = None
    if spot is not None and len(df):
        atm = df.loc[(df["STRIKE"] - spot).abs().idxmin(), "STRIKE"]
    for r, (_, row) in enumerate(df.iterrows()):
        rr = 3 + r
        k = row["STRIKE"]
        for c, (pre, name, _d) in enumerate(SPECS, start=1):
            cell = ws.cell(rr, c, _num(row[pre + name]))
            cell.font = base
            cell.alignment = center
            cell.border = row_border
            if pre == "CE_" and spot is not None and k < spot:
                cell.fill = itm_fill
            elif pre == "PE_" and spot is not None and k > spot:
                cell.fill = itm_fill
            elif not pre:
                cell.font = bold
                cell.fill = atm_fill if atm is not None and k == atm else PatternFill()

    # ── summary values
    values = _summary_values(spot, symbol, expiry, ts, pcr, max_pain, ce_oi, pe_oi)
    for i, (label, fmt) in enumerate(SUMMARY_ROWS):
        rr = 3 + i
        lc, vc = ws.cell(rr, SUM_W + 1, label), ws.cell(rr, SUM_X + 1, values[i][0])
        lc.font, lc.fill, lc.alignment, lc.border = bold, lbl_fill, Alignment(
            horizontal="left", vertical="center", indent=1), box
        vc.font, vc.alignment, vc.border = base, right, box
        if fmt != "text":
            vc.number_format = fmt

    # ── cosmetics
    for c in range(1, TOTAL + 1):
        ws.column_dimensions[_col_letter(c)].width = 13
    ws.column_dimensions[_col_letter(N_CE + 1)].width = 11
    ws.column_dimensions[_col_letter(SPACER + 1)].width = 2.5
    ws.column_dimensions[_col_letter(SUM_W + 1)].width = 17
    ws.column_dimensions[_col_letter(SUM_X + 1)].width = 26
    ws.row_dimensions[1].height = 22
    ws.row_dimensions[2].height = 20
    ws.freeze_panes = "A3"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_live_shell() -> bytes:
    """Empty canvas for the live workbook.

    Excel's data connection owns every cell it refreshes, so there is no point
    pre-painting it here - the connection wipes fills and fonts. Only sheet-level
    things (frozen header) and the number formats reapplied after the first
    refresh survive, so this stays deliberately bare.
    """
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "OptionChain"
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A3"
    ws.row_dimensions[1].height = 22
    ws.row_dimensions[2].height = 20
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _col_letter(i: int) -> str:
    from openpyxl.utils import get_column_letter

    return get_column_letter(i)


# ---------------------------------------------------------------- Excel COM
def _excel_process_running() -> bool:
    """Cheap check (no COM, never starts Excel): is EXCEL.EXE alive?"""
    if not HAS_COM:
        return False
    try:
        import win32api
        import win32con
        import win32process

        me = win32api.GetCurrentProcessId()
        for pid in win32process.EnumProcesses():
            if pid == me:
                continue
            try:
                h = win32api.OpenProcess(
                    win32con.PROCESS_QUERY_INFORMATION | win32con.PROCESS_VM_READ,
                    False, pid)
            except Exception:
                continue
            try:
                name = win32process.GetModuleFileNameEx(h, 0)
            except Exception:
                name = ""
            finally:
                win32api.CloseHandle(h)
            if name and name.lower().endswith("excel.exe"):
                return True
    except Exception:
        return True  # unknown -> let the caller try COM anyway
    return False


def _open_workbook_names(app):
    try:
        return [app.Workbooks.Item(i).Name.lower()
                for i in range(1, app.Workbooks.Count + 1)]
    except Exception:
        return []


def _attach_excel():
    """Attach to an Excel that is already running. NEVER starts one."""
    try:
        return win32com.client.GetActiveObject("Excel.Application")
    except Exception:
        return None


def _owner_file(path: Path) -> Path:
    """Excel's lock file ('~$name.xlsx') exists exactly while the workbook is open."""
    return path.with_name("~$" + path.name)


def _workbook_open(path: Path) -> bool:
    """True only if the workbook is open somewhere. Never starts Excel and never
    opens the file (plain GetObject() would do both)."""
    if not HAS_COM:
        return False
    owner = _owner_file(path)
    if not _excel_process_running():
        try:  # Excel died at some point -> stale lock file, clean it up
            owner.unlink()
        except OSError:
            pass
        return False
    if owner.exists():
        return True
    pythoncom.CoInitialize()
    try:
        app = _attach_excel()
        return bool(app) and path.name.lower() in _open_workbook_names(app)
    except Exception:
        return False
    finally:
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def _set(obj, name, value) -> bool:
    try:
        setattr(obj, name, value)
        return True
    except Exception:
        return False


def _style_live_sheet(ws) -> None:
    """Number formats + widths. Excel keeps number formats across refreshes,
    so this only has to happen once."""
    for i, fmt in enumerate(COL_FMTS):
        ws.Range(ws.Cells(3, i + 1), ws.Cells(2 + PAD_ROWS, i + 1)).NumberFormat = fmt
    for i, (_label, fmt) in enumerate(SUMMARY_ROWS):
        if fmt != "text":
            ws.Cells(3 + i, SUM_X + 1).NumberFormat = fmt
    for c in range(1, TOTAL + 1):
        ws.Columns(c).ColumnWidth = 13
    ws.Columns(N_CE + 1).ColumnWidth = 11
    ws.Columns(SPACER + 1).ColumnWidth = 2.5
    ws.Columns(SUM_W + 1).ColumnWidth = 17
    ws.Columns(SUM_X + 1).ColumnWidth = 26


def ensure_query(xlsx: Path, csv_path: Path, interval: int = 60) -> str:
    """Attach the auto-refreshing TEXT connection to the workbook (one-time).

    Excel only writes the query parts to the file during a save that happens
    AFTER the first refresh, so the order here matters: create -> refresh -> save.
    """
    if not HAS_COM:
        return "pywin32 missing -> auto-refresh not configured (pip install pywin32)"
    if _workbook_open(xlsx):
        return "workbook already open -> query left as it is"

    pythoncom.CoInitialize()
    app = None
    notes = []
    try:
        app = win32com.client.DispatchEx("Excel.Application")
        app.Visible = False
        app.DisplayAlerts = False
        app.AskToUpdateLinks = False
        _set(app, "EnableEvents", False)

        wb = app.Workbooks.Open(str(xlsx))
        try:
            ws = wb.Worksheets(1)
            if ws.QueryTables.Count == 0:
                qt = ws.QueryTables.Add(f"TEXT;{csv_path}", ws.Range("A1"))
                notes.append("connection created")
            else:
                qt = ws.QueryTables.Item(1)
                _set(qt, "Connection", f"TEXT;{csv_path}")
                notes.append("connection reused")

            for name, value in (
                ("RefreshOnFileOpen", True),
                ("BackgroundQuery", False),
                ("AdjustColumnWidth", False),
                ("PreserveFormatting", True),   # <- keeps our colours/number formats
                ("TextFileParseType", 1),       # xlDelimited
                ("TextFileStartRow", 1),
                ("TextFileCommaDelimiter", True),
                ("TextFileTabDelimiter", False),
                ("TextFileSemicolonDelimiter", False),
                ("TextFileConsecutiveDelimiter", False),
                ("TextFileSpaceDelimiter", False),
            ):
                _set(qt, name, value)

            minutes = max(1, round(max(15, interval) / 60))
            if _set(qt, "RefreshPeriod", minutes):
                notes.append(f"auto-refresh every {minutes} min")
            else:
                notes.append("no timer available -> refreshed on open only")

            try:
                qt.Refresh(False)  # needs to happen before saving the query parts
                notes.append("refreshed")
                _style_live_sheet(ws)  # data now exists -> formats stick
                notes.append("formatted")
            except Exception as e:  # noqa: BLE001
                notes.append(f"first refresh failed: {e}")

            wb.Save()
            notes.append("saved")
        finally:
            try:
                wb.Close(False)
            except Exception:
                pass
    except Exception as e:  # noqa: BLE001
        import traceback

        traceback.print_exc(file=sys.stderr)
        return f"COM setup failed: {e}"
    finally:
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass
    return "; ".join(notes)


def refresh_if_open(xlsx: Path) -> bool:
    """Ask the *running* Excel to reload the CSV. Never starts Excel, never quits
    it (that instance may be the user's)."""
    if not HAS_COM or not _workbook_open(xlsx):
        return False
    pythoncom.CoInitialize()
    try:
        app = _attach_excel()
        if app is None:
            return False
        if xlsx.name.lower() not in _open_workbook_names(app):
            return False
        try:
            app.Workbooks.Item(xlsx.name).RefreshAll()
            return True
        except Exception:
            return False
    finally:
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


# ---------------------------------------------------------------- background updater
def _lock_path(xlsx: Path) -> Path:
    return xlsx.with_suffix(".lock")


def _pid_alive(pid: int) -> bool:
    try:
        import ctypes

        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
        if not h:
            return False
        code = ctypes.c_ulong(0)
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE
    except Exception:
        return False


def _poller_running(xlsx: Path) -> bool:
    lock = _lock_path(xlsx)
    try:
        return _pid_alive(int(lock.read_text().strip()))
    except Exception:
        return False


def _spawn_poller(xlsx: Path, csv_path: Path, args) -> str:
    """Start the CSV updater with pythonw.exe (no console window) and detach."""
    if _poller_running(xlsx):
        return "updater already running"
    exe = Path(sys.executable)
    windowless = exe.with_name("pythonw.exe")
    if windowless.exists():
        exe = windowless
    cmd = [str(exe), str(Path(__file__).resolve()), "--poller",
           "--csv", str(csv_path), "--xlsx", str(xlsx),
           "--symbol", args.symbol, "--kind", args.kind,
           "--interval", str(max(15, args.interval)),
           "--retries", str(args.retries)]
    if args.expiry:
        cmd += ["--expiry", args.expiry]
    try:
        subprocess.Popen(
            cmd, creationflags=0x00000008 | 0x00000200,  # DETACHED | NEW_GROUP
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, close_fds=True, cwd=str(nc.APP_DIR))
    except Exception as e:  # noqa: BLE001
        return f"could not start updater: {e}"
    return "background updater started (no window, stops by itself)"


def mode_poller(args) -> int:
    """Hidden loop: keep the CSV fresh; exit once the workbook is closed."""
    csv_path, xlsx = Path(args.csv), Path(args.xlsx)
    interval = max(15, args.interval)
    lock = _lock_path(xlsx)
    lock.write_text(str(os.getpid()), encoding="utf-8")

    fetcher = Fetcher(args.symbol, args.expiry, args.kind, args.retries)
    deadline = time.time() + 180  # grace period while Excel is still starting
    misses = 0
    try:
        while True:
            if time.time() > deadline and not _workbook_open(xlsx):
                misses += 1
                if misses >= 2:
                    break
            else:
                misses = 0
            try:
                df, spot, ts, symbol, expiry = fetcher.get()
                pcr, max_pain, ce_oi, pe_oi = _summary_stats(df, spot)
                write_text(csv_path, build_csv(df, spot, symbol, expiry, ts, pcr,
                                               max_pain, ce_oi, pe_oi))
                refresh_if_open(xlsx)  # belt and braces; Excel also self-refreshes
            except Exception:  # noqa: BLE001
                fetcher.client = None
            time.sleep(interval)
    finally:
        try:
            lock.unlink()
        except OSError:
            pass
    return 0


def stop_poller(xlsx: Path) -> str:
    lock = _lock_path(xlsx)
    try:
        pid = int(lock.read_text().strip())
    except Exception:
        return "no background updater was running"
    try:
        import ctypes

        h = ctypes.windll.kernel32.OpenProcess(0x0001, False, pid)  # TERMINATE
        if not h:
            lock.unlink(missing_ok=True)
            return "updater had already stopped"
        ctypes.windll.kernel32.TerminateProcess(h, 0)
        ctypes.windll.kernel32.CloseHandle(h)
    except Exception as e:  # noqa: BLE001
        return f"could not stop updater: {e}"
    lock.unlink(missing_ok=True)
    return "background updater stopped"


# ---------------------------------------------------------------- modes
def _summary_stats(df, spot):
    s = nc.summarize(df, spot)
    return s["pcr"], s["max_pain"], s["ce_oi"], s["pe_oi"]


def _paths(out: Path, symbol, expiry, live: bool):
    tag = "_live" if live else ""
    stem = f"{symbol}_{expiry}{tag}"
    return out / f"{stem}.csv", out / f"{stem}.xlsx"


def mode_once(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fetcher = Fetcher(args.symbol, args.expiry, args.kind, args.retries)

    print(f"[*] Fetching {args.symbol} option chain from NSE ...")
    df, spot, ts, symbol, expiry = fetcher.get()

    pcr, max_pain, ce_oi, pe_oi = _summary_stats(df, spot)
    _, xlsx = _paths(out, symbol, expiry, live=False)
    data = build_workbook(df, spot, symbol, expiry, ts, pcr, max_pain, ce_oi, pe_oi)

    target = xlsx
    try:
        xlsx.write_bytes(data)
    except OSError:
        # Excel has it open -> write a timestamped copy instead of failing
        stamp = dt.datetime.now().strftime("%H%M%S")
        target = xlsx.with_name(f"{xlsx.stem}_{stamp}{xlsx.suffix}")
        target.write_bytes(data)

    print(f"[ok] {symbol} {expiry}  spot={spot}  rows={len(df)}")
    print(f"[ok] wrote {target}")
    if not args.no_open:
        os.startfile(str(target))
        print("[ok] opened in Excel")
    return 0


def mode_watch(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fetcher = Fetcher(args.symbol, args.expiry, args.kind, args.retries)
    interval = max(15, args.interval)
    locked_warned = False

    while True:
        try:
            df, spot, ts, symbol, expiry = fetcher.get()
            pcr, max_pain, ce_oi, pe_oi = _summary_stats(df, spot)
            _, xlsx = _paths(out, symbol, expiry, live=False)
            data = build_workbook(df, spot, symbol, expiry, ts, pcr, max_pain,
                                  ce_oi, pe_oi)
            try:
                xlsx.write_bytes(data)
                print(f"[{dt.datetime.now():%H:%M:%S}] {symbol} {expiry} "
                      f"spot={spot} -> {xlsx.name}")
                locked_warned = False
            except OSError:
                if not locked_warned:
                    print(f"[!] Excel has {xlsx.name} open - close it, or use "
                          f"--live for in-Excel auto refresh.")
                    locked_warned = True
        except Exception as e:  # noqa: BLE001
            print(f"[{dt.datetime.now():%H:%M:%S}] retrying ({e})")
            fetcher.client = None
        time.sleep(interval)


def mode_live(args) -> int:
    if not HAS_COM:
        print("[!] pywin32 not installed -> falling back to --watch mode")
        return mode_watch(args)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fetcher = Fetcher(args.symbol, args.expiry, args.kind, args.retries)

    print("[*] NSE -> Excel, self-refreshing workbook")
    df, spot, ts, symbol, expiry = fetcher.get()
    pcr, max_pain, ce_oi, pe_oi = _summary_stats(df, spot)
    csv_path, xlsx = _paths(out, symbol, expiry, live=True)

    write_text(csv_path, build_csv(df, spot, symbol, expiry, ts, pcr, max_pain,
                                   ce_oi, pe_oi))
    if not xlsx.exists():
        xlsx.write_bytes(build_live_shell())
    print(f"[ok] {symbol} {expiry}  spot={spot}  rows={len(df)}")

    print("[*] configuring Excel's own auto-refresh ...")
    # Excel always reloads the local CSV every minute; `interval` only controls
    # how often the background poller refreshes that CSV from NSE.
    print(f"    -> {ensure_query(xlsx, csv_path, 60)}")
    print(f"    -> {_spawn_poller(xlsx, csv_path, args)}")

    if not args.no_open:
        os.startfile(str(xlsx))
        print("[ok] opened. Excel reloads the sheet itself - you can close this "
              "window; the updater stops when you close the workbook.")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="One-click NSE option chain -> Excel (no settings needed).")
    p.add_argument("--live", action="store_true",
                   help="workbook that keeps refreshing itself (recommended)")
    p.add_argument("--watch", action="store_true",
                   help="headless: keep rewriting the workbook on a timer")
    p.add_argument("--interval", type=int, default=60,
                   help="seconds between refreshes (default 60, min 15)")
    p.add_argument("--symbol", default="NIFTY", help="default NIFTY")
    p.add_argument("--expiry", default=None, help="default: nearest expiry")
    p.add_argument("--kind", default="Indices", choices=["Indices", "Equity"])
    p.add_argument("--out", default=str(OUT_DIR), help="output folder")
    p.add_argument("--retries", type=int, default=3)
    p.add_argument("--no-open", action="store_true", help="don't open Excel")
    p.add_argument("--stop", action="store_true",
                   help="stop the hidden background updater")
    # internal
    p.add_argument("--poller", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--csv", default=None, help=argparse.SUPPRESS)
    p.add_argument("--xlsx", default=None, help=argparse.SUPPRESS)
    a = p.parse_args(argv)

    try:  # keep progress visible when stdout is redirected/piped
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass

    try:
        if a.stop:
            if a.xlsx:
                print(f"[ok] {stop_poller(Path(a.xlsx))}")
                return 0
            hits = sorted(Path(a.out).glob("*.lock"))
            if not hits:
                print("[ok] nothing to stop")
            for lock in hits:
                print(f"[ok] {stop_poller(lock.with_suffix('.xlsx'))} "
                      f"({lock.stem})")
            return 0
        if a.poller:
            return mode_poller(a)
        if a.live:
            return mode_live(a)
        if a.watch:
            return mode_watch(a)
        return mode_once(a)
    except KeyboardInterrupt:
        print("\n[stopped]")
        return 130
    except Exception as e:  # noqa: BLE001
        print(f"[!] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
