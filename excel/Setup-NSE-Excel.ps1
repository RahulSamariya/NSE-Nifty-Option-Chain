# ==============================================================================
# NSE Option Chain - Desktop Excel Automated Setup Script
# ==============================================================================
# This script provisions a fresh, reusable Microsoft Excel workbook with
# live Power Query connections to your hosted NSE Option Chain API.
# ==============================================================================

[CmdletBinding()]
param(
    [string]$TargetWorkbookPath = "",
    [switch]$NonInteractive = $false,
    # Developers running the web app locally may accept a localhost baseUrl.
    [switch]$AllowLocalhost = $false
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
if (-not (Test-Path $configFile)) {
    $configFile = Join-Path $PSScriptRoot "config.template.json"
}

$rawConfig = $null
if (Test-Path $configFile) {
    try {
        $rawConfig = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $baseUrl = if ($rawConfig.baseUrl) { $rawConfig.baseUrl.TrimEnd("/") } else { $null }
        $symbol = if ($rawConfig.symbol) { $rawConfig.symbol.ToUpper() } else { "NIFTY" }
        $expiry = if ($rawConfig.expiry) { $rawConfig.expiry } else { "latest" }
        $strikeRange = if ($rawConfig.strikeRange) { $rawConfig.strikeRange } else { "all" }
        $fields = if ($rawConfig.fields) { $rawConfig.fields } else { "all" }
        $refreshMinutes = if ($rawConfig.refreshMinutes) { [int]$rawConfig.refreshMinutes } else { 5 }
        $autoRefresh = if ($null -ne $rawConfig.autoRefresh) { [bool]$rawConfig.autoRefresh } else { $true }
    } catch {
        Write-Warning "Could not parse configuration file, using defaults."
        $baseUrl = $null
        $symbol = "NIFTY"
        $expiry = "latest"
        $strikeRange = "all"
        $fields = "all"
        $refreshMinutes = 5
        $autoRefresh = $true
    }
} else {
    $baseUrl = $null
    $symbol = "NIFTY"
    $expiry = "latest"
    $strikeRange = "all"
    $fields = "all"
    $refreshMinutes = 5
    $autoRefresh = $true
}

# The API base URL must be explicit. Never silently fall back to localhost:
# a workbook provisioned against a stale local server would look "configured"
# while serving nothing useful once shared or moved to another machine.
if (-not $baseUrl -or $baseUrl -match '^https?://(localhost|127\.0\.0\.1)(:|$)') {
    Write-Host "[ERROR] No hosted API base URL is configured." -ForegroundColor Red
    Write-Host "  The setup package downloaded from the website ships a config.json" -ForegroundColor Yellow
    Write-Host "  that already contains the hosted API URL. Re-run the .bat that came" -ForegroundColor Yellow
    Write-Host "  with the downloaded package, or edit config.json (or config.template.json" -ForegroundColor Yellow
    Write-Host "  if you are running from the repository) next to this script and set" -ForegroundColor Yellow
    Write-Host "  baseUrl to your hosted site, e.g.:" -ForegroundColor Yellow
    Write-Host "    { `"baseUrl`": `"https://your-hosted-domain.com`" }" -ForegroundColor White
    Write-Host "  A local http://localhost:3000 target is only for developers running" -ForegroundColor Yellow
    Write-Host "  the web app on this same machine; pass -AllowLocalhost to accept it." -ForegroundColor Yellow
    if (-not $AllowLocalhost) {
        exit 1
    }
    Write-Host "  -AllowLocalhost supplied: continuing with the local target." -ForegroundColor Yellow
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
        "OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=`$Workbook`$;Location=NseOptionChain",
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
        "OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=`$Workbook`$;Location=NseOptionChainRaw",
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

    # Re-enable asynchronous background queries for ongoing usage
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
    Write-Host "  - Summary:      Key snapshot metrics and timestamps (live formula formulas)"
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
