import JSZip from "jszip";

export interface SetupPackageConfig {
  baseUrl: string;
  symbol: string;
  expiry: string | null;
  strikeRange: string;
  fields: string;
  refreshMinutes: number;
  autoRefresh: boolean;
  targetPath?: string;
}

/**
 * Configuration for the zero-cost local-CSV workbook setup.
 *
 * The path is never invented: it is asked for at first run (or supplied via
 * -CsvPath / config.json) and the script fails loudly when it is missing. This
 * is deliberately not the API package — there is no baseUrl and no localhost
 * fallback anywhere in it.
 */
export interface LocalCsvSetupConfig {
  symbol: string;
  expiry: string | null;
  refreshMinutes: number;
  autoRefresh: boolean;
  targetPath?: string;
  /** Pre-filled CSV path; when empty the script prompts for it at first run. */
  csvPath?: string;
}

/**
 * Double-click launcher. The wording follows the package: the API package is
 * about hosted data, the local-CSV package must never imply a live feed.
 */
export function generateBatchLauncher(mode: "api" | "local-csv" = "api"): string {
  const blurb =
    mode === "local-csv"
      ? "Configuring Microsoft Excel with your local option chain CSV file..."
      : "Configuring Microsoft Excel with live hosted option chain data...";
  return `@echo off
setlocal
cd /d "%~dp0"
title NSE Option Chain - Excel Setup Utility

echo ================================================================
echo   NSE Option Chain - Desktop Excel Automated Setup
echo ================================================================
echo.
echo ${blurb}
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-NSE-Excel.ps1" %*

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Setup failed. Please check the error message above.
    echo.
    pause
) else (
    echo.
    echo [*] Setup completed successfully!
    echo.
    pause
)
`;
}

