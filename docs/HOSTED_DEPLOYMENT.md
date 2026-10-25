# Hosted deployment

This document covers the production shape of the project:

```
NSE  ──►  collector worker (Python, allow-listed IP)
              │  service_role key, write-only
              ▼
          Supabase (option_chain_live / option_chain_history, RLS: anon can read)
              ▲
              │  anon key, server-side only
          Next.js on Vercel  ──►  /api/option-chain, /export, /expiries, /history, /health
              ▲
              │  no credentials in the browser
          ordinary visitors  ──►  dashboard + Excel download
```

Visitors never contact NSE, never run Python, and never see a Supabase key. The
only NSE calls come from the collector, so a thousand visitors cost the exchange
exactly one poll every interval.

---

## 1. What must be deployed where

| Piece | Where it runs | Why |
| --- | --- | --- |
| `web/` (dashboard + API) | Vercel, or any Node host | Static UI plus server routes. Must be public HTTPS. |
| Supabase | Supabase project | Stores the last valid snapshot per symbol/expiry and the history points. |
| `worker/bridge_worker.py` | A machine that NSE accepts | NSE commonly rejects datacentre/cloud IP ranges and needs a warm browser-like session. A Vercel function is the wrong place; a home PC, office PC, Raspberry Pi or a residential/VPS host with an allow-listed IP is the right place. |

There is no serverless replacement for the collector in this repository. Do not
point the browser at NSE "just in case": that reintroduces per-visitor scraping,
CORS failures and rate-limit bans.

> **Verification honesty:** running the worker locally proves the code works, not
> that a hosted collector exists. Hosted liveness is proven by
> `GET /api/health` showing a small `worker.seconds_since_write` during market
> hours, from the deployed URL. See §6.

---

## 2. Environment variables

### `web/` (Vercel project settings → Environment Variables)

| Name | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project URL used by the server routes. |
| `SUPABASE_ANON_KEY` | yes | **Anon** key. Read-only thanks to RLS. |

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` still work as
fallbacks, so an existing deployment does not break. Prefer the non-public names:
the API reads them server-side and nothing needs to be inlined into the browser
bundle any more.

Never put `SUPABASE_KEY` (the service-role key) or `service_role`/`sb_secret_*`
values in the Vercel project. The API has no code path that can write.

### Collector (worker environment)

| Name | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Same project URL. |
| `SUPABASE_KEY` | yes | **service_role** key. Backend only. |

`worker/bridge_worker.py` reads real environment variables first, then falls back
to a `.env` in the repository root. On a hosted machine use the environment (or a
secrets file readable only by the service account), not a committed `.env`.

### Optional tuning

| Setting | Default | Notes |
| --- | --- | --- |
| `--symbol` | `NIFTY BANKNIFTY` | Add `FINNIFTY` if you want it collected. |
| `--interval` | `30` | Seconds between cycles in daemon mode. |
| `--holidays` | `nse_holidays.txt` | One `YYYY-MM-DD` per line; see §5. |
| `--always` | off | Ignores market hours and holidays. Testing only. |

---

## 3. Deploy the web app

```bash
cd web
npm ci
npm run lint
npm test
npm run build
```

On Vercel: import the repository, set **Root Directory** to `web`, add the two
environment variables, deploy. The first request to `/api/option-chain` will read
whatever the collector last wrote.

On a Node host (Docker, VM):

```bash
npm ci && npm run build
npm start            # listens on :3000 by default
```

Put it behind HTTPS; Power Query and mobile clients need a stable public origin.

Database: apply [`../db/schema.sql`](../db/schema.sql) once to a new project, or
[`../db/supabase_security_migration.sql`](../db/supabase_security_migration.sql)
on an existing one. Both keep anonymous access at `SELECT` and reserve writes for
`service_role`. This project does not require new migrations for the Excel
feature.

---

## 4. Run the collector as a hosted job

The collector has two modes:

- **Daemon** (`python worker/bridge_worker.py`): long-running loop; sleeps outside
  market hours; good for a PC or a VM service.
- **One-shot** (`--once`): one collection cycle, then exit. Good for schedulers.

`--once` exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Cycle completed, or market closed/holiday so nothing was collected. |
| `1` | A symbol failed (NSE error, stale timestamp, bad chain, DB refusal), or credentials are missing. The previous snapshot is untouched because rows are written only after validation. |
| `2` | Bad arguments, or the holiday calendar file is malformed. |

### 4a. systemd timer (Linux VM / Raspberry Pi)

`/etc/systemd/system/nse-collector.service`:

```ini
[Unit]
Description=NSE option-chain collector (single cycle)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=nse
WorkingDirectory=/opt/nse-option-chain
EnvironmentFile=/etc/nse-collector.env
ExecStart=/opt/nse-option-chain/.venv/bin/python worker/bridge_worker.py --once --symbol NIFTY BANKNIFTY FINNIFTY
```

`/etc/nse-collector.env` (root-owned, mode `600`):

```ini
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_KEY=<service_role key>
```

`/etc/systemd/system/nse-collector.timer`:

```ini
[Unit]
Description=Run the NSE collector every 2 minutes during the session

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nse-collector.timer
sudo journalctl -u nse-collector.service -f     # watch one cycle
```

The worker itself already refuses to run outside 09:15–15:35 IST on weekdays and
on listed holidays, so a 24/7 timer is safe — off-hours runs exit `0` without a
write. Tune the timer to your tolerance for stale data; 1–5 minutes is typical.

For long-running mode instead, use `Type=simple` with
`ExecStart=... bridge_worker.py --symbol ... --interval 30` and
`Restart=always`.

### 4b. Windows Task Scheduler (home PC)

1. Install Python and the requirements (`pip install -r requirements.txt`) into a
   dedicated folder, e.g. `C:\nse-option-chain`.
2. Create the task:
   - **Program/script:** `C:\nse-option-chain\.venv\Scripts\python.exe`
   - **Add arguments:** `worker\bridge_worker.py --once --symbol NIFTY BANKNIFTY FINNIFTY`
   - **Start in:** `C:\nse-option-chain`
   - **Trigger:** daily, repeat every 5 minutes, indefinitely.
   - **Settings:** "Run task as soon as possible after a scheduled start is
     missed", "Do not start a new instance" (prevents overlapping NSE calls),
     "Run whether user is logged on or not".
3. Set `SUPABASE_URL` / `SUPABASE_KEY` as machine environment variables (or a
   `.env` next to the repository that only that account can read).
4. Keep the PC awake during market hours; the daemon mode calls
   `SetThreadExecutionState`, one-shot runs do not.

Check *Last Run Result*: `0x0` means success; `0x1` means a failed cycle (open the
task history or run it manually to see the log line).

### 4c. Docker / any cron

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core worker nse_holidays.txt ./
ENTRYPOINT ["python", "worker/bridge_worker.py", "--once"]
```

