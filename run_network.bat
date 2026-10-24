@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
echo Open  http://YOUR-PC-IP:8501  on a phone/laptop on the same Wi-Fi  (find IP with: ipconfig)
%PY% -m streamlit run app.py --server.address 0.0.0.0
pause