export function generatePowerShellSetupScript(config: SetupPackageConfig): string {
  const safeBaseUrl = config.baseUrl.replace(/\/+$/, "");
  const safeSymbol = config.symbol || "NIFTY";
  const safeExpiry = config.expiry || "latest";
  const safeRange = config.strikeRange || "all";
  const safeFields = config.fields || "all";
  const safeInterval = config.refreshMinutes || 5;
  const safeAutoRefresh = config.autoRefresh ? "True" : "False";
  const safeTargetPath = config.targetPath || "";

  return `# ==============================================================================
# NSE Option Chain - Desktop Excel Automated Setup Script
# ==============================================================================
# This script provisions a fresh, reusable Microsoft Excel workbook with
# live Power Query connections to your hosted NSE Option Chain API.
# ==============================================================================

[CmdletBinding()]
param(
    [string]$TargetWorkbookPath = "",
    [switch]$NonInteractive = $false
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  NSE Option Chain - Automated Excel Setup" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# Helper to add or update query idempotently
function AddOrUpdateQuery($workbook, [string]$name, [string]$formula, [string]$description) {
    $existing = $null
    foreach ($q in $workbook.Queries) {
        if ($q.Name -eq $name) {
            $existing = $q
            break
        }
    }
    if ($existing) {
        $existing.Formula = $formula
        $existing.Description = $description
        return $existing
    } else {
        return $workbook.Queries.Add($name, $formula, $description)
    }
}

# 1. Load Configuration
$configFile = Join-Path $PSScriptRoot "config.json"
$rawConfig = $null
if (Test-Path $configFile) {
    try {
        $rawConfig = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $baseUrl = if ($rawConfig.baseUrl) { $rawConfig.baseUrl.TrimEnd("/") } else { "${safeBaseUrl}" }
        $symbol = if ($rawConfig.symbol) { $rawConfig.symbol.ToUpper() } else { "${safeSymbol}" }
        $expiry = if ($rawConfig.expiry) { $rawConfig.expiry } else { "${safeExpiry}" }
        $strikeRange = if ($rawConfig.strikeRange) { $rawConfig.strikeRange } else { "${safeRange}" }
        $fields = if ($rawConfig.fields) { $rawConfig.fields } else { "${safeFields}" }
        $refreshMinutes = if ($rawConfig.refreshMinutes) { [int]$rawConfig.refreshMinutes } else { ${safeInterval} }
        $autoRefresh = if ($null -ne $rawConfig.autoRefresh) { [bool]$rawConfig.autoRefresh } else { ${safeAutoRefresh} }
    } catch {
        Write-Warning "Could not parse config.json, using bundled defaults."
        $baseUrl = "${safeBaseUrl}"
        $symbol = "${safeSymbol}"
        $expiry = "${safeExpiry}"
        $strikeRange = "${safeRange}"
        $fields = "${safeFields}"
        $refreshMinutes = ${safeInterval}
        $autoRefresh = ${safeAutoRefresh}
    }
} else {
    $baseUrl = "${safeBaseUrl}"
    $symbol = "${safeSymbol}"
    $expiry = "${safeExpiry}"
    $strikeRange = "${safeRange}"
    $fields = "${safeFields}"
    $refreshMinutes = ${safeInterval}
    $autoRefresh = ${safeAutoRefresh}
}

Write-Host "Configuration:" -ForegroundColor White
Write-Host "  API Endpoint:  $baseUrl/api/option-chain"
Write-Host "  Symbol:        $symbol"
Write-Host "  Expiry:        $expiry"
Write-Host "  Strike Range:  $strikeRange"
Write-Host "  Fields:        $fields"
Write-Host "  Auto Refresh:  $autoRefresh (every $refreshMinutes min)"
Write-Host ""

# 2. Check Excel Desktop Installation
Write-Host "[1/5] Checking Microsoft Excel Desktop installation..." -ForegroundColor Yellow
$excel = $null
$wb = $null

try {
    $excel = New-Object -ComObject Excel.Application
} catch {
    Write-Host "[ERROR] Microsoft Excel is not installed or COM automation is blocked." -ForegroundColor Red
    Write-Host "Detail: $($_.Exception.Message)"
    exit 1
}

$excelVersion = [double]$excel.Version
Write-Host "  Detected Excel version: $excelVersion" -ForegroundColor Green
if ($excelVersion -lt 16.0) {
    Write-Warning "Power Query features are best supported in Excel 2016 or newer (Version 16.0+)."
}

# 3. Target Workbook Path (User-Selectable or Default to Documents)
$docsFolder = [Environment]::GetFolderPath("MyDocuments")
if (-not (Test-Path $docsFolder)) {
    $docsFolder = $PSScriptRoot
}
$defaultPath = Join-Path $docsFolder "NSE_Option_Chain_$symbol.xlsx"

if ($TargetWorkbookPath -and $TargetWorkbookPath.Trim() -ne "") {
    $targetPath = $TargetWorkbookPath.Trim()
} elseif ($rawConfig -and $rawConfig.targetPath -and $rawConfig.targetPath.Trim() -ne "") {
    $targetPath = $rawConfig.targetPath.Trim()
} elseif ("${safeTargetPath}" -ne "") {
    $targetPath = "${safeTargetPath}"
} elseif ([Environment]::UserInteractive -and -not $NonInteractive -and $Host.Name -notmatch "ServerRemoteHost") {
    Write-Host "Target workbook save path:" -ForegroundColor Cyan
    Write-Host "  Press [Enter] for default: $defaultPath" -ForegroundColor Gray
    $prompted = Read-Host "  Or enter custom path (.xlsx)"
    if ($prompted -and $prompted.Trim() -ne "") {
        $targetPath = $prompted.Trim()
    } else {
        $targetPath = $defaultPath
    }
} else {
    $targetPath = $defaultPath
}

$targetDir = Split-Path $targetPath -Parent
if ($targetDir -and -not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

Write-Host "[2/5] Creating target workbook..." -ForegroundColor Yellow
Write-Host "  Destination: $targetPath"

$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
    $wb = $excel.Workbooks.Add()

    # Enable FastCombine to eliminate Power Query data privacy firewall blocks
    # when combining Excel.CurrentWorkbook() settings with Web.Contents().
    $wb.Queries.FastCombine = $true

    # 4. Sheet 1: Settings (Control Panel)
    Write-Host "[3/5] Building Settings (Control Panel) sheet..." -ForegroundColor Yellow
    $settingsSheet = $wb.Worksheets.Item(1)
    $settingsSheet.Name = "Settings"

    $settingsSheet.Cells.Item(1, 1).Value2 = "Parameter"
    $settingsSheet.Cells.Item(1, 2).Value2 = "Value"
    $settingsSheet.Cells.Item(1, 3).Value2 = "Description"

    $settingRows = @(
        @("BaseUrl", $baseUrl, "Hosted API Base URL (no trailing slash)"),
        @("Symbol", $symbol, "Index symbol: NIFTY, BANKNIFTY, FINNIFTY"),
        @("Expiry", $expiry, "Option expiry date or 'latest'"),
        @("StrikeRange", $strikeRange, "Strike filter: all, 10, 20, or 30 around ATM"),
        @("SelectedFields", $fields, "Field columns: all, or comma list"),
        @("RefreshIntervalMinutes", [string]$refreshMinutes, "Background refresh frequency (minutes)"),
        @("AutoRefreshEnabled", [string]$autoRefresh, "Enable background interval refresh: True/False")
    )

    $settingsSheet.Range("B2:B8").NumberFormat = "@"
    for ($i = 0; $i -lt $settingRows.Length; $i++) {
        $rowNum = $i + 2
        $settingsSheet.Cells.Item($rowNum, 1).Value2 = $settingRows[$i][0]
        $settingsSheet.Cells.Item($rowNum, 2).Value2 = $settingRows[$i][1]
        $settingsSheet.Cells.Item($rowNum, 3).Value2 = $settingRows[$i][2]
    }

    $tableRange = $settingsSheet.Range("A1:C8")
    $settingsTable = $settingsSheet.ListObjects.Add(1, $tableRange, [System.Type]::Missing, 1)
    $settingsTable.Name = "SettingsTable"
    $settingsTable.TableStyle = "TableStyleMedium2"

    $settingsSheet.Cells.Item(10, 1).Value2 = "Instructions:"
    $settingsSheet.Cells.Item(10, 1).Font.Bold = $true
    $settingsSheet.Cells.Item(11, 1).Value2 = "1. To change symbol or expiry: edit the Value column in the table above."
    $settingsSheet.Cells.Item(12, 1).Value2 = "2. Press Data > Refresh All (Ctrl+Alt+F5) to reload data from the hosted API."
    $settingsSheet.Cells.Item(13, 1).Value2 = "3. Auto-refresh updates data automatically while this workbook remains open."
    $settingsSheet.Columns.AutoFit() | Out-Null

    # 5. Sheet 2: Option Chain & Sheet 3: Raw Data
    $chainSheet = $wb.Worksheets.Add([System.Type]::Missing, $settingsSheet)
    $chainSheet.Name = "Option Chain"

    $rawSheet = $wb.Worksheets.Add([System.Type]::Missing, $chainSheet)
    $rawSheet.Name = "Raw Data"

    # 6. Power Query M Formulas
    Write-Host "[4/5] Creating Power Query connections & data tables..." -ForegroundColor Yellow

    $mOptionChain = @"
let
    Settings = Excel.CurrentWorkbook(){[Name="SettingsTable"]}[Content],
    GetVal = (k as text) as text =>
        let r = Table.SelectRows(Settings, each [Parameter] = k)
        in if Table.IsEmpty(r) then "" else Text.Trim(Text.From(r{0}[Value])),

    BaseUrl = GetVal("BaseUrl"),
    pSymbol = GetVal("Symbol"),
    pExpiry = GetVal("Expiry"),
    pRange = GetVal("StrikeRange"),
    pFields = GetVal("SelectedFields"),

    EffectiveUrl = if BaseUrl = "" then "$baseUrl" else BaseUrl,
    EffectiveSymbol = if pSymbol = "" then "$symbol" else pSymbol,

    QueryParams = [
        symbol = EffectiveSymbol,
        format = "csv",
        range = if pRange = "" then "all" else pRange,
        fields = if pFields = "" then "all" else pFields
    ],
    WithExpiry = if pExpiry <> "" and pExpiry <> "latest" and pExpiry <> "all" then Record.AddField(QueryParams, "expiry", pExpiry) else QueryParams,

    Source = Web.Contents(
        EffectiveUrl,
        [
            RelativePath = "/api/option-chain",
            Query = WithExpiry,
            ManualStatusHandling = { 400, 404, 413, 429, 502, 503 }
        ]
    ),
    Status = Value.Metadata(Source)[Response.Status],
    CsvData = if Status = 200 then Csv.Document(Source, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv])
              else error Error.Record("NSE API Error", "HTTP " & Text.From(Status), "Failed to retrieve option chain from " & EffectiveUrl),
    Promoted = Table.PromoteHeaders(CsvData, [PromoteAllScalars = true]),
    TextCols = { "symbol", "expiry", "nse_timestamp", "snapshot_updated_at", "status" },
    AllCols = Table.ColumnNames(Promoted),
    Typed = Table.TransformColumnTypes(
        Promoted,
        List.Transform(AllCols, each { _, if List.Contains(TextCols, _) then type text else type number })
    )
in
    Typed
"@

    $mRawData = @"
let
    Settings = Excel.CurrentWorkbook(){[Name="SettingsTable"]}[Content],
    GetVal = (k as text) as text =>
        let r = Table.SelectRows(Settings, each [Parameter] = k)
        in if Table.IsEmpty(r) then "" else Text.Trim(Text.From(r{0}[Value])),

    BaseUrl = GetVal("BaseUrl"),
    pSymbol = GetVal("Symbol"),
    pExpiry = GetVal("Expiry"),

    EffectiveUrl = if BaseUrl = "" then "$baseUrl" else BaseUrl,
    EffectiveSymbol = if pSymbol = "" then "$symbol" else pSymbol,

    QueryParams = [
        symbol = EffectiveSymbol,
        format = "csv",
        range = "all",
        fields = "all"
    ],
    WithExpiry = if pExpiry <> "" and pExpiry <> "latest" and pExpiry <> "all" then Record.AddField(QueryParams, "expiry", pExpiry) else QueryParams,

    Source = Web.Contents(
        EffectiveUrl,
        [
            RelativePath = "/api/option-chain",
            Query = WithExpiry,
            ManualStatusHandling = { 400, 404, 413, 429, 502, 503 }
        ]
    ),
    Status = Value.Metadata(Source)[Response.Status],
    CsvData = if Status = 200 then Csv.Document(Source, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv])
              else error Error.Record("NSE API Error", "HTTP " & Text.From(Status), "Failed to retrieve raw option chain"),
    Promoted = Table.PromoteHeaders(CsvData, [PromoteAllScalars = true]),
    TextCols = { "symbol", "expiry", "nse_timestamp", "snapshot_updated_at", "status" },
    AllCols = Table.ColumnNames(Promoted),
    Typed = Table.TransformColumnTypes(
        Promoted,
        List.Transform(AllCols, each { _, if List.Contains(TextCols, _) then type text else type number })
    )
in
    Typed
"@

    # Add or update queries idempotently
    $null = AddOrUpdateQuery $wb "NseOptionChain" $mOptionChain "NSE Option Chain filtered view"
    $null = AddOrUpdateQuery $wb "NseOptionChainRaw" $mRawData "NSE Option Chain complete raw view"

    # Add connection and load to Excel Table (ListObject) for Option Chain
    $connChain = $wb.Connections.Add2(
        "Query - NseOptionChain",
        "Connection to NseOptionChain",
        "OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=\`$Workbook\`$;Location=NseOptionChain",
        "SELECT * FROM [NseOptionChain]",
        2
    )
    $connChain.OLEDBConnection.RefreshOnFileOpen = $true
    $connChain.OLEDBConnection.BackgroundQuery = $true
    if ($autoRefresh) {
        $connChain.OLEDBConnection.RefreshPeriod = $refreshMinutes
    }

    $loChain = $chainSheet.ListObjects.Add(0, $connChain, [System.Type]::Missing, 1, $chainSheet.Range("A1"))
    $loChain.Name = "OptionChainTable"
    $loChain.TableStyle = "TableStyleMedium9"
    $loChain.QueryTable.RefreshOnFileOpen = $true
    $loChain.QueryTable.BackgroundQuery = $false
    $loChain.QueryTable.PreserveFormatting = $true
    $loChain.QueryTable.AdjustColumnWidth = $true
    if ($autoRefresh) {
        $loChain.QueryTable.RefreshPeriod = $refreshMinutes
    }
    Write-Host "  Initial fetch for Option Chain table..." -ForegroundColor Gray
    try {
        $loChain.QueryTable.Refresh($false)
    } catch {
        Write-Warning "Initial Option Chain query refresh notice: $($_.Exception.Message)"
    }

    # Add connection and load to Excel Table (ListObject) for Raw Data
    $connRaw = $wb.Connections.Add2(
        "Query - NseOptionChainRaw",
        "Connection to NseOptionChainRaw",
        "OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=\`$Workbook\`$;Location=NseOptionChainRaw",
        "SELECT * FROM [NseOptionChainRaw]",
        2
    )
    $connRaw.OLEDBConnection.RefreshOnFileOpen = $true
    $connRaw.OLEDBConnection.BackgroundQuery = $true
    if ($autoRefresh) {
        $connRaw.OLEDBConnection.RefreshPeriod = $refreshMinutes
    }

    $loRaw = $rawSheet.ListObjects.Add(0, $connRaw, [System.Type]::Missing, 1, $rawSheet.Range("A1"))
    $loRaw.Name = "RawDataTable"
    $loRaw.TableStyle = "TableStyleMedium2"
    $loRaw.QueryTable.RefreshOnFileOpen = $true
    $loRaw.QueryTable.BackgroundQuery = $false
    $loRaw.QueryTable.PreserveFormatting = $true
    $loRaw.QueryTable.AdjustColumnWidth = $true
    if ($autoRefresh) {
        $loRaw.QueryTable.RefreshPeriod = $refreshMinutes
    }
    Write-Host "  Initial fetch for Raw Data table..." -ForegroundColor Gray
    try {
        $loRaw.QueryTable.Refresh($false)
    } catch {
        Write-Warning "Initial Raw Data query refresh notice: $($_.Exception.Message)"
    }

    # Re-enable asynchronous background queries for ongoing user usage
    $loChain.QueryTable.BackgroundQuery = $true
    $loRaw.QueryTable.BackgroundQuery = $true

    # 7. Sheet 4: Summary Dashboard (Created after tables so structured references resolve)
    Write-Host "[5/5] Building Summary Dashboard sheet with live formulas..." -ForegroundColor Yellow
    $summarySheet = $wb.Worksheets.Add([System.Type]::Missing, $rawSheet)
    $summarySheet.Name = "Summary"

    $summarySheet.Cells.Item(1, 1).Value2 = "NSE Option Chain - Snapshot Summary"
    $summarySheet.Range("A1:D1").Font.Bold = $true
    $summarySheet.Range("A1:D1").Font.Size = 14

    $hasTableCols = $false
    try {
        if ($loChain.ListColumns.Count -ge 10) {
            $hasTableCols = $true
        }
    } catch {}

    $summaryEntries = if ($hasTableCols) {
        @(
            @("Symbol", "=IFERROR(INDEX(OptionChainTable[symbol],1),""$symbol"")"),
            @("Expiry", "=IFERROR(INDEX(OptionChainTable[expiry],1),""$expiry"")"),
            @("Spot Price", "=IFERROR(INDEX(OptionChainTable[spot],1),""-"")"),
            @("PCR", "=IFERROR(INDEX(OptionChainTable[pcr],1),""-"")"),
            @("Max Pain", "=IFERROR(INDEX(OptionChainTable[max_pain],1),""-"")"),
            @("Total CE OI", "=IFERROR(INDEX(OptionChainTable[total_ce_oi],1),""-"")"),
            @("Total PE OI", "=IFERROR(INDEX(OptionChainTable[total_pe_oi],1),""-"")"),
            @("NSE Timestamp", "=IFERROR(INDEX(OptionChainTable[nse_timestamp],1),""-"")"),
            @("Snapshot Status", "=IFERROR(INDEX(OptionChainTable[status],1),""-"")"),
            @("Last Refreshed (Local)", "=NOW()"),
            @("Refresh Frequency", "$refreshMinutes min (Auto: $autoRefresh)"),
            @("API Source", "$baseUrl")
        )
    } else {
        @(
            @("Symbol", "=IFERROR('Option Chain'!A2,""$symbol"")"),
            @("Expiry", "=IFERROR('Option Chain'!B2,""$expiry"")"),
            @("Spot Price", "=IFERROR('Option Chain'!C2,""-"")"),
            @("PCR", "=IFERROR('Option Chain'!D2,""-"")"),
            @("Max Pain", "=IFERROR('Option Chain'!E2,""-"")"),
            @("Total CE OI", "=IFERROR('Option Chain'!F2,""-"")"),
            @("Total PE OI", "=IFERROR('Option Chain'!G2,""-"")"),
            @("NSE Timestamp", "=IFERROR('Option Chain'!H2,""-"")"),
            @("Snapshot Status", "=IFERROR('Option Chain'!J2,""-"")"),
            @("Last Refreshed (Local)", "=NOW()"),
            @("Refresh Frequency", "$refreshMinutes min (Auto: $autoRefresh)"),
            @("API Source", "$baseUrl")
        )
    }

    for ($i = 0; $i -lt $summaryEntries.Length; $i++) {
        $r = $i + 3
        $summarySheet.Cells.Item($r, 1).Value2 = $summaryEntries[$i][0]
        $summarySheet.Cells.Item($r, 1).Font.Bold = $true
        if ($summaryEntries[$i][1].StartsWith("=")) {
            $summarySheet.Cells.Item($r, 2).Formula = $summaryEntries[$i][1]
        } else {
            $summarySheet.Cells.Item($r, 2).Value2 = $summaryEntries[$i][1]
        }
    }
    $summarySheet.Columns.AutoFit() | Out-Null

    # Re-order sheets: Summary -> Option Chain -> Raw Data -> Settings
    $summarySheet.Move($wb.Worksheets.Item(1))

    # Activate Option Chain sheet by default
    $chainSheet.Activate()

    # Save the workbook (51 = xlOpenXMLWorkbook (.xlsx))
    $wb.SaveAs($targetPath, 51)
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "  SETUP SUCCESSFUL!" -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "Workbook saved to: $targetPath" -ForegroundColor White
    Write-Host ""
    Write-Host "Sheets created:"
    Write-Host "  - Summary:      Key snapshot metrics and timestamps (live formulas)"
    Write-Host "  - Option Chain: Live Excel Table connected to Power Query"
    Write-Host "  - Raw Data:     Unfiltered full-strike Excel Table"
    Write-Host "  - Settings:     Control panel for symbol, expiry & strike range"
    Write-Host ""

    if (-not $NonInteractive) {
        Write-Host "Opening workbook in Microsoft Excel..." -ForegroundColor Cyan
        $excel.Visible = $true
        $excel.DisplayAlerts = $true
    } else {
        $wb.Close($false)
    }
} catch {
    Write-Host ""
    Write-Host "[ERROR] Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($wb) {
        try { $wb.Close($false) } catch {}
    }
    if ($excel) {
        try { $excel.Quit() } catch {}
    }
    exit 1
} finally {
    if ($wb -and $NonInteractive) {
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null } catch {}
    }
    if ($excel -and $NonInteractive) {
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
`;
}

