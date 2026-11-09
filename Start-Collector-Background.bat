@echo off
setlocal
cd /d "%~dp0"
title NSE Collector - Background Starter

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\Start-Collector-Background.ps1" %*

echo.
pause
