@echo off
setlocal
cd /d "%~dp0"
title NSE Option Chain - Excel Setup Utility

echo ================================================================
echo   NSE Option Chain - Desktop Excel Automated Setup
echo ================================================================
echo.
echo Configuring Microsoft Excel with live hosted option chain data...
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
