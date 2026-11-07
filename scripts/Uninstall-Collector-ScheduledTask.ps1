#Requires -Version 5.1
<#
.SYNOPSIS
    Removes the "NSE Option Chain Live Collector" scheduled task.

.DESCRIPTION
    Unregisters exactly one task, identified by its exact name. No wildcard is
    used and no other Windows task is touched. If the task is not registered
    the script reports that and exits 0 (safe to run repeatedly).

.PARAMETER TaskName
    Name of the task to remove. Defaults to "NSE Option Chain Live Collector".

.PARAMETER Force
    Remove the task without asking for confirmation.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\Uninstall-Collector-ScheduledTask.ps1 -Force
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'NSE Option Chain Live Collector',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[*] Task '$TaskName' is not registered - nothing to remove."
    exit 0
}

if ($Force -or $PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    $stillThere = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($stillThere) {
        Write-Host "[!] Task '$TaskName' is still present after removal."
        exit 1
    }
    Write-Host "[OK] Removed scheduled task '$TaskName'. No other task was touched."
}

exit 0
