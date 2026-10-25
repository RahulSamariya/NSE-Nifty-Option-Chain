# 📊 NSE Option Chain — three tools, one repository

Live option-chain data from the **National Stock Exchange of India (NSE)**,
delivered three ways. Each one is self-contained and can be used on its own;
they share a single scraper/parser so the numbers always agree.

| # | Tool | Folder | What it is | Best for |
|---|---|---|---|---|
| 1 | **Streamlit dashboard** | [`dashboard/`](dashboard/) | Local Python app with the option chain table, Plotly charts, Max Pain / PCR and SQLite history | Research on your own PC |
| 2 | **Web app** | [`web/`](web/) | Next.js 16 + Supabase dashboard you can open from any device | Phone / cloud access |
| 3 | **Excel automation** | [`excel/`](excel/) | One click → a formatted `.xlsx`, or a workbook that refreshes itself every minute | Spreadsheet work |

```
dashboard/  →  reads NSE directly, writes SQLite + history/       (local only)
worker/     →  reads NSE, validates, writes Supabase  ──►  web/   (cloud)
excel/      →  reads NSE, writes CSV/XLSX; optional local helper  (Windows + Excel)
core/       →  shared: session warming, parsing, analytics, SQLite
```

---

## 🚀 Quick start

```bash
git clone https://github.com/RahulSamariya/NSE-Nifty-Option-Chain.git
cd NSE-Nifty-Option-Chain
pip install -r requirements.txt        # or double-click setup.bat
```

### 1. Streamlit dashboard (local)

```bash
streamlit run dashboard/app.py         # http://localhost:8501
```

or double-click **`dashboard/run.bat`**. For phone/Wi-Fi access use
**`dashboard/run_network.bat`**. Headless logging:
`python dashboard/collector.py --symbol NIFTY --interval 60`.

→ Full details: [`dashboard/README.md`](dashboard/README.md)

### 2. Web app (cloud / phone)

```bash
# terminal 1 - push snapshots to Supabase
python worker/bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30

# terminal 2 - Next.js frontend
cd web
npm install
npm run dev                            # http://localhost:3000
```

The collector needs `SUPABASE_URL` and `SUPABASE_KEY` (**service_role**) in its
environment, or in a `.env` in the **repository root** on a development machine:

```ini
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_KEY=<service_role key>
```

For a scheduler, run one cycle at a time instead of the 24/7 daemon:

```bash
python worker/bridge_worker.py --once --symbol NIFTY BANKNIFTY
```

Then apply [`db/schema.sql`](db/schema.sql) to a new Supabase project (or
[`db/supabase_security_migration.sql`](db/supabase_security_migration.sql) for an
existing one). Anonymous users can read; only `service_role` can write.

The web app reads its own hosted API, so it only needs the **anon** key
(`SUPABASE_URL` + `SUPABASE_ANON_KEY`) in the server environment. The **Export
Excel** panel offers symbol, expiry, strike range, import fields, refresh now,
auto-refresh intervals and a real `.xlsx` download — no local helper required.
See [`docs/HOSTED_DEPLOYMENT.md`](docs/HOSTED_DEPLOYMENT.md) for deploying the
collector and verifying it with `/api/health`.

→ Full details: [`worker/README.md`](worker/README.md) · [`web/README.md`](web/README.md)

### 3. Excel

| What you want | Double-click |
|---|---|
| A formatted workbook right now | `excel/excel_now.bat` |
| A sheet that keeps updating itself | `excel/excel_live.bat` |
| The web app's Excel button | `excel/excel_server.bat` |

Defaults are baked in: **NIFTY → nearest expiry → full chain**. Output goes to
`excel/excel_output/` (git-ignored). `pywin32` is only needed for the live mode:

```bash
pip install -r excel/requirements-excel.txt
```

The local helper is optional/legacy. It listens on `http://127.0.0.1:8765` only,
and the dashboard no longer depends on it: Excel downloads come from the hosted
API and never show a "helper is not running" modal. Developers who want to drive
the local Excel automation from the panel can still start it with
`excel/excel_server.bat`.

→ Full details: [`excel/README.md`](excel/README.md)

### 4. Excel export panel + refreshable workbook

The **Export Excel** panel picks symbol, expiry, strike range (all / 10 / 20 / 30
around ATM) and import fields, then builds the workbook straight from the stored
Supabase snapshot — no NSE call from the browser:

