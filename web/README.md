# NSE Option Chain web app (`web/`)

A Next.js 16 dashboard for the option chain data that
[`../worker/bridge_worker.py`](../worker/bridge_worker.py) pushes to Supabase. It
runs in the browser, on a phone, or on Vercel — no Python needed to view it or to
download Excel.

The dashboard reads the **hosted read-only API** in this app (`/api/option-chain*`).
The browser never holds a Supabase key; the server routes use the anon key and
RLS keeps them read-only.

## What it shows

- **Header:** symbol pills (NIFTY / BANKNIFTY / FINNIFTY), the snapshot expiry,
  the NSE source timestamp, a freshness badge (**Live** / **Last Close** /
  **Stale** / **Unavailable** / **Error**) and a manual refresh.
- **Metrics:** spot, PCR, Max Pain, total Call/Put OI.
- **Option chain table:** NSE-style CALLS | STRIKE | PUTS layout, ATM-centred
  strike range, ITM shading, Indian number grouping.
- **Charts:** OI by strike, OI change, volume, IV smile, premium curve and
  intraday spot/PCR history (Recharts), read from `/api/option-chain/history`.
- **Excel export panel (`Export Excel`):** symbol, expiry list populated from
  real stored data, strike range (`all` / 10 / 20 / 30 around ATM), import fields
  (OI, change in OI, volume, IV, LTP, price change, bid/ask), **Refresh Now**,
  auto-refresh on/off, 1 / 5 / 15 / 30 minute intervals, and **Download Excel**.
  Everything in the panel runs against the deployed API — there is no localhost
  helper in the normal flow.

The panel and the main toolbar share one state, so what you see in the table and
what the workbook contains cannot drift apart.

### Refresh behaviour

- The dashboard re-queries the hosted API; it never calls NSE.
- Auto-refresh is browser polling only, every 1/5/15/30 minutes. It pauses while
  the tab is hidden and catches up when you return. Changing the interval
  restarts it cleanly.
- **Refresh Now**, the header refresh button and the timer share an
  `AbortController` plus a no-overlap guard: a slow request is cancelled by a
  newer one, and the same symbol/expiry is never fetched twice concurrently.
- A failed request keeps the last good snapshot on screen and shows the error; no
  values are invented.

### Freshness

The badge is driven by the **NSE source timestamp**, never by when the row was
written:

| Badge | Meaning |
| --- | --- |
| **Live** | Market open, snapshot from today and at most 5 minutes old. |
| **Last Close** | Market closed and this is the last session's snapshot (up to 96 h, so Friday's 15:40 close still counts on Sunday). |
| **Stale** | A session is open but this data is not today's, it is too old, or its timestamp is impossible / outside 09:15–15:30 IST. |
| **Unavailable** | The source timestamp is missing or unparseable. |
| **Error** | The API request itself failed (network, 5xx). The last good snapshot, if any, stays visible with its own timestamp. |

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
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon public key>
# NEXT_PUBLIC_* equivalents still work as fallbacks
```

Only the **anon** key belongs anywhere near the web app — it can read. Writes are
done exclusively by the Python collector with the `service_role` key. If the page
says the API is not configured, these values are missing from the server
environment.

Apply [`../db/schema.sql`](../db/schema.sql) once (or
[`../db/supabase_security_migration.sql`](../db/supabase_security_migration.sql)
on an existing project), then run the collector so the tables have data:

```bash
python worker/bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30
# or a single cycle, for a scheduler:
python worker/bridge_worker.py --once --symbol NIFTY BANKNIFTY
```

Or just double-click `run_web.bat` in the repository root after the collector is
running.

## Snapshot API (read-only)

All routes are `GET` (plus `OPTIONS` for CORS), never write, and never call NSE.
Responses are `Cache-Control: no-store` and include the honest source fields.

| Endpoint | Returns |
| --- | --- |
| `GET /api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=json` | `{ meta, fields, chain }` |
| `GET /api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=csv` | flat CSV, metadata repeated per row |
| `GET /api/option-chain/expiries?symbol=NIFTY` | expiries that actually exist, newest first |
| `GET /api/option-chain/history?symbol=NIFTY&expiry=27-Oct-2026&limit=60` | intraday history points, oldest first |
| `GET /api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026` | `.xlsx` attachment (Summary / Option Chain / Raw Data) |
| `GET /api/health` | deployment evidence: stored rows, write age, per-symbol freshness |

### Query parameters

- `symbol` (required): letters, digits, `& . _ -`, e.g. `NIFTY`.
- `expiry` (optional on `/api/option-chain` and `/export`): a real date in
  `27-Oct-2026` form; `7-Oct-2026` and `07-Oct-2026` are both accepted. Omit it
  for the newest snapshot of that symbol. Required on `/history`.
- `format`: `json` (default) or `csv`.
- `range` (optional): `all` (default), `10`, `20`, `30` — keeps that many strikes
  either side of the ATM strike, clamped at the ends of the chain.
- `fields` (optional): `all` (default) or a comma list of `oi, oi_change, volume,
  iv, ltp, price_change, bid_ask`. `STRIKE` is always included.
- `limit` (history only): 1–240, default 60.

`meta` contains `symbol`, `expiry`, `spot`, `pcr`, `max_pain`, `total_ce_oi`,
`total_pe_oi`, `nse_timestamp`, `snapshot_updated_at`, `generated_at`, `status`,
`market_open`, `status_reason`, `age_seconds`, `strike_count`, plus
`strike_range`, `strike_range_label`, `field_groups`, `fields_label` and
`strikes_returned`. `X-Snapshot-Status`, `X-Nse-Source-Timestamp`,
`X-Strike-Range`, `X-Strike-Count` and `X-Strike-Total` mirror the important ones
as headers.

| Status | When |
| --- | --- |
| `200` | Snapshot found and usable. |
| `400` | Missing/invalid `symbol`, `expiry`, `format`, `range`, `fields` or `limit`. |
| `404` | No stored snapshot/expiry for that symbol. |
| `413` | Stored snapshot exceeds the size guard (5,000 strikes JSON/CSV, 2,000 workbook). |
| `429` | Per-instance rate limit hit (`Retry-After` is set). |
| `502` | Supabase unreachable, or the stored row is not a usable snapshot. The body is generic; the real error is logged server-side. |
| `503` | Server has no read credentials configured. |

A `Stale` snapshot still returns `200` with `status: "Stale"` — a stale row is
data, not an error. The client decides whether to warn.

## Excel export

**Download Excel** builds the workbook on the server with ExcelJS and returns a
real `.xlsx`:

1. **Summary** — symbol, expiry, spot, PCR, max pain, total OI, chosen strike
   range and import fields, strikes exported, strikes in raw data, NSE source
   timestamp, snapshot status, workbook build time, and the CSV endpoint for
   Power Query.
2. **Option Chain** — the requested strike window and field columns in NSE order,
   frozen header + strike column, filters, number formats, and green/red
   conditional formatting on signed changes.
3. **Raw Data** — every strike in the snapshot with metadata columns plus the
   original `raw_row_json`, so narrowing the view never loses data.

The file is a snapshot: it does not refresh itself. For an in-place refreshing
workbook, connect Excel to the CSV/JSON endpoint with Power Query — exact M code,
parameters and Refresh All steps are in
[`../docs/EXCEL_POWER_QUERY.md`](../docs/EXCEL_POWER_QUERY.md).

## Local helper (optional, legacy)

The older `excel/excel_server.py` helper still exists for developers who want to
drive the local Excel automation from the panel. It listens on
`http://127.0.0.1:8765` and is **not used by the dashboard**:

```bash
python excel/excel_server.py        # or double-click excel/excel_server.bat
```

Nothing in the deployed flow depends on it. If it is not running, no modal
appears; Excel downloads are served by `/api/option-chain/export`.

## Checks

```bash
npm run lint
npm test          # vitest: freshness, selection, rate limits, CSV, workbook, API routes
npm run build
```

## Deploy

Set `SUPABASE_URL` + `SUPABASE_ANON_KEY` in the hosting environment (Vercel:
Project → Settings → Environment Variables; Root Directory `web`). The dashboard
and API are read-only; the collector keeps running on a machine that NSE serves
(NSE commonly blocks cloud IPs).

Full instructions — env vars, systemd/Task Scheduler/Docker collectors, holiday
calendar, `/api/health` verification and the security model — are in
[`../docs/HOSTED_DEPLOYMENT.md`](../docs/HOSTED_DEPLOYMENT.md).

## Structure

```
src/app/page.tsx                          # dashboard state, polling, refresh + export
src/app/api/option-chain/route.ts         # JSON / CSV snapshot API
src/app/api/option-chain/export/route.ts  # .xlsx download
src/app/api/option-chain/expiries/route.ts# real expiries for the selector
src/app/api/option-chain/history/route.ts # intraday history for the charts
src/app/api/health/route.ts               # collector/deployment evidence
src/app/layout.tsx                        # fonts + global shell
src/components/Header.tsx                 # symbol pills, status, refresh
src/components/MetricsBar.tsx             # spot, PCR, Max Pain, OI
src/components/OptionChainTable.tsx
src/components/ChartsView.tsx
src/components/ExcelPanel.tsx             # hosted Excel control panel
src/lib/market-status.ts                  # freshness rules (shared by UI and API)
src/lib/chain-selection.ts                # strike ranges + import-field groups
src/lib/rate-limit.ts                     # per-instance read/export limiter
src/lib/api-response.ts                   # CORS, error bodies, 429
src/lib/option-chain-record.ts            # row validation + normalization
src/lib/option-chain-fields.ts            # shared CE/PE column schema
src/lib/option-chain-csv.ts               # CSV serialization
src/lib/api-validation.ts                 # query validation
src/lib/api-types.ts                      # wire types shared by UI and routes
src/lib/option-chain-server.ts            # server-side snapshot/expiry/history reads
src/lib/excel-export.ts                   # three-sheet workbook builder
src/lib/supabase.ts                       # formatIndian + type re-exports (no client)
src/types/option-chain.ts
tests/                                    # vitest suites
```

Also read: [`../README.md`](../README.md) ·
[`../worker/README.md`](../worker/README.md) ·
[`../docs/EXCEL_POWER_QUERY.md`](../docs/EXCEL_POWER_QUERY.md) ·
[`../docs/HOSTED_DEPLOYMENT.md`](../docs/HOSTED_DEPLOYMENT.md)
