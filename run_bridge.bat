@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
echo ========================================================
echo   Starting NSE -^> Supabase Cloud Bridge Worker
echo ========================================================
echo.
%PY% bridge_worker.py --symbol NIFTY BANKNIFTY --interval 30 --always
pause
