#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

# Create backend virtual environment if needed
if [[ ! -x "$BACKEND_DIR/.venv/Scripts/python.exe" && ! -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  echo "[mailhouse] Creating backend virtual environment..."
  (
    cd "$BACKEND_DIR"
    python3 -m venv .venv
    if [[ -x ".venv/Scripts/python.exe" ]]; then
      .venv/Scripts/python.exe -m pip install -r requirements.txt
    else
      .venv/bin/python -m pip install -r requirements.txt
    fi
  )
fi

# Install frontend dependencies if needed
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "[mailhouse] Installing frontend dependencies..."
  (
    cd "$FRONTEND_DIR"
    npm install
  )
fi

# Determine Python executable
if [[ -x "$BACKEND_DIR/.venv/Scripts/python.exe" ]]; then
  PYTHON_BIN="$BACKEND_DIR/.venv/Scripts/python.exe"
elif [[ -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"
else
  PYTHON_BIN="python3"
fi

# Kill any existing uvicorn and vite processes
echo "[mailhouse] Killing any existing uvicorn and vite processes..."
pkill -f "uvicorn.*main:app" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1

# Start backend
echo "[mailhouse] Starting backend on http://127.0.0.1:5556"
(
  cd "$BACKEND_DIR"
  "$PYTHON_BIN" -m uvicorn main:app --app-dir "$BACKEND_DIR" --host 127.0.0.1 --port 5556 --env-file .env
) &
BACKEND_PID=$!

# Wait for backend to be ready
echo "[mailhouse] Waiting for backend to be ready..."
for i in {1..20}; do
  if curl -s "http://127.0.0.1:5556/api/health" >/dev/null 2>&1; then
    echo "[mailhouse] Backend is ready!"
    break
  fi
  if [[ $i -eq 20 ]]; then
    echo "[mailhouse] WARNING: Backend did not respond to health check"
  fi
  sleep 0.5
done

# Cleanup handler
cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo
    echo "[mailhouse] Stopping backend..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Start frontend
echo "[mailhouse] Starting frontend on http://127.0.0.1:5555"
echo "[mailhouse] Press Ctrl+C to stop both services."
cd "$FRONTEND_DIR"
npm run dev
FRONTEND_EXIT=$?

exit $FRONTEND_EXIT
