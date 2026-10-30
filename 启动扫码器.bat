@echo off
chcp 65001 >nul
title 扫码器
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 再运行本程序。
  pause
  exit /b 1
)
node server.js
if errorlevel 1 pause
