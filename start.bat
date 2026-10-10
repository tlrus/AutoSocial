@echo off
title AutoSocial Dashboard
cd /d "%~dp0"
echo ===================================================
echo   AutoSocial Studio Dashboard
echo   Starting server at http://127.0.0.1:3000 ...
echo ===================================================
start "" http://127.0.0.1:3000

:loop
call npm start
echo.
echo ===================================================
echo [AutoSocial] Server stopped. Restarting in 3 sec...
echo ===================================================
timeout /t 3 /nobreak >nul
goto loop
