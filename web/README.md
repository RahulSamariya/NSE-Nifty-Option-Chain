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
- **Refresh Data / Download Excel:** above the chain, next to the strike filter.
  *Refresh Data* re-reads the newest stored snapshot; *Download Excel* saves
  every strike of the current symbol + expiry as a three-sheet workbook.
- **Live Excel panel:** the **Live Excel** button in the header opens the local
  Excel helper, which can open the self-refreshing workbook or download a
  formatted `.xlsx`, and lets you change how often NSE is polled. See
  [`../excel/README.md`](../excel/README.md).

Data refreshes every 30 seconds while the tab is open. A failed query keeps the
last good snapshot on screen and shows the error instead of inventing data.

### Freshness

The badge is driven by the **NSE source timestamp**, never by when the row was
written:

| Badge | Meaning |
| --- | --- |
| **Live** | Market open, snapshot from today and at most 5 minutes old. |
| **Last Close** | Market closed and this is the last session's snapshot (up to 96 h, so Friday's 15:40 close still counts on Sunday). |
| **Stale** | A session is open but this data is not today's, it is too old, or its timestamp is impossible / outside 09:15–15:30 IST. |
| **Unavailable** | The source timestamp is missing or unparseable. |

A snapshot stamped 15:40 is valid: NSE pauses, then stamps the closing snapshot
after the 15:30 bell. The window therefore accepts stamps up to 15:45.

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

The API routes run on the server and read the same values from
`SUPABASE_URL` / `SUPABASE_ANON_KEY` (or the `NEXT_PUBLIC_*` fallbacks above).
They are never exposed to the browser and the service-role key is never used.

Apply [`../db/schema.sql`](../db/schema.sql) once (or
[`../db/supabase_security_migration.sql`](../db/supabase_security_migration.sql)
on an existing project), then start the worker so the tables have data:

```bash
python worker/bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30
```

Or just double-click `run_web.bat` in the repository root after the worker is
running.

## Snapshot API (read-only)

Both endpoints read the newest row in `option_chain_live`. They never write and
never call NSE.

| Endpoint | Returns |
| --- | --- |
| `GET /api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=json` | `{ meta, fields, chain }` — the complete chain |
| `GET /api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=csv` | flat CSV, metadata repeated per row |
| `GET /api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026` | `.xlsx` attachment (Summary / Option Chain / Raw Data) |

- `symbol` is required (letters, digits, `& . _ -`).
- `expiry` is optional; omit it for the newest snapshot of that symbol. It must
  be a real date in `27-Oct-2026` form — `7-Oct-2026` and `07-Oct-2026` are both
  accepted.
- `format` is `json` (default) or `csv`.

`meta` contains the honest source fields: `nse_timestamp`, `snapshot_updated_at`,
`generated_at`, `status`, `market_open`, `status_reason`, `age_seconds`,
`strike_count`. The same status is also sent as the `X-Snapshot-Status` header.
Responses are `Cache-Control: no-store`.

| Status | When |
| --- | --- |
| `200` | Snapshot found and usable. |
| `400` | Missing/invalid `symbol`, `expiry` or `format`. |
| `404` | No stored snapshot for that symbol/expiry. |
| `502` | Supabase unreachable, or the stored row is not a usable snapshot. The body is generic; the real error is logged server-side. |
| `503` | Server has no read credentials configured. |

A `Stale` snapshot still returns `200` with `status: "Stale"` — a stale row is
data, not an error. The client decides whether to warn.

## Excel export

**Download Excel** builds the workbook on the server with ExcelJS and returns a
real `.xlsx`:

1. **Summary** — symbol, expiry, spot, PCR, max pain, total OI, strike count, NSE
   source timestamp, snapshot status, workbook build time, and the CSV endpoint
   for Power Query.
2. **Option Chain** — every strike in the snapshot (not the visible ATM window),
   NSE column order for CE and PE, frozen header + strike column, filters,
   number formats, and green/red conditional formatting on signed changes.
3. **Raw Data** — one row per strike with metadata columns plus the original
   `raw_row_json`, for auditing and downstream tooling.

The file is a snapshot: it does not refresh itself. For an in-place refreshing
workbook, connect Excel to the CSV/JSON endpoint with Power Query — exact M code,
parameters and Refresh All steps are in
[`../docs/EXCEL_POWER_QUERY.md`](../docs/EXCEL_POWER_QUERY.md).

## Live Excel helper

The browser cannot start Excel, so the **Live Excel** panel talks to
`http://127.0.0.1:8765`, served by `excel/excel_server.py`:

```bash
python excel/excel_server.py        # or double-click excel/excel_server.bat
```

That helper fetches NSE directly on your machine and is separate from the
snapshot download above. If it is not running, the rest of the dashboard works
normally — only the panel shows setup instructions.

## Checks

```bash
npm run lint
npm test          # vitest: freshness rules, CSV, validation, workbook, API routes
npm run build
```

## Deploy (Vercel)

Set the two `NEXT_PUBLIC_*` variables in the Vercel project settings, plus
`SUPABASE_URL` / `SUPABASE_ANON_KEY` (same anon key) so the API routes can read
the snapshot server-side. The dashboard and API are read-only; the Python worker
keeps running on your own machine (NSE blocks cloud IPs).

> The **Live Excel** panel only works when the helper is running on the same
> computer as the browser. On a phone or on the deployed site it will simply show
> "helper is not running". **Download Excel** works anywhere, because it is
> generated by the server.

## Structure

```
src/app/page.tsx                 # dashboard state, polling, refresh + export actions
src/app/api/option-chain/route.ts        # JSON / CSV snapshot API
src/app/api/option-chain/export/route.ts # .xlsx download
src/app/layout.tsx               # fonts + global shell
src/components/Header.tsx        # symbol pills, status, Live Excel + refresh buttons
src/components/MetricsBar.tsx    # spot, PCR, Max Pain, OI
src/components/OptionChainTable.tsx
src/components/ChartsView.tsx
src/components/ExcelPanel.tsx    # local Excel helper UI + refresh timer
src/lib/market-status.ts         # freshness rules (shared by UI and API)
src/lib/option-chain-record.ts   # row validation + normalization
src/lib/option-chain-fields.ts   # shared CE/PE column schema
src/lib/option-chain-csv.ts      # CSV serialization
src/lib/api-validation.ts        # query validation
src/lib/option-chain-server.ts   # server-side snapshot read
src/lib/excel-export.ts          # three-sheet workbook builder
src/lib/supabase.ts              # browser client + re-exports
src/types/option-chain.ts
tests/                           # vitest suites
```

Also read: [`../README.md`](../README.md) · [`../worker/README.md`](../worker/README.md) ·
[`../docs/EXCEL_POWER_QUERY.md`](../docs/EXCEL_POWER_QUERY.md)
