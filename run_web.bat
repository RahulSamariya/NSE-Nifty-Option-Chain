@echo off
cd /d "%~dp0\web"
echo ========================================================
echo   Starting Next.js NSE Option Chain Web App
echo   Local URL: http://localhost:3000
echo ========================================================
echo.
npm.cmd run dev
pause
