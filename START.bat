@echo off
title Trifusion Platform v2
color 0B
cd /d "%~dp0"

echo.
echo  ================================================
echo   Trifusion Platform v2
echo  ================================================
echo.

if not exist "node_modules\express" (
  echo  Installing dependencies - please wait...
  npm install
  echo.
)

echo  Starting server...
echo  Open your browser to: http://localhost:3000
echo.
node server.js
