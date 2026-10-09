@echo off
rem Installs the Tesla Dashcam Studio companion so it starts at every login (no admin needed).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is missing. Install it: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo ffmpeg is missing. Install it: winget install Gyan.FFmpeg  ^(then open a new window^) & pause & exit /b 1)
node dashcam-companion.js install %*
pause
