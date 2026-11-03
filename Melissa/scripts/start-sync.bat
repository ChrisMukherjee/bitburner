@echo off
REM Double-click to sync this folder with Bitburner (keep this window open)
cd /d "%~dp0"
npx bitburner-filesync
pause
