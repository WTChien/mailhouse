@echo off
echo [mailhouse] Stopping all uvicorn and vite processes...

powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'python') -and ($_.CommandLine -match 'uvicorn') } | ForEach-Object { cmd /c ('taskkill /PID ' + $_.ProcessId + ' /T /F') | Out-Null; Write-Host ('[mailhouse] Killed uvicorn PID ' + $_.ProcessId) }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'node') -and ($_.CommandLine -match 'vite') } | ForEach-Object { cmd /c ('taskkill /PID ' + $_.ProcessId + ' /T /F') | Out-Null; Write-Host ('[mailhouse] Killed vite PID ' + $_.ProcessId) }"

echo [mailhouse] Done.

