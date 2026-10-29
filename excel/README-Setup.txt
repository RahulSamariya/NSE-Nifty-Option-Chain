================================================================================
NSE Option Chain - Desktop Excel One-Click Setup Utility
================================================================================

This package automatically configures Microsoft Excel Desktop on Windows to
retrieve live option-chain data directly from our hosted API and refresh the
same workbook repeatedly.

Package Contents:
  - Setup-NSE-Excel.bat   : Double-click launcher to run setup
  - Setup-NSE-Excel.ps1   : PowerShell COM automation script
  - config.template.json  : Configuration settings template
  - config.json           : Active configuration (generated on web download)

Prerequisites:
  - Microsoft Windows 10 or 11
  - Microsoft Excel Desktop (2016, 2019, 2021, or Microsoft 365)
  - Active internet connection

First-Time Setup:
  1. If running from GitHub: copy config.template.json to config.json and set
     baseUrl to your hosted site (e.g. "https://your-hosted-domain.com").
     The downloaded website package already has this filled in.
  2. Double-click 'Setup-NSE-Excel.bat'.
  3. The setup engine will:
     - Detect your desktop Excel installation.
     - Provision a 4-sheet workbook: Summary, Option Chain, Raw Data, and Settings.
     - Create native Power Query connections to the hosted read-only API.
     - Enable 'Refresh on Open' and background refresh intervals.
     - Save the workbook to your Documents folder:
       Documents\NSE_Option_Chain_<Symbol>.xlsx
     - Open the configured workbook in Microsoft Excel.

Daily Use (Reusable Workbook):
  - Just open the saved workbook: it automatically refreshes on open.
  - While working: click 'Data > Refresh All' (or Ctrl+Alt+F5) to pull the newest snapshot.
  - To change settings: open the 'Settings' sheet, edit the Value cell (e.g. change
    Symbol from NIFTY to BANKNIFTY or FINNIFTY, or change Expiry), and click 'Refresh All'.
    The query automatically re-reads the settings and queries the API accordingly.
  - You never need to download another workbook or run setup again.

Security:
  - Standard .xlsx workbook (no macros or VBA).
  - Uses read-only public API endpoints with zero private credentials required.
================================================================================
