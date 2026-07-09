@echo off
setlocal EnableExtensions

cd /d "%~dp0" || exit /b 1

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "LOG_FILE=log.txt"

echo ============================ >> "%LOG_FILE%"
echo [%date% %time%] Auto price sync started >> "%LOG_FILE%"

"%NODE_EXE%" sync-prices.js >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [%date% %time%] ERROR: sync-prices.js failed with exit code %EXIT_CODE% >> "%LOG_FILE%"
)

exit /b %EXIT_CODE%
