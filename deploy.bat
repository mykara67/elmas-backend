@echo off
echo === Render Deploy ===

git status
git add .
git commit -m "auto deploy"
git push origin main

echo === Deploy gönderildi ===
pause
