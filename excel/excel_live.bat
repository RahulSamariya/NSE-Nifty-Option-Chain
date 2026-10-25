@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
echo ========================================================
echo   NSE Option Chain -^> Excel  (LIVE, self-refreshing)
echo   NIFTY, nearest expiry, FULL chain. No settings.
echo ========================================================
echo.
%PY% excel_auto.py --live %*
echo.
echo Excel reloads the sheet by itself every minute.
echo You can close this window - updating stops when you
echo close the workbook in Excel.
echo.
pause
