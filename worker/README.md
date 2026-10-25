# ☁️ Supabase bridge worker (`worker/`)

This is the **only** process that writes to Supabase. It scrapes NSE from a
residential IP, validates the payload and pushes it to the
`option_chain_live` / `option_chain_history` tables so the Next.js app in
[`../web/`](../web) can serve it from anywhere (eg. Vercel).

It reuses the same scraper/parser as the dashboard via `core/nse_core.py`.

---

## What it does

Every `--interval` seconds (30 by default):

1. Fetches the option chain for each `--symbol`.
2. Rejects the snapshot unless:
   - spot > 0,
   - all strikes and `raw_data` rows are present,
   - the NSE source timestamp is **less than 300 s old**.
3. Upserts the newest snapshot into `option_chain_live` (per symbol).
4. Appends a row to `option_chain_history`.
5. Prints success **only after** Supabase confirms the write; any API error is
   printed and the loop retries on the next tick.

By default it only runs on weekdays 09:15–15:35 IST, skipping dates listed in
[`../nse_holidays.txt`](../nse_holidays.txt). `--always` ignores market hours and
holidays (useful for testing). Windows sleep is suppressed while the daemon runs.

---

## Setup

1. **Environment** — create `.env` in the **repository root** (not in this
   folder). `worker/bridge_worker.py` and `setup` both look there:

   ```ini
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_KEY=<service_role key>
   ```

   See [`../.env.example`](../.env.example). Use the **service_role** key here.
   Never prefix it with `NEXT_PUBLIC_` — that would expose it in the browser.

2. **Dependencies**

   ```bash
   pip install -r requirements.txt
   ```

3. **Database** — apply [`../db/schema.sql`](../db/schema.sql) to a fresh
   project. For an existing project, run
   [`../db/supabase_security_migration.sql`](../db/supabase_security_migration.sql)
   instead: it revokes anonymous writes, keeps anonymous reads and grants writes
   to `service_role`.

---

## Run

```bash
python worker/bridge_worker.py
python worker/bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30 --always

# one cycle, for cron / systemd timer / Task Scheduler:
python worker/bridge_worker.py --once --symbol NIFTY BANKNIFTY FINNIFTY
```

or double-click **`worker/run_bridge.bat`**. Stop with **Ctrl+C**; it re-enables
normal sleep on exit.

`--once` respects market hours and the holiday calendar and exits:

| Code | Meaning |
| --- | --- |
| `0` | Cycle completed, or market closed/holiday (nothing to do). |
| `1` | At least one symbol failed; credentials missing. Previous snapshots are untouched. |
| `2` | Bad arguments, or a malformed `nse_holidays.txt` line. |

Use `--holidays <path>` to point at a different calendar file. Hosted options
(systemd timer, Windows Task Scheduler, Docker, `/api/health` verification) are
documented in [`../docs/HOSTED_DEPLOYMENT.md`](../docs/HOSTED_DEPLOYMENT.md).

The worker prints the symbol, spot and source timestamp on every successful
write, so a quiet console means it is not writing.

---

## Notes

- NSE occasionally rate-limits or invalidates cookies. The shared client warms a
  new session and retries before giving up on a tick.
- Data is written as JSONB (`raw_data`) plus pre-computed summary columns
  (`spot`, `pcr`, `max_pain`, total OI), so the frontend never has to recompute
  them.
- The worker and the dashboard can run at the same time; they only share
  `core/nse_core.py`. The dashboard never writes to Supabase.

---

## Files

```
bridge_worker.py   # the ingestion loop and --once cycle
run_bridge.bat     # Windows launcher
```

Also read: [`../web/README.md`](../web/README.md) ·
[`../docs/HOSTED_DEPLOYMENT.md`](../docs/HOSTED_DEPLOYMENT.md) ·
[`../db/schema.sql`](../db/schema.sql) · [`../README.md`](../README.md)