export function generateReadme(config: SetupPackageConfig): string {
  return `================================================================================
NSE Option Chain - Desktop Excel One-Click Setup Package
================================================================================

This package automatically configures Microsoft Excel Desktop on Windows to
connect directly to your hosted Option Chain API.

Package Contents:
  - Setup-NSE-Excel.bat   : Double-click launcher to run setup
  - Setup-NSE-Excel.ps1   : PowerShell COM automation script
  - config.json           : Your selected configuration settings
  - README.txt            : This user guide

Pre-requisites:
  - Microsoft Windows 10 or 11
  - Microsoft Excel Desktop 2016, 2019, 2021, or Microsoft 365
  - Active internet connection

How to run:
  1. Extract all files from this ZIP package into any folder.
  2. Double-click 'Setup-NSE-Excel.bat'.
  3. The setup script will:
     - Verify desktop Excel installation.
     - Build a configured workbook with Summary, Option Chain, Raw Data and Settings.
     - Connect Power Query queries to the hosted read-only API:
       ${config.baseUrl}/api/option-chain
     - Enable FastCombine so local settings and web API combine without privacy prompts.
     - Create native Excel Tables (OptionChainTable and RawDataTable) with formatting preserved.
     - Enable Refresh on Open and background refresh (${config.refreshMinutes} min).
     - Save the workbook to your Documents folder:
       ${config.targetPath || `NSE_Option_Chain_${config.symbol || "NIFTY"}.xlsx`}
     - Open the workbook in Microsoft Excel.

How to use after setup:
  - To Refresh Data: Click Data > Refresh All (or press Ctrl+Alt+F5).
  - To Change Symbol or Expiry: Open the 'Settings' sheet, edit the Value cell
    (e.g., change Symbol to BANKNIFTY or FINNIFTY), and click 'Refresh All'.
  - You can reuse the same saved workbook indefinitely without downloading again.

Security & Transparency:
  - No macros or VBA (.xlsm) are used. The workbook is a standard .xlsx file.
  - The connection uses Excel's native Power Query engine reading from a read-only API.
  - No Supabase keys, passwords, or personal credentials are included or required.
================================================================================
`;
}

