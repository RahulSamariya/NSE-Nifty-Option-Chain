@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
echo ========================================================
echo   NSE Excel helper for the web app
echo   http://127.0.0.1:8765
echo ========================================================
echo.
echo Keep this window open while using the Excel button in
echo the web app. It only listens on this PC (127.0.0.1).
echo.
%PY% excel_server.py %*
pause
