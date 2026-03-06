#!/usr/bin/env bash
# Restart SyncTerm web backend (run on Relay server).
# Example: ssh user@relay 'cd /path/to/app && ./scripts/restart_backend.sh'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"

cd "$APP_ROOT"

if [[ -f backend.pid ]]; then
  old_pid=$(cat backend.pid || true)
  if [[ -n "${old_pid}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Stopping old backend (PID $old_pid)..."
    kill "$old_pid" || true
    sleep 2
  fi
  rm -f backend.pid
fi

if [[ ! -d .venv-backend ]]; then
  echo "ERROR: .venv-backend not found. Run deploy_backend.sh first."
  exit 1
fi

. .venv-backend/bin/activate
nohup uvicorn backend.app.main:app --host 0.0.0.0 --port "$BACKEND_PORT" >> backend.log 2>&1 &
echo $! > backend.pid
echo "Backend restarted (PID $(cat backend.pid), port $BACKEND_PORT). Log: $APP_ROOT/backend.log"
