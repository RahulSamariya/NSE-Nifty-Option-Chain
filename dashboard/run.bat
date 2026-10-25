@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
%PY% -m streamlit run app.py
pause
