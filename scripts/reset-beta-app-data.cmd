@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Piik beta data reset (keeps a backup)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-beta-app-data.ps1"
set "result=%errorlevel%"
echo.
echo Press any key to close.
pause >nul
exit /b %result%
