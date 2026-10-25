# 🌐 NSE Option Chain web app (`web/`)

A Next.js 16 dashboard for the option chain data that
[`../worker/bridge_worker.py`](../worker/bridge_worker.py) pushes to Supabase.
It runs in the browser, on a phone, or on Vercel — no Python needed to view it.

## What it shows

- **Header:** symbol pills (NIFTY / BANKNIFTY / FINNIFTY), expiry, NSE source
  timestamp, freshness badge (**Live** / **Last Close** / **Stale** /
  **Unavailable**) and a manual refresh.
- **Metrics:** spot, PCR, Max Pain, total Call/Put OI.
- **Option chain table:** NSE-style CALLS | STRIKE | PUTS layout, ATM-centred
  strike range, ITM shading, Indian number grouping.
- **Charts:** OI by strike, OI change, volume, IV smile, premium curve and
  intraday spot/PCR history (Recharts).
- **Excel panel:** the **Excel** button in the header opens the local Excel
  helper, which can open the self-refreshing workbook or download a formatted
  `.xlsx`, and lets you change how often NSE is polled. See
  [`../excel/README.md`](../excel/README.md).

Data refreshes every 30 seconds while the tab is open. A failed query keeps the
last good snapshot on screen and shows the error instead of inventing data.

## Setup

```bash
cd web
npm install
cp .env.example .env.local        # then fill in the two values
npm run dev                       # http://localhost:3000
```

`.env.local`:

```ini
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
```

Only the **anon** key belongs here — it can read. Writes are done exclusively by
the Python worker with the `service_role` key. If the page says *Supabase is not
configured*, these two variables are missing.

Apply [`../db/schema.sql`](../db/schema.sql) once (or
[`../db/supabase_security_migration.sql`](../db/supabase_security_migration.sql)
on an existing project), then start the worker so the tables have data:

```bash
python worker/bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30
```

Or just double-click `run_web.bat` in the repository root after the worker is
running.

## Excel button

The browser cannot start Excel, so the panel talks to
`http://127.0.0.1:8765`, served by `excel/excel_server.py`:

```bash
python excel/excel_server.py        # or double-click excel/excel_server.bat
```

If the helper is not running, the rest of the dashboard works normally — only
the Excel panel shows setup instructions.

## Checks

```bash
npm run lint
npm run build
```

## Deploy (Vercel)

Set the same two `NEXT_PUBLIC_*` variables in the Vercel project settings. The
app is a static client-side dashboard: it reads Supabase directly with the anon
key, so nothing else has to be configured. The Python worker keeps running on
your own machine (NSE blocks cloud IPs).

> The Excel panel only works when the helper is running on the same computer as
> the browser. On a phone or on the deployed site it will simply show
> "helper is not running".

## Structure

```
src/app/page.tsx              # dashboard state, polling, banners, Excel modal
src/app/layout.tsx            # fonts + global shell
src/components/Header.tsx     # symbol pills, status, Excel + refresh buttons
src/components/MetricsBar.tsx # spot, PCR, Max Pain, OI
src/components/OptionChainTable.tsx
src/components/ChartsView.tsx
src/components/ExcelPanel.tsx # local Excel helper UI + refresh timer
src/lib/supabase.ts           # client, row validation, snapshot freshness
src/types/option-chain.ts
```

Also read: [`../README.md`](../README.md) · [`../worker/README.md`](../worker/README.md)