export async function buildSetupZipBlob(config: SetupPackageConfig): Promise<Blob> {
  const zip = new JSZip();

  const configJson = JSON.stringify(
    {
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      symbol: config.symbol,
      expiry: config.expiry || "latest",
      strikeRange: config.strikeRange,
      fields: config.fields,
      refreshMinutes: config.refreshMinutes,
      autoRefresh: config.autoRefresh,
      targetPath: config.targetPath || "",
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );

  zip.file("config.json", configJson);
  zip.file("Setup-NSE-Excel.bat", generateBatchLauncher());
  zip.file("Setup-NSE-Excel.ps1", generatePowerShellSetupScript(config));
  zip.file("README.txt", generateReadme(config));

  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

// ---------------------------------------------------------------------------
// Local CSV source (zero-cost workflow)
//
// Power Query reads a CSV the user picked on their own machine. There is no
// web request, no API URL and no localhost anywhere in this path. Refresh only
// rereads that file; it never fetches fresh data from NSE.
// ---------------------------------------------------------------------------

/**
 * Power Query M for the local CSV chain view.
 *
 * Reads the flat, self-describing CSV the dashboard exports (metadata columns
 * first, then the chain), filters by the Settings symbol/expiry, and fails
 * with a readable message when the file is missing, the schema changed, or the
 * selected expiry is not in the file — so a stale table is never silently
 * replaced with wrong data.
 */
function localCsvChainM(config: LocalCsvSetupConfig): string {
  const fallbackSymbol = (config.symbol || "NIFTY").replace(/"/g, '""');
  const fallbackExpiry = (config.expiry || "").replace(/"/g, '""');
  return `let
    Settings = Excel.CurrentWorkbook(){[Name="SettingsTable"]}[Content],
    GetVal = (k as text) as text =>
        let r = Table.SelectRows(Settings, each [Parameter] = k)
        in if Table.IsEmpty(r) then "" else Text.Trim(Text.From(r{0}[Value])),

    CsvPath = GetVal("CsvPath"),
    pSymbol = GetVal("Symbol"),
    pExpiry = GetVal("Expiry"),

    EffectiveSymbol = if pSymbol = "" then "${fallbackSymbol}" else Text.Upper(pSymbol),
    EffectiveExpiry = if pExpiry = "" then "${fallbackExpiry}" else pExpiry,

    // The path must be explicit. Never fall back to a default or a URL.
    CheckedPath =
        if CsvPath = "" then
            error "No CSV file path is configured. Open the Settings sheet and set CsvPath to the full path of the CSV you exported, then Refresh All."
        else CsvPath,

    FileBytes =
        try File.Contents(CheckedPath)
        otherwise error "Could not read the CSV file at: " & CheckedPath & ". Check the path on the Settings sheet and that the file still exists.",

    CsvData = Csv.Document(FileBytes, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(CsvData, [PromoteAllScalars = true]),

    // Schema check: a rewritten export must fail loudly, not load as junk.
    RequiredCols = { "symbol", "expiry", "STRIKE" },
    PresentCols = Table.ColumnNames(Promoted),
    MissingCols = List.RemoveItems(RequiredCols, PresentCols),
    SchemaOk =
        if List.Count(MissingCols) > 0 then
            error "The CSV at " & CheckedPath & " is missing required column(s): "
                  & Text.Combine(MissingCols, ", ")
                  & ". Re-export the option chain from the dashboard so the header row matches."
        else Promoted,

    Typed = Table.TransformColumnTypes(
        SchemaOk,
        List.Transform(
            Table.ColumnNames(SchemaOk),
            each { _, if List.Contains({"symbol", "expiry", "nse_timestamp", "snapshot_updated_at", "status"}, _) then type text else type number }
        )
    ),

    SymFiltered = Table.SelectRows(Typed, each Text.Upper([symbol]) = EffectiveSymbol),

    // An expiry that is no longer present must say so, not return an empty table.
    ExpiryFiltered =
        if EffectiveExpiry = "" or EffectiveExpiry = "latest" or EffectiveExpiry = "all" then SymFiltered
        else Table.SelectRows(SymFiltered, each [expiry] = EffectiveExpiry),

    Final =
        if Table.IsEmpty(ExpiryFiltered) then
            error "No rows in " & CheckedPath & " for symbol " & EffectiveSymbol
                  & (if EffectiveExpiry = "" or EffectiveExpiry = "latest" or EffectiveExpiry = "all" then ""
                     else " and expiry " & EffectiveExpiry)
                  & ". The file may cover a different contract; update the Settings sheet or export a matching CSV."
        else ExpiryFiltered
in
    Final`;
}

/** Raw view: every row of the file, no symbol/expiry filtering. */
function localCsvRawM(): string {
  return `let
    Settings = Excel.CurrentWorkbook(){[Name="SettingsTable"]}[Content],
    GetVal = (k as text) as text =>
        let r = Table.SelectRows(Settings, each [Parameter] = k)
        in if Table.IsEmpty(r) then "" else Text.Trim(Text.From(r{0}[Value])),

    CsvPath = GetVal("CsvPath"),

    CheckedPath =
        if CsvPath = "" then
            error "No CSV file path is configured. Open the Settings sheet and set CsvPath to the full path of the CSV you exported, then Refresh All."
        else CsvPath,

    FileBytes =
        try File.Contents(CheckedPath)
        otherwise error "Could not read the CSV file at: " & CheckedPath & ". Check the path on the Settings sheet and that the file still exists.",

    CsvData = Csv.Document(FileBytes, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(CsvData, [PromoteAllScalars = true]),

    PresentCols = Table.ColumnNames(Promoted),
    MissingCols = List.RemoveItems({ "symbol", "expiry", "STRIKE" }, PresentCols),
    SchemaOk =
        if List.Count(MissingCols) > 0 then
            error "The CSV at " & CheckedPath & " is missing required column(s): "
                  & Text.Combine(MissingCols, ", ")
                  & ". Re-export the option chain from the dashboard so the header row matches."
        else Promoted,

    Typed = Table.TransformColumnTypes(
        SchemaOk,
        List.Transform(
            Table.ColumnNames(SchemaOk),
            each { _, if List.Contains({"symbol", "expiry", "nse_timestamp", "snapshot_updated_at", "status"}, _) then type text else type number }
        )
    )
in
    Typed`;
}

export function generateLocalCsvSetupScript(config: LocalCsvSetupConfig): string {
  const safeSymbol = config.symbol || "NIFTY";
  const safeExpiry = config.expiry || "latest";
  const safeInterval = config.refreshMinutes || 5;
  const safeAutoRefresh = config.autoRefresh ? "True" : "False";
  const safeTargetPath = config.targetPath || "";
  const safeCsvPath = config.csvPath || "";

  return `# ==============================================================================
# NSE Option Chain - Local CSV Excel Setup (zero-cost workflow)
# ==============================================================================
# Power Query reads a CSV file YOU selected on this computer. There is no web
# request and no web address in this workbook. Refreshing only rereads
# that same file; it does NOT fetch fresh data from NSE. To get newer market
# data, save a new CSV over the same path (or a new path you then select).
# ==============================================================================

[CmdletBinding()]
param(
    [string]$TargetWorkbookPath = "",
    # Explicit local CSV path. When empty the script prompts for it; it is
    # never invented and never silently defaulted.
    [string]$CsvPath = "",
    [switch]$NonInteractive = $false
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  NSE Option Chain - Local CSV Excel Setup" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# Helper to add or update query idempotently
function AddOrUpdateQuery($workbook, [string]$name, [string]$formula, [string]$description) {
    $existing = $null
    foreach ($q in $workbook.Queries) {
        if ($q.Name -eq $name) {
            $existing = $q
            break
        }
    }
    if ($existing) {
        $existing.Formula = $formula
        $existing.Description = $description
        return $existing
    } else {
        return $workbook.Queries.Add($name, $formula, $description)
    }
}

# 0. Resolve configuration (explicit path only, no defaults)
$rawConfig = $null
if (Test-Path config.json) {
    try {
        $rawConfig = Get-Content config.json -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Warning "Could not parse config.json; ignoring it."
    }
}

$symbol = if ($rawConfig -and $rawConfig.symbol) { $rawConfig.symbol.ToUpper() } else { "${safeSymbol}" }
$expiry = if ($rawConfig -and $rawConfig.expiry) { $rawConfig.expiry } else { "${safeExpiry}" }
$refreshMinutes = if ($rawConfig -and $rawConfig.refreshMinutes) { [int]$rawConfig.refreshMinutes } else { ${safeInterval} }
$autoRefresh = if ($rawConfig -and $null -ne $rawConfig.autoRefresh) { [bool]$rawConfig.autoRefresh } else { ${safeAutoRefresh} }

# The CSV path must be explicit. Prefer the parameter, then config.json, then
# prompt. Never fall back to a default path or a URL.
if (-not $CsvPath -or $CsvPath.Trim() -eq "") {
    if ($rawConfig -and $rawConfig.csvPath -and $rawConfig.csvPath.Trim() -ne "") {
        $CsvPath = $rawConfig.csvPath.Trim()
    } elseif ("${safeCsvPath}" -ne "") {
        $CsvPath = "${safeCsvPath}"
    } elseif ([Environment]::UserInteractive -and -not $NonInteractive -and $Host.Name -notmatch "ServerRemoteHost") {
        Write-Host "Path to the option-chain CSV file to use as the data source:" -ForegroundColor Cyan
        Write-Host "  (export it from the dashboard's Import NSE CSV section first)" -ForegroundColor Gray
        $CsvPath = (Read-Host "  Full path, e.g. C:\\Users\\you\\Documents\\NIFTY_chain.csv").Trim()
    } else {
        $CsvPath = ""
    }
}

if (-not $CsvPath -or $CsvPath.Trim() -eq "") {
    Write-Host "[ERROR] No CSV file path was provided." -ForegroundColor Red
    Write-Host "  This setup needs an explicit local CSV path and will not invent one." -ForegroundColor Yellow
    Write-Host "  Re-run with -CsvPath \\"C:\\path\\to\\chain.csv\\" or set csvPath in config.json." -ForegroundColor Yellow
    exit 1
}
$CsvPath = $CsvPath.Trim()

if (-not (Test-Path -LiteralPath $CsvPath -PathType Leaf)) {
    Write-Host "[ERROR] The CSV file does not exist:" -ForegroundColor Red
    Write-Host "  $CsvPath" -ForegroundColor Yellow
    Write-Host "  Point CsvPath at the CSV you exported from the dashboard." -ForegroundColor Yellow
    exit 1
}

Write-Host "Configuration:" -ForegroundColor White
Write-Host "  CSV source:    $CsvPath"
Write-Host "  Symbol:        $symbol"
Write-Host "  Expiry:        $expiry"
Write-Host "  Auto Refresh:  $autoRefresh (every $refreshMinutes min)"
Write-Host ""
Write-Host "NOTE: Refreshing re-reads the CSV above. It does not contact NSE." -ForegroundColor Yellow
Write-Host ""

# 1. Check Excel Desktop Installation
Write-Host "[1/5] Checking Microsoft Excel Desktop installation..." -ForegroundColor Yellow
$excel = $null
$wb = $null

try {
    $excel = New-Object -ComObject Excel.Application
} catch {
    Write-Host "[ERROR] Microsoft Excel is not installed or COM automation is blocked." -ForegroundColor Red
    Write-Host "Detail: $($_.Exception.Message)"
    exit 1
}

$excelVersion = [double]$excel.Version
Write-Host "  Detected Excel version: $excelVersion" -ForegroundColor Green
if ($excelVersion -lt 16.0) {
    Write-Warning "Power Query is best supported in Excel 2016 or newer (Version 16.0+)."
}

# 2. Target Workbook Path
$docsFolder = [Environment]::GetFolderPath("MyDocuments")
if (-not (Test-Path $docsFolder)) {
    $docsFolder = $PSScriptRoot
}
$defaultPath = Join-Path $docsFolder "NSE_Option_Chain_LocalCsv_$symbol.xlsx"

if ($TargetWorkbookPath -and $TargetWorkbookPath.Trim() -ne "") {
    $targetPath = $TargetWorkbookPath.Trim()
} elseif ($rawConfig -and $rawConfig.targetPath -and $rawConfig.targetPath.Trim() -ne "") {
    $targetPath = $rawConfig.targetPath.Trim()
} elseif ("${safeTargetPath}" -ne "") {
    $targetPath = "${safeTargetPath}"
} elseif ([Environment]::UserInteractive -and -not $NonInteractive -and $Host.Name -notmatch "ServerRemoteHost") {
    Write-Host "Target workbook save path:" -ForegroundColor Cyan
    Write-Host "  Press [Enter] for default: $defaultPath" -ForegroundColor Gray
    $prompted = Read-Host "  Or enter custom path (.xlsx)"
    if ($prompted -and $prompted.Trim() -ne "") {
        $targetPath = $prompted.Trim()
    } else {
        $targetPath = $defaultPath
    }
} else {
    $targetPath = $defaultPath
}

$targetDir = Split-Path $targetPath -Parent
if ($targetDir -and -not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

Write-Host "[2/5] Creating target workbook..." -ForegroundColor Yellow
Write-Host "  Destination: $targetPath"

$excel.Visible = $false
$excel.DisplayAlerts = $false

# M formulas reference the CSV path and the workbook's Settings table.
$mChain = "${localCsvChainM(config).replace(/"/g, '`"').replace(/\$/g, '`$')}"
$mRaw = "${localCsvRawM().replace(/"/g, '`"').replace(/\$/g, '`$')}"

try {
    $wb = $excel.Workbooks.Add()

    # FastCombine lets Power Query read the local Settings table and the file
    # without a data-privacy firewall prompt.
    $wb.Queries.FastCombine = $true

    # 3. Settings sheet
    Write-Host "[3/5] Building Settings (Control Panel) sheet..." -ForegroundColor Yellow
    $settingsSheet = $wb.Worksheets.Item(1)
    $settingsSheet.Name = "Settings"

    $settingsSheet.Cells.Item(1, 1).Value2 = "Parameter"
    $settingsSheet.Cells.Item(1, 2).Value2 = "Value"
    $settingsSheet.Cells.Item(1, 3).Value2 = "Description"

    $settingRows = @(
        @("CsvPath", $CsvPath, "Full path to the local CSV file (the only data source)"),
        @("Symbol", $symbol, "Index symbol: NIFTY, BANKNIFTY, FINNIFTY"),
        @("Expiry", $expiry, "Option expiry date, 'latest', or 'all'"),
        @("RefreshIntervalMinutes", [string]$refreshMinutes, "Background refresh frequency (minutes)"),
        @("AutoRefreshEnabled", [string]$autoRefresh, "Enable background interval refresh: True/False")
    )

    $settingsSheet.Range("B2:B8").NumberFormat = "@"
    for ($i = 0; $i -lt $settingRows.Length; $i++) {
        $rowNum = $i + 2
        $settingsSheet.Cells.Item($rowNum, 1).Value2 = $settingRows[$i][0]
        $settingsSheet.Cells.Item($rowNum, 2).Value2 = $settingRows[$i][1]
        $settingsSheet.Cells.Item($rowNum, 3).Value2 = $settingRows[$i][2]
    }

    $tableRange = $settingsSheet.Range("A1:C" + (1 + $settingRows.Length))
    $settingsTable = $settingsSheet.ListObjects.Add(1, $tableRange, [System.Type]::Missing, 1)
    $settingsTable.Name = "SettingsTable"
    $settingsTable.TableStyle = "TableStyleMedium2"

    $settingsSheet.Cells.Item(9, 1).Value2 = "Instructions:" | Out-Null
    $settingsSheet.Cells.Item(9, 1).Font.Bold = $true
    $settingsSheet.Cells.Item(10, 1).Value2 = "1. CsvPath is the only data source. Change it in the Value column to point at a different CSV."
    $settingsSheet.Cells.Item(11, 1).Value2 = "2. Press Data > Refresh All (Ctrl+Alt+F5) to reread the CSV."
    $settingsSheet.Cells.Item(12, 1).Value2 = "3. Refreshing rereads that file only. It does not fetch new data from NSE."
    $settingsSheet.Cells.Item(13, 1).Value2 = "4. To get newer market data, save a new NSE export over the same file, then Refresh All."
    $settingsSheet.Cells.Item(14, 1).Value2 = "5. Auto-refresh updates data automatically while this workbook remains open."
    $settingsSheet.Columns.AutoFit() | Out-Null

    # 4. Option Chain & Raw Data sheets
    $chainSheet = $wb.Worksheets.Add([System.Type]::Missing, $settingsSheet)
    $chainSheet.Name = "Option Chain"

    $rawSheet = $wb.Worksheets.Add([System.Type]::Missing, $chainSheet)
    $rawSheet.Name = "Raw Data"

    # 5. Queries + connections + tables (replace on refresh, never append)
    Write-Host "[4/5] Creating Power Query connections & data tables..." -ForegroundColor Yellow

    $null = AddOrUpdateQuery $wb "LocalCsvOptionChain" $mChain "Local CSV option chain (filtered by Settings)"
    $null = AddOrUpdateQuery $wb "LocalCsvOptionChainRaw" $mRaw "Local CSV option chain (all rows)"

    $connChain = $wb.Connections.Add2(
        "Query - LocalCsvOptionChain",
        "Connection to LocalCsvOptionChain",
        "OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=\`$Workbook\`$;Location=LocalCsvOptionChain",
        "SELECT * FROM [LocalCsvOptionChain]",
        2
    )
    $connChain.OLEDBConnection.RefreshOnFileOpen = $true
    $connChain.OLEDBConnection.BackgroundQuery = $true
    if ($autoRefresh) {
        $connChain.OLEDBConnection.RefreshPeriod = $refreshMinutes
    }

    $loChain = $chainSheet.ListObjects.Add(0, $connChain, [System.Type]::Missing, 1, $chainSheet.Range("A1"))
    $loChain.Name = "OptionChainTable"
    $loChain.TableStyle = "TableStyleMedium9"
    $loChain.QueryTable.RefreshOnFileOpen = $true
    $loChain.QueryTable.BackgroundQuery = $false
    $loChain.QueryTable.PreserveFormatting = $true
    $loChain.QueryTable.AdjustColumnWidth = $true
    if ($autoRefresh) {
        $loChain.QueryTable.RefreshPeriod = $refreshMinutes
    }
    Write-Host "  Initial read of the local CSV for Option Chain table..." -ForegroundColor Gray
    try {
        $loChain.QueryTable.Refresh($false)
    } catch {
        Write-Warning "Option Chain read notice: $($_.Exception.Message)"
        Write-Host "  The workbook is saved; fix CsvPath on the Settings sheet and Refresh All." -ForegroundColor Yellow
    }

    $connRaw = $wb.Connections.Add2(
        "Query - LocalCsvOptionChainRaw",
        "Connection to LocalCsvOptionChainRaw",
        "OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=\`$Workbook\`$;Location=LocalCsvOptionChainRaw",
        "SELECT * FROM [LocalCsvOptionChainRaw]",
        2
    )
    $connRaw.OLEDBConnection.RefreshOnFileOpen = $true
    $connRaw.OLEDBConnection.BackgroundQuery = $true
    if ($autoRefresh) {
        $connRaw.OLEDBConnection.RefreshPeriod = $refreshMinutes
    }

    $loRaw = $rawSheet.ListObjects.Add(0, $connRaw, [System.Type]::Missing, 1, $rawSheet.Range("A1"))
    $loRaw.Name = "RawDataTable"
    $loRaw.TableStyle = "TableStyleMedium2"
    $loRaw.QueryTable.RefreshOnFileOpen = $true
    $loRaw.QueryTable.BackgroundQuery = $false
    $loRaw.QueryTable.PreserveFormatting = $true
    $loRaw.QueryTable.AdjustColumnWidth = $true
    if ($autoRefresh) {
        $loRaw.QueryTable.RefreshPeriod = $refreshMinutes
    }
    Write-Host "  Initial read of the local CSV for Raw Data table..." -ForegroundColor Gray
    try {
        $loRaw.QueryTable.Refresh($false)
    } catch {
        Write-Warning "Raw Data read notice: $($_.Exception.Message)"
    }

    $loChain.QueryTable.BackgroundQuery = $true
    $loRaw.QueryTable.BackgroundQuery = $true

    # 6. Summary sheet
    Write-Host "[5/5] Building Summary sheet with live formulas..." -ForegroundColor Yellow
    $summarySheet = $wb.Worksheets.Add([System.Type]::Missing, $rawSheet)
    $summarySheet.Name = "Summary"

    $summarySheet.Cells.Item(1, 1).Value2 = "NSE Option Chain - Local CSV Summary"
    $summarySheet.Range("A1:D1").Font.Bold = $true
    $summarySheet.Range("A1:D1").Font.Size = 14

    $summaryEntries = @(
        @("Symbol", "=IFERROR(INDEX(OptionChainTable[symbol],1),""$symbol"")"),
        @("Expiry", "=IFERROR(INDEX(OptionChainTable[expiry],1),""$expiry"")"),
        @("Spot Price", "=IFERROR(INDEX(OptionChainTable[spot],1),""-"")"),
        @("PCR", "=IFERROR(INDEX(OptionChainTable[pcr],1),""-"")"),
        @("Max Pain", "=IFERROR(INDEX(OptionChainTable[max_pain],1),""-"")"),
        @("Total CE OI", "=IFERROR(INDEX(OptionChainTable[total_ce_oi],1),""-"")"),
        @("Total PE OI", "=IFERROR(INDEX(OptionChainTable[total_pe_oi],1),""-"")"),
        @("Source timestamp", "=IFERROR(INDEX(OptionChainTable[nse_timestamp],1),""not in file"")"),
        @("Data source", "Local CSV file"),
        @("Last Refreshed (Local)", "=NOW()"),
        @("CSV file", "$CsvPath")
    )

    for ($i = 0; $i -lt $summaryEntries.Length; $i++) {
        $r = $i + 3
        $summarySheet.Cells.Item($r, 1).Value2 = $summaryEntries[$i][0]
        $summarySheet.Cells.Item($r, 1).Font.Bold = $true
        if ($summaryEntries[$i][1].StartsWith("=")) {
            $summarySheet.Cells.Item($r, 2).Formula = $summaryEntries[$i][1]
        } else {
            $summarySheet.Cells.Item($r, 2).Value2 = $summaryEntries[$i][1]
        }
    }
    $summarySheet.Cells.Item($summaryEntries.Length + 4, 1).Value2 = "This workbook reads a local CSV file. It is not a live NSE feed."
    $summarySheet.Columns.AutoFit() | Out-Null

    # Order sheets: Summary -> Option Chain -> Raw Data -> Settings
    $summarySheet.Move($wb.Worksheets.Item(1))
    $chainSheet.Activate()

    $wb.SaveAs($targetPath, 51)
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "  SETUP SUCCESSFUL!" -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "Workbook saved to: $targetPath" -ForegroundColor White
    Write-Host ""
    Write-Host "Data source: $CsvPath" -ForegroundColor White
    Write-Host "Refreshing rereads that file only; it does not contact NSE." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Sheets created:"
    Write-Host "  - Summary:      Metrics and the CSV source path (live formulas)"
    Write-Host "  - Option Chain: Excel Table loaded from the local CSV"
    Write-Host "  - Raw Data:     Every row of the CSV"
    Write-Host "  - Settings:     Control panel for CsvPath, symbol & expiry"
    Write-Host ""

    if (-not $NonInteractive) {
        Write-Host "Opening workbook in Microsoft Excel..." -ForegroundColor Cyan
        $excel.Visible = $true
        $excel.DisplayAlerts = $true
    } else {
        $wb.Close($false)
    }
} catch {
    Write-Host ""
    Write-Host "[ERROR] Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($wb) {
        try { $wb.Close($false) } catch {}
    }
    if ($excel) {
        try { $excel.Quit() } catch {}
    }
    exit 1
} finally {
    if ($wb -and $NonInteractive) {
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null } catch {}
    }
    if ($excel -and $NonInteractive) {
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
`;
}

export function generateLocalCsvReadme(config: LocalCsvSetupConfig): string {
  return `================================================================================
NSE Option Chain - Local CSV Excel Setup Package (zero-cost workflow)
================================================================================

This package configures Microsoft Excel Desktop on Windows to read an option
chain CSV from a file YOU chose on this computer. There is no web request, no
API URL, no account and no environment-variable setup.

Package Contents:
  - Setup-NSE-Excel.bat   : Double-click launcher
  - Setup-NSE-Excel.ps1   : PowerShell COM automation script
  - config.json           : Your selected settings (includes csvPath if set)
  - README.txt            : This guide

Your selection (changeable later on the Settings sheet):
  - Symbol:   ${config.symbol || "NIFTY"}
  - Expiry:   ${config.expiry || "latest"}
  - CSV path: ${config.csvPath || "(you will be asked on first run)"}

Pre-requisites (be honest with yourself before starting):
  - Microsoft Windows 10 or 11
  - Microsoft Excel Desktop 2016, 2019, 2021, or Microsoft 365 (desktop app;
    Excel for the web and Excel on Mac do not run this COM automation)
  - A CSV exported from the dashboard's "Import NSE CSV" section

First run:
  1. Extract every file from this ZIP into one folder.
  2. Double-click 'Setup-NSE-Excel.bat'.
  3. When prompted, paste the full path to your CSV file, e.g.
       C:\\Users\\you\\Documents\\NIFTY_29-Oct-2026.csv
     The script never invents a path. If you pass none, it stops and says so.
  4. Excel is provisioned with Summary, Option Chain, Raw Data and Settings
     sheets, and the workbook is saved and opened.

What Refresh actually does (important):
  - Data > Refresh All rereads the SAME local CSV file at CsvPath.
  - It does NOT download new data from NSE and does NOT make the data live.
  - To get newer market data, save a new NSE export over the same file (or set
    CsvPath to a new file) and Refresh All.
  - Automatic refresh only re-reads that file on an interval while the workbook
    is open. It is not a market data feed.

Changing contract:
  - Edit the Value column on the Settings sheet (Symbol, Expiry or CsvPath),
    then Refresh All.
  - If the CSV no longer contains the selected symbol/expiry, or its header
    columns changed, the query reports a readable error instead of loading
    wrong data. The previous table stays intact until a valid refresh.

Security & Transparency:
  - No macros or VBA (.xlsm); a standard .xlsx file.
  - No credentials, keys or URLs are embedded. The only source is a local file.
  - The uploaded CSV never leaves your machine via this package.
================================================================================
`;
}

export async function buildLocalCsvSetupZipBlob(
  config: LocalCsvSetupConfig,
): Promise<Blob> {
  const zip = new JSZip();

  const configJson = JSON.stringify(
    {
      source: "local-csv",
      csvPath: config.csvPath || "",
      symbol: config.symbol,
      expiry: config.expiry || "latest",
      refreshMinutes: config.refreshMinutes,
      autoRefresh: config.autoRefresh,
      targetPath: config.targetPath || "",
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );

  zip.file("config.json", configJson);
  zip.file("Setup-NSE-Excel.bat", generateBatchLauncher("local-csv"));
  zip.file("Setup-NSE-Excel.ps1", generateLocalCsvSetupScript(config));
  zip.file("README.txt", generateLocalCsvReadme(config));

  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
