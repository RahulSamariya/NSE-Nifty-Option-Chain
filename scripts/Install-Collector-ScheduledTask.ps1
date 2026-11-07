#Requires -Version 5.1
<#
.SYNOPSIS
    Registers (or updates) the single Windows scheduled task
    "NSE Option Chain Live Collector".

.DESCRIPTION
    The task runs the collector in --once mode every 5 minutes from 09:10 to
    16:00 IST, every day of the week (the worker's own market calendar decides
    whether a run is permitted; on weekends/holidays it exits cleanly).

    Configuration highlights:
      * Action    : <python.exe> worker\bridge_worker.py --once --symbol NIFTY BANKNIFTY FINNIFTY
      * Working dir: repository root
      * Principal : current user, Interactive logon (no stored password)
      * Settings  : MultipleInstances IgnoreNew, StartWhenAvailable,
                    10 minute execution limit, 3 restarts at 2 minute intervals
      * Never uses the testing-mode flag or the bundled daemon batch launcher

    Running the script again replaces the existing task (idempotent).

.PARAMETER TaskName
    Name of the task to register. Defaults to "NSE Option Chain Live Collector".

.PARAMETER PythonPath
    Absolute path of the Python interpreter this repository requires.

.PARAMETER WorkerArgs
    Arguments passed to the interpreter.

.PARAMETER StartTime
    Daily start time, HH:mm (24h, local time = IST on this machine).

.PARAMETER EndTime
    End of the repetition window, HH:mm.

.PARAMETER IntervalMinutes
    Repetition interval in minutes.

.PARAMETER Force
    Replace an existing task without asking for confirmation.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\Install-Collector-ScheduledTask.ps1 -Force
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'NSE Option Chain Live Collector',
    [string]$PythonPath = 'C:\Users\rahul\AppData\Local\Programs\Python\Python313\python.exe',
    [string]$WorkerArgs = 'worker\bridge_worker.py --once --symbol NIFTY BANKNIFTY FINNIFTY',
    [string]$StartTime = '09:10',
    [string]$EndTime = '16:00',
    [int]$IntervalMinutes = 5,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# --- Validate inputs -------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $repoRoot 'worker\bridge_worker.py'
if (-not (Test-Path -LiteralPath $workerScript)) {
    throw "worker\bridge_worker.py was not found at '$workerScript'. Run this script from the repository's scripts\ folder."
}
if (-not (Test-Path -LiteralPath $PythonPath)) {
    throw "The required Python interpreter was not found at '$PythonPath'."
}
if ($WorkerArgs -notmatch '--once') {
    throw "WorkerArgs must contain --once (the scheduled task must never run the long-lived daemon)."
}
if ($WorkerArgs -match '--always') {
    throw "WorkerArgs must not force runs outside the market calendar (testing-mode flag rejected)."
}

$timeFormat = [Globalization.CultureInfo]::InvariantCulture
$startTimeParts = [datetime]::ParseExact($StartTime, 'HH:mm', $timeFormat)
$endTimeParts = [datetime]::ParseExact($EndTime, 'HH:mm', $timeFormat)
$repetition = $endTimeParts - $startTimeParts
if ($repetition.TotalMinutes -le 0) {
    throw "EndTime ($EndTime) must be later than StartTime ($StartTime)."
}

# --- Task definition -------------------------------------------------------
$action = New-ScheduledTaskAction -Execute $PythonPath `
    -Argument $WorkerArgs `
    -WorkingDirectory $repoRoot

# Daily at StartTime with a repeating trigger every IntervalMinutes until
# EndTime. The repetition window is built from a -Once trigger because the
# -Daily trigger does not expose a repetition parameter.
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $startTimeParts
$repeatingTrigger = New-ScheduledTaskTrigger -Once -At $startTimeParts `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration $repetition
$dailyTrigger.Repetition = $repeatingTrigger.Repetition

# Current user, interactive logon context: no password is stored, and the task
# only runs while this user is logged on (which is the machine's normal state).
$principal = New-ScheduledTaskPrincipal `
    -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
    -LogonType Interactive `
    -RunLevel Limited

# IgnoreNew prevents overlapping collector processes when a cycle outlives its
# 5-minute slot; StartWhenAvailable runs a missed trigger after a boot/wake.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 2)

$description = 'NSE option-chain one-shot collector: fetch, validate and upsert ' +
    'NIFTY/BANKNIFTY/FINNIFTY during market hours only (worker market calendar).'

# --- Register (idempotent: replace an existing task with the same name) -----
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($Force -or $PSCmdlet.ShouldProcess($TaskName, 'Replace existing scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[*] Removed existing task '$TaskName' so it can be re-registered."
    }
    else {
        Write-Host "[*] Task '$TaskName' already exists; keeping it (use -Force to replace)."
        $existing | Format-List TaskName, State
        return
    }
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $action `
    -Trigger $dailyTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description $description | Out-Null

# --- Verify the registration ----------------------------------------------
$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host ""
Write-Host "[OK] Task registered and verified:"
Write-Host "    Name          : $($task.TaskName)"
Write-Host "    State         : $($task.State)"
Write-Host "    Execute       : $($task.Actions[0].Execute)"
Write-Host "    Arguments     : $($task.Actions[0].Arguments)"
Write-Host "    Working dir   : $($task.Actions[0].WorkingDirectory)"
Write-Host "    Trigger       : daily at $StartTime, every $IntervalMinutes min until $EndTime (weekends included)"
Write-Host "    Logon type    : $($task.Principal.LogonType) (current user, no stored password)"
Write-Host "    Instances     : $($task.Settings.MultipleInstances) / StartWhenAvailable=$($task.Settings.StartWhenAvailable)"
Write-Host "    Next run time : $($info.NextRunTime)"
Write-Host ""
Write-Host "    Start it once with: schtasks /Run /TN `"$TaskName`""