- **Download Excel** (above the option chain) → `.xlsx` with **Summary**,
  **Option Chain** and **Raw Data** sheets.
- `GET /api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=json|csv` → the
  same data as JSON or CSV, with the real NSE source timestamp and freshness.
- `GET /api/option-chain/expiries?symbol=NIFTY` → the expiries that actually
  exist, newest first.
- `GET /api/option-chain/history?symbol=NIFTY&expiry=27-Oct-2026&limit=60` →
  intraday history points.
- `GET /api/health` → stored rows, write age and per-symbol freshness, for
  verifying the hosted collector.
- `range=all|10|20|30` and `fields=oi,oi_change,volume,iv,ltp,price_change,bid_ask`
  narrow the JSON/CSV/workbook view; `Raw Data` in the workbook always keeps every
  strike and every field.
- `GET /api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026` → the workbook.

The downloaded file is a point-in-time snapshot. To refresh Excel in place,
connect it to the CSV/JSON endpoint with Power Query — copy-paste M code and
Refresh All steps: [`docs/EXCEL_POWER_QUERY.md`](docs/EXCEL_POWER_QUERY.md).

Refreshing re-reads Supabase; it does not contact NSE. Only the collector
(`worker/bridge_worker.py`) does that. Deployment, scheduling and verification
steps: [`docs/HOSTED_DEPLOYMENT.md`](docs/HOSTED_DEPLOYMENT.md).

---

## 📁 Repository layout

```
├── core/
│   └── nse_core.py                 # session warming, parser, analytics, SQLite
├── dashboard/                      # tool 1 - Streamlit
│   ├── app.py                      #   UI layer
│   ├── charts.py                   #   Plotly figure builders
│   ├── collector.py                #   headless SQLite logger
│   ├── run.bat  run_network.bat  collect.bat
│   └── README.md
├── worker/                         # tool 2 - NSE -> Supabase
│   ├── bridge_worker.py
│   ├── run_bridge.bat
│   └── README.md
├── web/                            # tool 2 - Next.js frontend (Vercel-ready)
├── excel/                          # tool 3 - Excel automation
│   ├── excel_auto.py               #   fetch -> CSV/XLSX, live workbook, poller
│   ├── excel_server.py             #   optional local helper (not used by the panel)
│   ├── excel_now.bat  excel_live.bat  excel_server.bat
│   ├── requirements-excel.txt
│   └── README.md
├── db/
│   ├── schema.sql                  # fresh Supabase setup
│   └── supabase_security_migration.sql
├── docs/
│   └── EXCEL_POWER_QUERY.md        # refreshable Excel / Power Query guide
├── tests/
│   └── test_nse_reliability.py     # offline parser/worker tests
├── requirements.txt                # Python deps for dashboard + worker
├── setup.bat                       # installs requirements.txt
├── run_web.bat                     # starts the Next.js dev server
├── push_to_github.bat              # push this branch to GitHub
└── .env.example                    # worker credentials template
```

Generated at runtime (git-ignored): `nse_history.db`, `config.json`,
`history/`, `excel/excel_output/`, `__pycache__/`.

---

## 🧪 Tests

The parser/worker suite is offline — no NSE or Supabase calls:

```bash
python -m unittest tests.test_nse_reliability
```

Frontend checks:

```bash
cd web
npm run lint
npm test          # vitest: freshness, CSV, validation, workbook, API statuses
npm run build
```

---

## ⚙️ How NSE is handled

NSE blocks plain automated requests. `core/nse_core.py` warms a session (NSE
homepage + option chain referer) to collect `bm_sv`, `nsit` and `ak_bmsc`
cookies, retries on 401/403 with a fresh session, and parses with IST-aware
timestamps. The worker refuses snapshots whose source timestamp is older than
300 s.

- **Config:** click **"Save as default settings"** in the Streamlit app to write
  `config.json` at the repository root.
- **Supabase:** anonymous clients can read; writes require the `service_role`
  key and happen only in `worker/bridge_worker.py`.

---

## ⚖️ Disclaimer

- Strictly for **educational and personal research**.
- Derivatives trading carries significant financial risk. Max Pain, PCR and IV
  are theoretical calculations — not investment advice.
- Respect NSE's Terms of Service; avoid polling faster than 15–30 seconds.

---

<p align="center">
  Developed by <b><a href="https://github.com/RahulSamariya">Rahul Samariya</a></b>
</p>
