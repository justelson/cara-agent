@echo off
setlocal

set "ROOT=%~dp0"
set "SCRIPT=%ROOT%install.ps1"

if not exist "%SCRIPT%" (
  echo Zyra installer is missing: %SCRIPT%
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
