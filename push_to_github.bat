@echo off
cd /d "%~dp0"
echo ========================================================
echo   Pushing NSE Option Chain (All Branches) to GitHub
echo ========================================================
echo.
git push -u origin --all
echo.
if errorlevel 0 (
  echo Successfully pushed all branches to https://github.com/RahulSamariya/NSE-Nifty-Option-Chain
) else (
  echo Push failed. Please check your internet or GitHub login.
)
echo.
pause
