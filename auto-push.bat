@echo off
setlocal EnableExtensions

REM Always run from the directory containing this script, even if the project is moved.
cd /d "%~dp0" || exit /b 1

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "GIT_EXE=C:\Program Files\Git\bin\git.exe"
set "LOG_FILE=log.txt"
set "ENV_FILE=auto-push.env"
set "PUSH_BRANCH=master"
set "PUSH_REMOTE=origin"
set "PUSH_RETRIES=5"
set "RETRY_DELAY_SECONDS=15"

echo ============================ >> "%LOG_FILE%"
echo [%date% %time%] Auto price sync started >> "%LOG_FILE%"

if exist "%ENV_FILE%" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
    if not "%%a"=="" (
      set "%%a=%%b"
    )
  )
)

if not defined FTP_HOST (
  echo [%date% %time%] ERROR: FTP_HOST is not set >> "%LOG_FILE%"
  exit /b 10
)

if not defined FTP_USER (
  echo [%date% %time%] ERROR: FTP_USER is not set >> "%LOG_FILE%"
  exit /b 11
)

if not defined FTP_PASS (
  echo [%date% %time%] ERROR: FTP_PASS is not set >> "%LOG_FILE%"
  exit /b 12
)

for /f "usebackq delims=" %%i in (`"%GIT_EXE%" rev-parse --abbrev-ref HEAD 2^>nul`) do set "CURRENT_BRANCH=%%i"
if not defined CURRENT_BRANCH (
  echo [%date% %time%] ERROR: failed to detect current git branch >> "%LOG_FILE%"
  exit /b 13
)

if /I not "%CURRENT_BRANCH%"=="%PUSH_BRANCH%" (
  echo [%date% %time%] ERROR: current branch is %CURRENT_BRANCH%, expected %PUSH_BRANCH% >> "%LOG_FILE%"
  exit /b 14
)

REM === Refuse to run on a dirty worktree to avoid mixing user edits with auto-sync ===
"%GIT_EXE%" diff --quiet
if errorlevel 1 (
  echo [%date% %time%] ERROR: working tree has unstaged changes; aborting auto sync >> "%LOG_FILE%"
  exit /b 17
)

"%GIT_EXE%" diff --cached --quiet
if errorlevel 1 (
  echo [%date% %time%] ERROR: working tree has staged changes; aborting auto sync >> "%LOG_FILE%"
  exit /b 18
)

REM === Sync with remote before generating a new commit ===
"%GIT_EXE%" fetch "%PUSH_REMOTE%" "%PUSH_BRANCH%" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR: git fetch failed >> "%LOG_FILE%"
  exit /b 15
)

"%GIT_EXE%" pull --rebase "%PUSH_REMOTE%" "%PUSH_BRANCH%" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR: git pull --rebase failed >> "%LOG_FILE%"
  exit /b 16
)

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

set "PUSH_ATTEMPT=1"
:push_retry
echo [%date% %time%] Push attempt %PUSH_ATTEMPT%/%PUSH_RETRIES% >> "%LOG_FILE%"
"%GIT_EXE%" push "%PUSH_REMOTE%" "%PUSH_BRANCH%" >> "%LOG_FILE%" 2>&1
if not errorlevel 1 goto push_ok

if %PUSH_ATTEMPT% GEQ %PUSH_RETRIES% (
  echo [%date% %time%] ERROR: git push failed after %PUSH_RETRIES% attempts >> "%LOG_FILE%"
  exit /b 5
)

echo [%date% %time%] WARN: git push failed, waiting %RETRY_DELAY_SECONDS%s before retry >> "%LOG_FILE%"
timeout /t %RETRY_DELAY_SECONDS% /nobreak >nul
set /a PUSH_ATTEMPT+=1
goto push_retry

:push_ok
echo [%date% %time%] OK: pushed to %PUSH_REMOTE%/%PUSH_BRANCH% >> "%LOG_FILE%"
