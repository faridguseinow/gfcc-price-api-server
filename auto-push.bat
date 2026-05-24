@echo off

cd /d "C:\Users\User\Desktop\PROJECTS\gfcc-price-api-server-main"

set FTP_HOST=192.168.7.108
set FTP_USER=farid_gold
set FTP_PASS=FaridGold2025#

REM === Node update ===
"C:\Program Files\nodejs\node.exe" update-price.js >> log.txt 2>&1
IF %ERRORLEVEL% NEQ 0 exit /b

REM === Git push ===
"C:\Program Files\Git\bin\git.exe" add cached_prices.json farid_gold.xml >> log.txt 2>&1
"C:\Program Files\Git\bin\git.exe" commit -m "server farid_gf price updated" >> log.txt 2>&1
"C:\Program Files\Git\bin\git.exe" push origin master >> log.txt 2>&1

echo %date% %time% >> log.txt
echo Done >> log.txt