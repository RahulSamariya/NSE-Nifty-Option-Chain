@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
echo Logging NIFTY every 60s during market hours. Edit this file to change symbols. Ctrl+C to stop.
%PY% collector.py --symbol NIFTY --interval 60
pause
