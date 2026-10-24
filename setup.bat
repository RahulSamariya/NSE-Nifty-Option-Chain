@echo off
cd /d "%~dp0"
set PY=py
where py >nul 2>nul || set PY=python
where %PY% >nul 2>nul
if errorlevel 1 (
  echo Python not found. Installing Python 3.13 with winget...
  winget install -e --id Python.Python.3.13
  echo.
  echo Python installed. CLOSE this window and run setup.bat again.
  pause
  exit /b
)
%PY% -m pip install -r requirements.txt
if not exist "%USERPROFILE%\.streamlit" mkdir "%USERPROFILE%\.streamlit"
if not exist "%USERPROFILE%\.streamlit\credentials.toml" (
  echo [general]> "%USERPROFILE%\.streamlit\credentials.toml"
  echo email = "">> "%USERPROFILE%\.streamlit\credentials.toml"
)
echo.
echo Setup finished. Double-click run.bat to start the app.
pause
