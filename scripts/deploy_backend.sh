#!/usr/bin/env bash
set -euo pipefail

# Deploy and start SyncTerm web backend on relay server.
#
# Usage:
#   ./scripts/deploy_backend.sh user@relay.example.com
#   ./scripts/deploy_backend.sh user@relay.example.com ~/SyncTerm-IDE 8000
#
# Args:
#   1) SSH target (required): user@host
#   2) Remote app dir (optional, default: ~/SyncTerm-IDE)
#   3) Backend port (optional, default: 8000)

TARGET="${1:-}"
REMOTE_DIR="${2:-~/SyncTerm-IDE}"
BACKEND_PORT="${3:-8000}"
BACKEND_HOST="${TARGET#*@}"

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <user@host> [remote_dir] [backend_port]"
  exit 1
fi

# Common mistake:
#   ./deploy_backend.sh user@host ~/mnt
# expands locally to /Users/<name>/mnt on macOS.
if [[ "$REMOTE_DIR" == /Users/* ]]; then
  echo "ERROR: remote_dir looks like a local macOS path: $REMOTE_DIR"
  echo "If you meant remote home path, quote it:"
  echo "  $0 $TARGET '~/mnt' $BACKEND_PORT"
  exit 2
fi

echo "[0/5] Ensure remote directory exists"
ssh "$TARGET" "bash -lc 'mkdir -p \"$REMOTE_DIR/backend\" \"$REMOTE_DIR/scripts\"'"

echo "[1/5] Sync backend to server: $TARGET:$REMOTE_DIR"
rsync -az \
  --delete \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  "./backend/" "$TARGET:$REMOTE_DIR/backend/"

echo "[2/5] Sync runtime scripts and config"
rsync -az "./config.ini" "$TARGET:$REMOTE_DIR/config.ini"
rsync -az "./watcher_manager.sh" "$TARGET:$REMOTE_DIR/watcher_manager.sh"
rsync -az "./watcher_manager_rt.sh" "$TARGET:$REMOTE_DIR/watcher_manager_rt.sh"
rsync -az "./command_watcher.py" "$TARGET:$REMOTE_DIR/command_watcher.py"
rsync -az --delete "./scripts/" "$TARGET:$REMOTE_DIR/scripts/"

echo "[3/5] Create venv and install dependencies"
ssh "$TARGET" "bash -lc '
set -euo pipefail
mkdir -p \"$REMOTE_DIR\"
cd \"$REMOTE_DIR\"
APP_ROOT=\$(pwd)
REQ_FILE=\"\$APP_ROOT/backend/requirements.txt\"
if [[ ! -f \"\$REQ_FILE\" ]]; then
  echo \"ERROR: \$REQ_FILE not found. Ensure [1/5] sync completed and remote path contains backend/\"
  exit 1
fi
python3 -m venv .venv-backend
. .venv-backend/bin/activate
pip install --upgrade pip >/dev/null
pip install -r \"\$REQ_FILE\"
chmod +x watcher_manager.sh watcher_manager_rt.sh scripts/*.sh scripts/wsl/*.sh 2>/dev/null || true
'"

echo "[4/5] Restart backend service"
ssh "$TARGET" "bash -lc '
set -euo pipefail
cd \"$REMOTE_DIR\"
if [[ -f backend.pid ]]; then
  old_pid=\$(cat backend.pid || true)
  if [[ -n \"\${old_pid}\" ]] && kill -0 \"\$old_pid\" 2>/dev/null; then
    kill \"\$old_pid\" || true
    sleep 1
  fi
fi
. .venv-backend/bin/activate
nohup uvicorn backend.app.main:app --host 0.0.0.0 --port \"$BACKEND_PORT\" > backend.log 2>&1 &
echo \$! > backend.pid
'"

echo "[5/5] Done"
echo "Backend URL: http://$BACKEND_HOST:$BACKEND_PORT"
echo "Tip: Check server log with:"
echo "  ssh $TARGET \"tail -f $REMOTE_DIR/backend.log\""

