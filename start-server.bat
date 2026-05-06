@echo off
chcp 65001 >nul
title yt-dlp bridge server
cd /d "%~dp0"
python server.py
pause