Run it from cron every five minutes, injecting the two environment variables:

```cron
*/5 * * * * cd /opt/nse-option-chain && docker run --rm --env-file /etc/nse-collector.env nse-collector --symbol NIFTY BANKNIFTY
```

### 4d. GitHub Actions — read this first

A scheduled workflow is convenient, but Actions runners use cloud IP ranges that
NSE frequently blocks, and scheduled workflows can be delayed by many minutes.
If you try it, treat it as unverified until `/api/health` shows fresh writes.
A residential host is the reliable option.

### 4e. Overlap protection

Two collectors writing the same symbol is not destructive (the row is upserted
keyed by `symbol,expiry`), but it doubles NSE traffic for no benefit. Use a
locking scheduler (`systemd` timer with `AccuracySec`, Task Scheduler "do not
start a new instance", `--interval` above the expected cycle duration) and never
run `--once` more often than the source updates.

---

## 5. Market hours and holidays

`nse_core.market_open()` returns true only on Monday–Friday, 09:15–15:35 IST, and
not on a date listed in the holiday file. The worker logs the loaded calendar at
startup:

```
[*] Market calendar: Mon-Fri 09:15-15:35 IST; 12 holiday(s) from nse_holidays.txt
[*] Market calendar: Mon-Fri 09:15-15:35 IST; no holidays in nse_holidays.txt (weekdays only)
```

`nse_holidays.txt` is one ISO date per line; `#` starts a comment. Only add
verified dates from the official NSE holiday list — a wrong date silently skips a
real session. A malformed line stops the worker with exit code `2` rather than
being ignored. If the file is missing or empty, the worker still runs weekdays
only and says so, so an empty calendar is visible in the logs instead of silent.

---

## 6. Verify the deployment

### 6a. API is up and read-only

```bash
curl -s "https://<your-app>/api/option-chain/expiries?symbol=NIFTY"
curl -s "https://<your-app>/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=json" | head -c 400
curl -s -D - -o /dev/null "https://<your-app>/api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026"
```

Expect `200`, `Cache-Control: no-store`, an `X-Snapshot-Status` header, and a
`Content-Type` of `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
for the export. `400`/`404`/`413`/`429`/`502`/`503` all return the same JSON error
shape and never include credentials or raw database messages.

### 6b. The collector is writing

```bash
curl -s "https://<your-app>/api/health" | python -m json.tool
```

```json
{
  "status": "ok",
  "market_open": true,
  "database": { "reachable": true, "rows": 3 },
  "worker": {
    "state": "running",
    "last_write_at": "2026-10-23T09:58:12.441+00:00",
    "seconds_since_write": 76,
    "note": "Market is open: a healthy collector writes every few minutes."
  },
  "symbols": [
    {
      "symbol": "NIFTY",
      "expiry": "27-Oct-2026",
      "status": "Live",
      "source_age_seconds": 76,
      "write_age_seconds": 76
    }
  ]
}
```

How to read it:

| Field | Meaning |
| --- | --- |
| `worker.state` | `running` = a write landed within 10 minutes, `delayed` = within an hour, `stalled` = older, `never` = nothing stored. |
| `symbols[].status` | The same freshness rule as the dashboard (`Live`, `Last Close`, `Stale`, `Unavailable`). |
| `market_open` | IST session check in the web app (weekends excluded). Exchange holidays are enforced by the collector, which owns the holiday calendar. |

During a live session, `seconds_since_write` should stay near your timer interval.
A growing number while `market_open` is `true` is the definitive sign that the
hosted collector is not running. The health endpoint only proves what is stored;
it cannot prove which machine wrote it. Pair it with the scheduler's own log or
`journalctl` on the collector host.

### 6c. Browser flow

1. Open the deployed URL, pick a symbol, expiry, strike range and fields.
2. The chain updates without a full page reload; the freshness badge reflects the
   NSE timestamp, not the click time.
3. **Refresh Now** re-reads the hosted API; auto-refresh polls it every 1/5/15/30
   minutes and pauses in a hidden tab.
4. **Download Excel** returns a real `.xlsx` from
   `/api/option-chain/export` — verify it opens in Excel/LibreOffice and contains
   Summary / Option Chain / Raw Data.

No "Excel helper is not running" modal appears anywhere in this flow. The local
helper under `excel/` remains available for developers but is never required.

---

## 7. Security model

- **Keys:** the browser and the API only ever use the anon key, and the API reads
  it server-side. The service-role key exists only in the collector environment.
  No key is written into a workbook, a log line, or an API response.
- **RLS:** anonymous role gets `SELECT` on the snapshot tables and nothing else.
  See `db/schema.sql`. Do not weaken these policies to make a deployment work;
  if the API returns `502`/empty data, fix credentials, not policies.
- **Read-only routes:** `GET`/`OPTIONS` only; no body parsing, no writes.
- **Validation:** symbol whitelist pattern, real calendar dates for expiry,
  `range ∈ {all,10,20,30}`, `fields` from a fixed set, history `limit` 1–240.
- **Rate limiting:** per instance, keyed by `x-forwarded-for`/`x-real-ip`:
  - reads (chain, CSV, expiries, history, health): 120/minute
  - workbook export: 12/minute
  A multi-instance deployment counts per instance. If you need a hard global cap,
  put a shared limiter at the edge (Vercel WAF, Cloudflare, API gateway); the
  in-process limiter is a per-instance guard, not a billing shield.
- **Response-size guards:** more than 5,000 strikes in a snapshot → `413` for the
  JSON/CSV API; more than 2,000 → `413` for the workbook. Real NIFTY chains are
  well under both.
- **Error hygiene:** database error text is logged server-side and replaced with a
  generic message in the response.
- **CORS:** read endpoints send `Access-Control-Allow-Origin: *` so Power Query and
  third-party tools can use them. There is no credentialed CORS.
- **No mock data:** the API never synthesises values or expiries. Missing data is
  `404`; unusable data is `502`; unconfigured deployment is `503`.

---

## 8. Known limitations

- **Collector liveness is not self-proving.** `/api/health` reports freshness from
  stored rows. A stopped collector looks like increasing `seconds_since_write`.
  Alert on that during market hours.
- **NSE access:** the collector needs an IP NSE serves. Cloud runners (including
  most CI providers) are commonly blocked; this repository cannot change that.
- **Holiday calendar:** `nse_holidays.txt` ships empty (weekdays-only) because the
  official date list changes and guessing is worse than being explicit. Add the
  verified dates before relying on holiday detection.
- **Market-hours check:** the collector and the API use 09:15–15:35 IST windows
  for *polling* and 09:15–15:30 (with stamps valid to 15:45) for *freshness*.
  Special sessions (muhurat trading, budget-day timings) are not modelled.
- **History retention:** `option_chain_history` grows one row per five minutes per
  symbol. Prune old rows in Supabase (scheduled SQL) if you keep it indefinitely.
- **Rate limiting is per instance**, as described above.
- **Workbook is a snapshot.** Excel Power Query is the supported way to refresh in
  place; see [`EXCEL_POWER_QUERY.md`](EXCEL_POWER_QUERY.md).

---

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| Dashboard loads but says no snapshot | `/api/option-chain/expiries?symbol=NIFTY`; if `404`, the collector has never written for that symbol. |
| `503 not_configured` | `SUPABASE_URL` / `SUPABASE_ANON_KEY` missing from the web host. |
| `502 database_error` | Supabase unreachable, RLS/policy broken, or the anon key is wrong. The server log has the real message. |
| `429 rate_limited` | Too many requests from one IP; wait `Retry-After` seconds. Export allows 12/minute. |
| `413 snapshot_too_large` | A stored row has more strikes than the guard allows; inspect the collector output. |
| Health `state: "stalled"` during market hours | The collector host is down, offline, or NSE is rejecting it. Check its logs. |
| Health fine but a symbol is `Unavailable` | The collector writes a row with a missing/unparseable `nse_timestamp` — a parser regression, not normal. |
| Export downloads a file Excel cannot open | Check the `Content-Type`; if it is JSON, the API returned an error. The message is in the body. |
