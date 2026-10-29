@echo off
setlocal
cd /d "%~dp0"
title Stop NSE Live Collector

echo ================================================================
echo   Stopping NSE Live Market Data Collector
echo ================================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$pidFile = Join-Path $PWD '.collector.pid'; $stopFile = Join-Path $PWD '.collector.stop'; if (Test-Path $pidFile) { $pidNum = (Get-Content $pidFile).Trim(); Write-Host ('[*] Found collector process PID: ' + $pidNum); New-Item -ItemType File -Path $stopFile -Force | Out-Null; Write-Host '[*] Sent graceful stop signal. Waiting for clean shutdown...'; for ($i = 0; $i -lt 5; $i++) { Start-Sleep -Seconds 1; if (-not (Get-Process -Id $pidNum -ErrorAction SilentlyContinue)) { Write-Host '[*] Collector process stopped cleanly.'; break; } }; if (Get-Process -Id $pidNum -ErrorAction SilentlyContinue) { Write-Host '[!] Process still running. Terminating...'; Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue; }; Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; Remove-Item $stopFile -Force -ErrorAction SilentlyContinue; } else { Write-Host '[!] No active .collector.pid file found.'; $procs = Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Live Market Data Collector*' }; if ($procs) { Write-Host '[*] Terminating collector process...'; $procs | Stop-Process -Force; Write-Host '[*] Stopped.'; } else { Write-Host '[*] No running collector process was found.'; } }"

echo.
echo [*] Done.
