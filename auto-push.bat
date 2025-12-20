@echo off
cd /d "C:\Users\farid\Desktop\myProjects\price-api-server"

REM Обновление прайса
node update-price.js >> log.txt 2>&1

REM Git push
git add . >> log.txt 2>&1
git commit -m "Автообновление прайс-листа" >> log.txt 2>&1
git push origin main >> log.txt 2>&1

echo %date% %time% >> log.txt
echo Обновление завершено. >> log.txt
