@echo off
REM ---------------------------------------------------------------------
REM  KeyCap — one-click launcher
REM ---------------------------------------------------------------------
REM  On first run: installs Node dependencies (requires Node.js 18+).
REM  On every run: starts the overlay server and opens the editor.
REM ---------------------------------------------------------------------

setlocal
cd /d "%~dp0"

REM -- Check Node.js is available ------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is required but was not found on PATH.
  echo     Install from https://nodejs.org/ and retry.
  pause
  exit /b 1
)

REM -- Install dependencies on first run ------------------------------------
if not exist "node_modules\express" (
  echo [setup] Installing dependencies ^(first run^)...
  call npm install
  if errorlevel 1 (
    echo [!] npm install failed.
    pause
    exit /b 1
  )
)

REM -- Open editor in browser after server starts ---------------------------
start "" /min cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8765/editor"

echo.
echo ============================================================
echo   KeyCap
echo   Overlay:  http://127.0.0.1:8765/
echo   Editor:   http://127.0.0.1:8765/editor
echo   Ctrl+C to stop.
echo ============================================================
echo.

node server\index.js

endlocal
