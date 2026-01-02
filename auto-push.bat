@echo off
cd /d "C:\Users\farid\Desktop\myProjects\price-api-server"

REM === ENV (ДО Node) ===
set FTP_HOST=192.168.7.108
set FTP_USER=farid_gold
set FTP_PASS=FaridGold2025#

REM === Обновление прайса ===
node update-price.js >> log.txt 2>&1
IF %ERRORLEVEL% NEQ 0 exit /b

REM === Git push ===
git add cached_prices.json farid_gold.xml >> log.txt 2>&1
git commit -m "Auto price update" >> log.txt 2>&1
git push origin main >> log.txt 2>&1

echo %date% %time% >> log.txt
echo Done >> log.txt
