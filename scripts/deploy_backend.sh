#!/usr/bin/env bash
set -euo pipefail

# Deploy and start SyncTerm web backend on relay server.
#
# Usage:
#   ./scripts/deploy_backend.sh user@relay.example.com
#   ./scripts/deploy_backend.sh user@relay.example.com /path/on/relay 8000
#
# Args:
#   1) SSH target (required): user@host
#   2) Remote app dir (optional). 省略時: config.ini の deploy_dir → リレー上で backend_port を監視しているプロセスの cwd → ~/SyncTerm-IDE
#   3) Backend port (optional, default: 8000)

TARGET="${1:-}"
BACKEND_PORT="${3:-8000}"
BACKEND_HOST="${TARGET#*@}"

# REMOTE_DIR: use 2nd arg, or config.ini deploy_dir, or リレー上でバックエンドが動いているディレクトリを検出, or default
if [[ -n "${2:-}" ]]; then
  REMOTE_DIR="$2"
  echo "Using remote_dir from argument: $REMOTE_DIR"
else
  REMOTE_DIR=""
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
  if [[ -z "$REMOTE_DIR" ]] && [[ -n "$TARGET" ]]; then
    # リレー上で BACKEND_PORT を監視しているプロセスの cwd をデプロイ先にする（動いているコードと一致させる）
    DISCOVERED=$(ssh "$TARGET" "pid=\$(lsof -i :$BACKEND_PORT -t 2>/dev/null | head -1); if [ -n \"\$pid\" ]; then readlink -f /proc/\$pid/cwd 2>/dev/null; fi" 2>/dev/null) || true
    # "(deleted)" 付き（削除済みディレクトリを参照しているプロセス）は無効とみなして使わない
    if [[ -n "$DISCOVERED" ]] && [[ "$DISCOVERED" != *" (deleted)"* ]]; then
      REMOTE_DIR="$DISCOVERED"
      echo "Using backend process cwd on relay (port $BACKEND_PORT): $REMOTE_DIR"
    fi
  fi
  if [[ -z "$REMOTE_DIR" ]]; then
    REMOTE_DIR="~/SyncTerm-IDE"
    echo "Using default remote_dir: $REMOTE_DIR"
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

# リモートパスにスペース等が含まれる場合に備え、rsync/ssh 用にシングルクォートで囲む
rempath_quoted() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

echo "[1/5] Sync backend to server: $TARGET:$REMOTE_DIR_ABS"
rsync -az \
  --delete \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  "./backend/" "$TARGET:$(rempath_quoted "$REMOTE_DIR_ABS")/backend/"

echo "[2/5] Sync runtime scripts and config"
rsync -az "./config.ini" "$TARGET:$(rempath_quoted "$REMOTE_DIR_ABS")/config.ini"
rsync -az "./watcher_manager_rt.sh" "$TARGET:$(rempath_quoted "$REMOTE_DIR_ABS")/watcher_manager_rt.sh"
rsync -az --delete "./scripts/" "$TARGET:$(rempath_quoted "$REMOTE_DIR_ABS")/scripts/"

echo "[2b/5] Create sessions, _registry under app root on remote"
ssh "$TARGET" "bash -lc 'cd $(rempath_quoted "$REMOTE_DIR_ABS") && python3 scripts/ensure_base_path.py'"

echo "[3/5] Create venv and install dependencies"
ssh "$TARGET" "bash -lc '
set -euo pipefail
cd $(rempath_quoted "$REMOTE_DIR_ABS")
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
cd $(rempath_quoted "$REMOTE_DIR_ABS")
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
printf '  ssh %s "tail -f %s/backend.log"\n' "$TARGET" "$REMOTE_DIR_ABS"

