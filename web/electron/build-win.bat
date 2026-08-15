@echo off
chcp 65001 >nul
REM ============================================================
REM  Omnigent Windows package script
REM  All cache + temp files go to D:\electron-cache (no C: drive)
REM  - ELECTRON_BUILDER_CACHE : electron-builder tool cache
REM  - ELECTRON_CACHE         : @electron/get download cache
REM  - TMP / TEMP             : package temp files
REM ============================================================

set ELECTRON_BUILDER_CACHE=D:\electron-cache
set ELECTRON_CACHE=D:\electron-cache
set TMP=D:\electron-cache\tmp
set TEMP=D:\electron-cache\tmp
set NODE_OPTIONS=--use-system-ca

if not exist "D:\electron-cache" mkdir "D:\electron-cache"
if not exist "D:\electron-cache\tmp" mkdir "D:\electron-cache\tmp"

echo.
echo [1/2] Building frontend web-ui ...
cd /d "%~dp0..\..\web"
call node node_modules\vite\bin\vite.js build
if errorlevel 1 (echo FRONTEND BUILD FAILED & pause & exit /b 1)

echo.
echo [2/2] electron-builder packaging NSIS ...
cd /d "%~dp0"
call npx electron-builder --win nsis
if errorlevel 1 (echo PACKAGE FAILED & pause & exit /b 1)

echo.
echo DONE: %~dp0dist\Omnigent Setup 0.9.1.exe
echo Cache: D:\electron-cache
pause
