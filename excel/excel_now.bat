@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
echo ========================================================
echo   NSE Option Chain -^> Excel (one click)
echo   NIFTY, nearest expiry, FULL chain. No settings.
echo ========================================================
echo.
%PY% excel_auto.py %*
pause
