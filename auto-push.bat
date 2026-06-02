@echo off
setlocal EnableExtensions

cd /d "C:\Users\User\Desktop\PROJECTS\gfcc-price-api-server-main" || exit /b 1

set FTP_HOST=192.168.7.108
set FTP_USER=farid_gold
set FTP_PASS=FaridGold2025#

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "GIT_EXE=C:\Program Files\Git\bin\git.exe"
set "LOG_FILE=log.txt"

echo ============================ >> "%LOG_FILE%"
echo [%date% %time%] Auto price sync started >> "%LOG_FILE%"

REM === Node update ===
"%NODE_EXE%" update-price.js >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR: update-price.js failed >> "%LOG_FILE%"
  exit /b 2
)

REM === Git push ===
"%GIT_EXE%" add cached_prices.json farid_gold.xml >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR: git add failed >> "%LOG_FILE%"
  exit /b 3
)

"%GIT_EXE%" diff --cached --quiet
if not errorlevel 1 (
  echo [%date% %time%] No price changes. Skip commit/push. >> "%LOG_FILE%"
  exit /b 0
)

"%GIT_EXE%" commit -m "server farid_gf price updated" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR: git commit failed >> "%LOG_FILE%"
  exit /b 4
)

"%GIT_EXE%" push origin master >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR: git push failed >> "%LOG_FILE%"
  exit /b 5
)

echo [%date% %time%] OK: pushed to master >> "%LOG_FILE%"
