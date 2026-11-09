#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the NSE option-chain collector as ONE hidden background process.

.DESCRIPTION
    No console window appears and nothing pops up on screen: the worker runs
    with a hidden window, fetches NIFTY/BANKNIFTY/FINNIFTY only while the
    market calendar says the session is open, and idles (60 s poll) outside
    trading hours. Output goes to logs\collector.log as usual.

    The script is idempotent: if the collector is already running (checked via
    .collector.pid and by scanning for a live worker process) it does nothing.
    It never passes --always, so the worker's market calendar still decides.

    Stop it with Stop-Live-Collector.bat (or this script's -Stop switch).

.PARAMETER PythonPath
    Absolute path of the Python interpreter this repository requires.

.PARAMETER Symbols
    Whitespace- or comma-separated symbols to collect.

.PARAMETER Stop
    Stop a running background collector instead of starting one.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\Start-Collector-Background.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\Start-Collector-Background.ps1 -Stop
#>
[CmdletBinding()]
param(
    [string]$PythonPath = 'C:\Users\rahul\AppData\Local\Programs\Python\Python313\python.exe',
    [string]$Symbols = 'NIFTY BANKNIFTY FINNIFTY',
    [switch]$Stop,
    [int]$WaitSeconds = 6
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $repoRoot '.collector.pid'
$stopFile = Join-Path $repoRoot '.collector.stop'
$logFile = Join-Path $repoRoot 'logs\collector.log'
$workerScript = Join-Path $repoRoot 'worker\bridge_worker.py'

function Get-WorkerProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='python.exe' or Name='pythonw.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*bridge_worker.py*' })
}

function Get-CollectorPid {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $value = 0
    try { $value = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim()) } catch { return $null }
    if (Get-Process -Id $value -ErrorAction SilentlyContinue) { return $value }
    return $null
}

# --- Stop mode -------------------------------------------------------------
if ($Stop) {
    $collectorPid = Get-CollectorPid
    if (-not $collectorPid) {
        $workers = Get-WorkerProcesses
        if ($workers) {
            foreach ($w in $workers) { Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue }
            Write-Host "[OK] Stopped background collector (PID $($workers.ProcessId -join ', '))."
        }
        else {
            Write-Host "[*] No background collector is running."
        }
    }
    else {
        New-Item -ItemType File -Path $stopFile -Force | Out-Null
        for ($i = 0; $i -lt 8; $i++) {
            Start-Sleep -Seconds 1
            if (-not (Get-Process -Id $collectorPid -ErrorAction SilentlyContinue)) { break }
        }
        if (Get-Process -Id $collectorPid -ErrorAction SilentlyContinue) {
            Stop-Process -Id $collectorPid -Force -ErrorAction SilentlyContinue
            Write-Host "[*] Graceful stop timed out; terminated PID $collectorPid."
        }
        else {
            Write-Host "[OK] Collector PID $collectorPid stopped cleanly."
        }
    }
    Remove-Item -LiteralPath $pidFile, $stopFile -Force -ErrorAction SilentlyContinue
    exit 0
}

# --- Start mode ------------------------------------------------------------
if (-not (Test-Path -LiteralPath $workerScript)) {
    throw "worker\bridge_worker.py was not found at '$workerScript'."
}
if (-not (Test-Path -LiteralPath $PythonPath)) {
    throw "The required Python interpreter was not found at '$PythonPath'."
}

$existingPid = Get-CollectorPid
$running = Get-WorkerProcesses
if ($existingPid -or $running) {
    $who = if ($existingPid) { $existingPid } else { ($running.ProcessId -join ', ') }
    Write-Host "[*] Collector already running (PID $who) - nothing to start."
    exit 0
}

$symbolList = @($Symbols -split '[,\s]+' | Where-Object { $_ })
if (-not $symbolList) { throw "No symbols given." }
$argumentList = @('worker\bridge_worker.py', '--symbol') + $symbolList

# -WindowStyle Hidden is what makes this silent: no console ever appears.
$process = Start-Process -FilePath $PythonPath `
    -ArgumentList $argumentList `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Seconds $WaitSeconds

$alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
if (-not $alive) {
    Write-Host "[!] The collector exited immediately. Last log lines:"
    if (Test-Path -LiteralPath $logFile) { Get-Content -LiteralPath $logFile -Tail 8 | ForEach-Object { Write-Host "    $_" } }
    exit 1
}

$hidden = $alive.MainWindowHandle -eq 0
Write-Host "[OK] Background collector started silently."
Write-Host "    PID            : $($alive.Id)   window hidden: $hidden"
Write-Host "    Interpreter    : $PythonPath"
Write-Host "    Arguments      : $($argumentList -join ' ')"
Write-Host "    Working dir    : $repoRoot"
Write-Host "    Collects       : $($symbolList -join ', ') - only while the market calendar says OPEN"
Write-Host "    Log            : $logFile"
Write-Host "    Stop with      : scripts\Start-Collector-Background.ps1 -Stop  (or Stop-Live-Collector.bat)"
exit 0
