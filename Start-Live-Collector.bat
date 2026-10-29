@echo off
setlocal
cd /d "%~dp0"
title NSE Option Chain - Live Market Data Collector

echo ================================================================
echo   NSE Option Chain - Live Market Data Collector
echo ================================================================
echo.

set PY=
where py >nul 2>nul && set PY=py
if not defined PY (
    where python >nul 2>nul && set PY=python
)

if not defined PY (
    echo [ERROR] Python was not found in your PATH.
    echo Please install Python 3.10+ or add it to your system PATH.
    echo.
    pause
    exit /b 1
)

echo [*] Starting collector (NIFTY, BANKNIFTY, FINNIFTY)...
echo [*] Output is logged to console and logs\collector.log
echo [*] Press Ctrl+C in this window or run Stop-Live-Collector.bat to stop.
echo.

%PY% worker\bridge_worker.py %*

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Collector exited with error code %ERRORLEVEL%.
    echo Please check the error messages above or in logs\collector.log.
    echo.
    pause
)
