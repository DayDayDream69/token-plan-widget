@echo off
chcp 65001 >nul
REM ============================================
REM  Token Plan desktop widget launcher
REM  Double-click to start the widget.
REM  The widget stays in the tray (right-click the
REM  tray icon to quit).
REM ============================================

setlocal

set "APP_DIR=C:\Users\cheny\WorkBuddy\2026-11-12-09-05-38\token-plan-widget"
set "ELECTRON=%APP_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto :missing

REM Some hosts export ELECTRON_RUN_AS_NODE=1, which makes Electron run as plain
REM Node with no window. Clear it so the GUI starts. This must be a standalone
REM line (chaining with && does not apply it reliably).
set "ELECTRON_RUN_AS_NODE="

cd /d "%APP_DIR%"

REM Hand off to Electron and return immediately; the widget outlives this shell.
start "" /b "%ELECTRON%" .

exit /b 0

:missing
echo [ERROR] Electron runtime not found:
echo   %ELECTRON%
echo.
echo Run "npm install" in: %APP_DIR%
echo.
pause
exit /b 1
