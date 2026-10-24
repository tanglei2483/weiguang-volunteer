@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; exit 1"
if not errorlevel 1 (
  echo WeiGuang is already running. Opening http://127.0.0.1:8000 ...
  start "" "http://127.0.0.1:8000"
  exit /b 0
)

set "BUNDLED=%USERPROFILE%\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED%" (
  set "PYTHON=%BUNDLED%"
) else (
  set "PYTHON=python"
)

"%PYTHON%" -c "import sys" >nul 2>&1
if errorlevel 1 (
  echo.
  echo Python 3 was not found. Please install Python 3.10+ or run app.py with your Python interpreter.
  echo.
  pause
  exit /b 1
)

echo.
echo   WeiGuang / 微光
echo   Starting local volunteer platform at http://127.0.0.1:8000
echo   Press Ctrl+C to stop.
echo.

"%PYTHON%" app.py --open
if errorlevel 1 pause
