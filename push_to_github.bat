@echo off
cd /d "%~dp0"
echo ========================================================
echo   Pushing NSE Option Chain (webapp branch) to GitHub
echo ========================================================
echo.
git push -u origin webapp
echo.
if errorlevel 1 (
  echo Push failed. Please check your internet or GitHub login.
) else (
  echo Successfully pushed to https://github.com/RahulSamariya/NSE-Nifty-Option-Chain/tree/webapp
)
echo.
pause
