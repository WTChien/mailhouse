@echo off
setlocal
cd /d "%~dp0"

if not exist "%CD%\backend\.venv\Scripts\python.exe" (
  echo [mailhouse] Creating backend virtual environment...
  pushd "%CD%\backend"
  python -m venv .venv
  call ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  popd
)

if not exist "%CD%\frontend\node_modules" (
  echo [mailhouse] Installing frontend dependencies...
  pushd "%CD%\frontend"
  call npm install
  popd
)

set "PYTHON_EXE=%CD%\backend\.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

echo [mailhouse] Clearing any stale backend on port 8000...
powershell -NoProfile -Command "$connections = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue; foreach ($conn in $connections) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo [mailhouse] Starting backend on http://127.0.0.1:8000
pushd "%CD%\backend"
start "mailhouse-backend" /B "%PYTHON_EXE%" -m uvicorn main:app --app-dir "%CD%\backend" --reload --port 8000 --env-file .env
for /f %%i in ('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*main:app*--app-dir*mailhouse\\backend*--reload*--port*8000*' } | Select-Object -First 1 -ExpandProperty ProcessId"') do set "BACKEND_PID=%%i"
popd

echo [mailhouse] Starting frontend on http://127.0.0.1:5173
echo [mailhouse] Press Ctrl+C to stop both services.

pushd "%CD%\frontend"
call npm run dev
set "FRONTEND_EXIT=%ERRORLEVEL%"
popd

echo [mailhouse] Stopping backend...
if defined BACKEND_PID (
  powershell -NoProfile -Command "if (Get-Process -Id %BACKEND_PID% -ErrorAction SilentlyContinue) { Stop-Process -Id %BACKEND_PID% -Force }"
)

exit /b %FRONTEND_EXIT%
