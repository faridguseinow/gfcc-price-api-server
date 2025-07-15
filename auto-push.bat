@echo off
cd /d "C:\Users\farid\Desktop\САЙТЫ И КОДЫ\price-api-server"
if not exist ".git" (
  echo ❌ Проект не инициализирован как git репозиторий.
  pause
  exit /b
)
git add .
git commit -m "Автообновление %date% %time%"
git push origin main
