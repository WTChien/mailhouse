#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

if [[ ! -x "$BACKEND_DIR/.venv/Scripts/python.exe" && ! -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  echo "[mailhouse] Creating backend virtual environment..."
  (
    cd "$BACKEND_DIR"
    python -m venv .venv
    if [[ -x ".venv/Scripts/python.exe" ]]; then
      .venv/Scripts/python.exe -m pip install -r requirements.txt
    else
      .venv/bin/python -m pip install -r requirements.txt
    fi
  )
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "[mailhouse] Installing frontend dependencies..."
  (
    cd "$FRONTEND_DIR"
    npm install
  )
fi

if [[ -x "$BACKEND_DIR/.venv/Scripts/python.exe" ]]; then
  PYTHON_BIN="$BACKEND_DIR/.venv/Scripts/python.exe"
elif [[ -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"
else
  PYTHON_BIN="python"
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo
    echo "[mailhouse] Stopping backend..."
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[mailhouse] Clearing any stale backend on port 8000..."
if command -v fuser >/dev/null 2>&1; then
  fuser -k 8000/tcp >/dev/null 2>&1 || true
fi

echo "[mailhouse] Starting backend on http://127.0.0.1:8000"
(
  cd "$BACKEND_DIR"
  "$PYTHON_BIN" -m uvicorn main:app --app-dir "$BACKEND_DIR" --reload --port 8000 --env-file .env
) &
BACKEND_PID=$!

echo "[mailhouse] Starting frontend on http://127.0.0.1:5173"
echo "[mailhouse] Press Ctrl+C to stop both services."
cd "$FRONTEND_DIR"
npm run dev
