# 📁 Excel automation (standalone feature)

Fetch the NSE option chain and get it into Excel **in one click** — no settings,
no Streamlit, no configuration. This feature only *reads* `core/nse_core.py`, so
the dashboard, the worker and the web app are untouched.

---

## ⚡ The two clicks

| What you want | Do this |
|---|---|
| A fresh, fully formatted workbook right now | Double-click **`excel/excel_now.bat`** |
| An Excel sheet that keeps updating by itself | Double-click **`excel/excel_live.bat`** |
| Drive the local Excel automation from a browser (optional) | Double-click **`excel/excel_server.bat`** |

All of them use the same baked-in defaults: **NIFTY → nearest expiry → the FULL
chain (all strikes)**.

Files land in `excel/excel_output/` (git-ignored), e.g.:

```
excel/excel_output/
├── NIFTY_27-Oct-2026.xlsx          <- one-click export (styled like NSE)
├── NIFTY_27-Oct-2026_live.xlsx     <- auto-refreshing workbook
└── NIFTY_27-Oct-2026_live.csv      <- the file Excel reads
```

---

## 🔄 `excel_live.bat` — set up once, then Excel looks after itself

You do **not** configure anything, and you do **not** have to keep anything open.

1. Double-click `excel_live.bat`.
2. It writes the chain to a CSV and creates the workbook **already wired to it**
   with a normal Excel data connection (`Data → Refresh All` style, *not* a
   macro, *not* an `.xlsm`, *no* Trust Center checkbox).
3. Excel opens. From then on Excel reloads the sheet **by itself, every
   minute**, and also every time you open the file — it remembers the connection
   inside the `.xlsx`.
4. A tiny background helper (no window) keeps that CSV current and stops by
   itself when you close the workbook.

Close Excel → updating stops. Open the same `.xlsx` tomorrow → it refreshes on
open. You never reconfigure it.

### The workbook

* **A–U** — the chain in NSE website order: `CALLS | STRIKE | PUTS`
* **W–X** — summary: symbol, expiry, spot, PCR (OI), Max Pain, total CE/PE OI,
  NSE timestamp and `UPDATED (IST)`, which moves on every refresh so you can see
  the sheet is alive
* real **numbers**, not text — sort, filter, pivot, write formulas over it
* Indian digit grouping via Excel number formats (`1,05,611`) while the cell
  still holds `105611`
* frozen header rows, no merged cells (so a refresh can never mangle the layout)

> `excel_now.bat` (the snapshot mode) additionally colours ITM strikes and
> highlights the ATM strike. The live sheet stays plain on purpose: Excel owns
> every cell it refreshes, so paint added there would be wiped on the first
> refresh anyway.

---

## 🌐 Local helper (optional/legacy)

The web app no longer needs a local helper: its header **Export Excel** button
opens a hosted panel (symbol, expiry, strike range, import fields, refresh,
auto-refresh interval, download) that builds the workbook on the server. Nothing
in the deployed site depends on this folder.

The helper still exists for developers who want to drive the **local** Excel
automation from a browser on the same PC:

```bash
python excel\excel_server.py        # or double-click excel\excel_server.bat
```

It listens on **`http://127.0.0.1:8765`** only (loopback, not your LAN, not the
internet) and offers:

* **Open live workbook** — starts Excel on this PC with the self-refreshing sheet
* **Download .xlsx** — a fresh, fully styled snapshot, saved by the browser
* **NSE refresh timer** — how often the background fetcher polls NSE, in minutes
  (1–60, default 1)

Changing the timer only restarts the hidden background fetcher. Excel keeps
re-reading its local copy every minute, so **you never have to close or rebuild
the workbook** when you change it.

The dashboard does not call this helper, so no "helper is not running" dialog can
block a normal visitor. The two `.bat` files above work exactly as before, with or
without it.

Helper endpoints (useful for debugging):

```
GET /health                  status + last snapshot age
GET /live?interval=3         open/refresh the workbook, set the timer (minutes)
GET /download                download a fresh .xlsx
GET /stop                    stop the background fetcher
```

---

## 🖥️ Command line (optional — you never need this)

Run from the repository root:

```bash
python excel/excel_auto.py                 # fetch + write + open          (default)
python excel/excel_auto.py --live          # workbook that refreshes itself
python excel/excel_auto.py --watch         # headless rewrite (no Excel automation)

python excel/excel_auto.py --interval 30           # seconds between refreshes (min 15)
python excel/excel_auto.py --symbol BANKNIFTY      # different index
python excel/excel_auto.py --symbol RELIANCE --kind Equity
python excel/excel_auto.py --expiry 03-Nov-2026    # pin an expiry (default: nearest)
python excel/excel_auto.py --out D:\nse            # other output folder
python excel/excel_auto.py --no-open               # just write the file
python excel/excel_auto.py --stop                  # stop the hidden updater
```

`--watch` is the fallback when `pywin32` is unavailable: it rewrites the
workbook on a timer (use it with the file **closed**, or use `--live`).

---

## 📦 Install

```bash
pip install -r excel/requirements-excel.txt      # requirements.txt + pywin32
```

`pywin32` is only needed for `--live`; everything else works with the normal
`requirements.txt`. Windows only for `--live` (it drives Excel itself) —
`--once` / `--watch` are cross-platform.

---

## ℹ️ Why not just "Data → From Web" in Excel?

Because you asked not to configure it every time. Excel's *From Web* box needs
you to paste a URL, then walk through a Power Query editor to expand the JSON,
then repeat it whenever the file is replaced — and that UI has no scripting
hook, so it cannot be pre-wired for you on a click.

The connection this feature installs is the same Excel engine (a real data
connection with *Refresh All* / timed refresh stored inside the `.xlsx`), just
attached programmatically and pointed at a file whose contents are kept fresh
for you. Result: zero setup, no macros, and the sheet genuinely refreshes
itself.

---

## 🧰 Troubleshooting

| Symptom | Fix |
|---|---|
| `pywin32 not installed` | `pip install -r excel/requirements-excel.txt`, run `excel_live.bat` again |
| `COM setup failed` / Excel not found | Install Microsoft Excel (2016 or newer). `excel_now.bat` still works |
| File locked / "being used by another process" | Close that workbook — or use `excel_live.bat`, which updates the open sheet |
| Sheet stopped updating | The workbook was closed (that also stops the helper). Run `excel_live.bat` again — it reuses the same files |
| Helper process left behind | `python excel/excel_auto.py --stop` |
| Web panel says "helper is not running" (only the optional local helper) | Start `excel/excel_server.bat` and keep it open; it binds 127.0.0.1:8765. The dashboard's **Export Excel** panel does not need it |
| `could not fetch from NSE` | NSE rate-limiting or a blocked session. The script retries 3× with a fresh session; wait a minute and re-run |
| Data looks stale | Check `UPDATED (IST)` in column X. If it doesn't move, re-run `excel_live.bat` |
| Expiry rolls over (weekly) | Nothing to do — the data keeps flowing and the `EXPIRY` cell shows the new date; only the file *name* keeps the old label |

---

## 🧭 Files in this folder

```
excel_auto.py            # fetch -> CSV/XLSX, live workbook, hidden updater
excel_server.py          # optional local helper for the Excel automation
excel_now.bat            # one-click export
excel_live.bat           # one-click auto-refresh
excel_server.bat         # start the optional helper
requirements-excel.txt   # requirements.txt + pywin32
README.md                # this file
```

Also read: [`../dashboard/README.md`](../dashboard/README.md) ·
[`../worker/README.md`](../worker/README.md) ·
[`../web/`](../web) · [`../README.md`](../README.md)
