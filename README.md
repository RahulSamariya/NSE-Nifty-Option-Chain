# NSE Option Chain Dashboard

A real-time NSE (National Stock Exchange of India) Option Chain viewer with
interactive charts, analytics, and data logging.

## Features

- **Live Option Chain** — Fetches real-time data from NSE for NIFTY, BANKNIFTY,
  FINNIFTY, MIDCPNIFTY, NIFTYNXT50, and individual equities
- **NSE Website Format** — Faithful reproduction of the official NSE option chain
  layout with Indian number formatting, ITM shading, and ATM highlighting
- **Interactive Charts** — Open Interest, Change in OI, Volume, IV Smile, and
  Option Price charts powered by Plotly
- **Analytics** — Put-Call Ratio (PCR), Max Pain strike, and OI summaries
- **Intraday History** — Record snapshots to SQLite and replay them with
  Spot vs PCR and per-strike charts
- **Excel Export** — Download data in NSE format or as raw numbers
- **Multi-device** — Access from any device on the same Wi-Fi network

## Quick Start (Windows)

1. Copy this whole folder to your PC
2. Double-click **setup.bat** (installs Python 3.13 if missing, then the packages)
3. Double-click **run.bat** (opens http://localhost:8501)

**Other devices on the same Wi-Fi:** use `run_network.bat`, then open
`http://<this-PC-IP>:8501` on your phone/laptop.

## Data Collection

- **Interactive logging:** Enable "Log snapshots" in the sidebar with Auto-refresh
- **Headless collector:** Run `collect.bat` (or `python collector.py`) in the
  background during market hours

## Project Structure

```
app.py           — Streamlit dashboard (UI layer)
nse_core.py      — Shared backend: NSE client, parsing, analytics, SQLite
charts.py        — Plotly chart builders
collector.py     — Headless background data collector
setup.bat        — One-time setup script
run.bat          — Launch the dashboard locally
run_network.bat  — Launch accessible on local network
collect.bat      — Start the headless collector
requirements.txt — Python dependencies
```

## Requirements

- Python 3.10+
- See `requirements.txt` for packages

## Notes

- Live data only available Mon–Fri 9:15–15:30 IST; otherwise shows last close
- Settings → "Save as default settings" writes `config.json` (portable)
- For personal / learning use. Respect NSE's terms of use.
