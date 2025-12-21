@echo off
cd /d "C:\Users\farid\Desktop\myProjects\price-api-server"

REM Обновление прайса
node update-price.js >> log.txt 2>&1

REM Git push
git add . >> log.txt 2>&1
git commit -m "Автообновление прайс-листа" >> log.txt 2>&1
git push origin main >> log.txt 2>&1

set FTP_HOST=192.168.7.108
set FTP_USER=farid_gold
set FTP_PASS=***** 

node update-price.js >> log.txt 2>&1
IF %ERRORLEVEL% NEQ 0 exit /b

echo %date% %time% >> log.txt
echo Обновление завершено. >> log.txt
