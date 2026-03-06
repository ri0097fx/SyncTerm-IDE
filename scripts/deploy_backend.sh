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
BACKEND_PORT="${3:-8000}"
BACKEND_HOST="${TARGET#*@}"

# REMOTE_DIR: use 2nd arg, or config.ini [remote] deploy_dir, or default
if [[ -n "${2:-}" ]]; then
  REMOTE_DIR="$2"
else
  REMOTE_DIR="~/SyncTerm-IDE"
  if [[ -f "config.ini" ]]; then
    DEPLOY_DIR=$(python3 -c "
import configparser
c = configparser.ConfigParser()
c.read('config.ini')
if c.has_section('remote') and c.has_option('remote', 'deploy_dir'):
    print(c.get('remote', 'deploy_dir').strip())
" 2>/dev/null || true)
    if [[ -n "$DEPLOY_DIR" ]]; then
      REMOTE_DIR="$DEPLOY_DIR"
      echo "Using deploy_dir from config.ini: $REMOTE_DIR"
    fi
  fi
fi

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <user@host> [remote_dir] [backend_port]"
  echo "  remote_dir: optional; default from config.ini [remote] deploy_dir, else ~/SyncTerm-IDE"
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

# Resolve REMOTE_DIR to absolute path on the remote (expand ~ and get real path for rsync)
echo "[0/5] Resolve remote directory to absolute path"
REMOTE_DIR_ABS=$(ssh "$TARGET" "REMOTE_DIR='$(printf '%s' "$REMOTE_DIR" | sed "s/'/'\\\\''/g")'; export REMOTE_DIR; bash -lc 'D=\$(eval echo \"\$REMOTE_DIR\"); mkdir -p \"\$D/backend\" \"\$D/scripts\" && cd \"\$D\" && pwd'" 2>/dev/null) || true
if [[ -z "$REMOTE_DIR_ABS" ]]; then
  echo "WARN: Could not resolve remote path (check SSH and that remote can create the dir), using as-is: $REMOTE_DIR"
  REMOTE_DIR_ABS="$REMOTE_DIR"
fi
echo "Remote deploy path: $REMOTE_DIR_ABS"

echo "[1/5] Sync backend to server: $TARGET:$REMOTE_DIR_ABS"
rsync -az \
  --delete \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  "./backend/" "$TARGET:$REMOTE_DIR_ABS/backend/"

echo "[2/5] Sync runtime scripts and config"
rsync -az "./config.ini" "$TARGET:$REMOTE_DIR_ABS/config.ini"
rsync -az "./watcher_manager_rt.sh" "$TARGET:$REMOTE_DIR_ABS/watcher_manager_rt.sh"
rsync -az --delete "./scripts/" "$TARGET:$REMOTE_DIR_ABS/scripts/"

echo "[2b/5] Create base_path, sessions, _registry on remote (from config.ini)"
ssh "$TARGET" "bash -lc 'cd \"$REMOTE_DIR_ABS\" && python3 scripts/ensure_base_path.py'"

echo "[3/5] Create venv and install dependencies"
ssh "$TARGET" "bash -lc '
set -euo pipefail
cd \"$REMOTE_DIR_ABS\"
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
chmod +x watcher_manager_rt.sh scripts/*.sh scripts/wsl/*.sh 2>/dev/null || true
'"

echo "[4/5] Restart backend service"
ssh "$TARGET" "bash -lc '
set -euo pipefail
cd \"$REMOTE_DIR_ABS\"
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
echo "  ssh $TARGET \"tail -f $REMOTE_DIR_ABS/backend.log\""

