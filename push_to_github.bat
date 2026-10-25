@echo off
cd /d "%~dp0"
echo ========================================================
echo   Pushing NSE Option Chain (webapp branch) to GitHub
echo ========================================================
echo.
git push -u origin webapp
echo.
if errorlevel 0 (
  echo Successfully pushed to https://github.com/RahulSamariya/NSE-Nifty-Option-Chain/tree/webapp
) else (
  echo Push failed. Please check your internet or GitHub login.
)
echo.
pause
