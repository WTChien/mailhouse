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

echo [mailhouse] Killing any existing uvicorn and vite processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'python') -and ($_.CommandLine -match 'uvicorn') } | ForEach-Object { cmd /c ('taskkill /PID ' + $_.ProcessId + ' /T /F') }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'node') -and ($_.CommandLine -match 'vite') } | ForEach-Object { cmd /c ('taskkill /PID ' + $_.ProcessId + ' /T /F') }"

echo [mailhouse] Starting backend on http://127.0.0.1:5556
pushd "%CD%\backend"
start /B "" "%PYTHON_EXE%" -m uvicorn main:app --app-dir "%CD%\backend" --host 127.0.0.1 --port 5556 --env-file .env
popd

echo [mailhouse] Waiting for backend to be ready...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 20;$i++){ try{ $r=Invoke-WebRequest -Uri 'http://127.0.0.1:5556/api/health' -Method Get -UseBasicParsing -ErrorAction Stop; $ok=$true; break } catch { Start-Sleep -Milliseconds 500 } }; if(-not $ok){ Write-Error 'Backend did not start in time' }"

echo [mailhouse] Starting frontend on http://127.0.0.1:5555
echo [mailhouse] Press Ctrl+C to stop both services.

pushd "%CD%\frontend"
call npm run dev
set "FRONTEND_EXIT=%ERRORLEVEL%"
popd

echo [mailhouse] Stopping local services...
call "%CD%\stop.bat"

exit /b %FRONTEND_EXIT%

