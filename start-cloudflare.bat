@echo off
cd /d "%~dp0"
node scripts\start-local-cloudflare.js
if errorlevel 1 pause
