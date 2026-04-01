#!/usr/bin/env bash
set -euo pipefail

# Deploy and start SyncTerm web backend on relay server.
#
# Usage:
#   ./scripts/deploy_backend.sh user@relay.example.com
#   ./scripts/deploy_backend.sh user@relay.example.com /path/on/relay 8000
#   ./scripts/deploy_backend.sh user@relay.example.com --setup-ollama    # デプロイ後に Relay 上で Ollama をインストール・起動・モデル pull
#   ./scripts/deploy_backend.sh user@relay.example.com --setup-train     # Relay 上に Buddy 学習用 .venv-train を構築
#   ./scripts/deploy_backend.sh user@relay.example.com --setup-browser   # Relay 上にブラウザ調査用 .venv-browser を構築
#
# Args:
#   1) SSH target (required): user@host
#   2) Remote app dir (optional). 省略時: config.ini の deploy_dir → リレー上で backend_port を監視しているプロセスの cwd → ~/SyncTerm-IDE
#   3) Backend port (optional, default: 8000)
#   --setup-ollama   Relay 上で Ollama のインストール・ollama serve 起動・config.ini の ollama_model を pull（任意）
#   --setup-train    Relay 上で Buddy 学習用の Python 環境 (.venv-train) を構築（任意）
#   --setup-browser  Relay 上でブラウザ調査用の Python 環境 (.venv-browser + Playwright) を構築（任意）
#
# AI (Ollama): リモートの config.ini に [ai] を追加すると、Ollama の URL/モデル等を指定可能。
# 例: ollama_base_url = http://127.0.0.1:11434, ollama_model = qwen2.5-coder:7b

SETUP_OLLAMA="${SETUP_OLLAMA:-0}"
SETUP_TRAIN="${SETUP_TRAIN:-0}"
SETUP_BROWSER="${SETUP_BROWSER:-0}"
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--setup-ollama" ]]; then
    SETUP_OLLAMA=1
  elif [[ "$a" == "--setup-train" ]]; then
    SETUP_TRAIN=1
  elif [[ "$a" == "--setup-browser" ]]; then
    SETUP_BROWSER=1
  else
    ARGS+=("$a")
  fi
done

TARGET="${ARGS[0]:-}"
REMOTE_ARG="${ARGS[1]:-}"
BACKEND_PORT="${ARGS[2]:-8000}"
BACKEND_HOST="${TARGET#*@}"

# If TARGET is omitted, try config.ini [remote] server.
if [[ -z "${TARGET:-}" ]] && [[ -f "config.ini" ]]; then
  CFG_SERVER=$(python3 -c "
import configparser
c = configparser.ConfigParser()
c.read('config.ini')
if c.has_section('remote') and c.has_option('remote', 'server'):
    print(c.get('remote', 'server').strip())
" 2>/dev/null || true)
  if [[ -n "${CFG_SERVER:-}" ]]; then
    TARGET="$CFG_SERVER"
    echo "Using relay server from config.ini: $TARGET"
  fi
fi

# Recompute BACKEND_HOST after possible TARGET update
BACKEND_HOST="${TARGET#*@}"

# REMOTE_DIR: use 2nd arg, or config.ini deploy_dir, or リレー上でバックエンドが動いているディレクトリを検出, or default
if [[ -n "${REMOTE_ARG:-}" ]]; then
  REMOTE_DIR="$REMOTE_ARG"
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
  echo "Usage: $0 <user@host> [remote_dir] [backend_port] [--setup-ollama] [--setup-train] [--setup-browser]"
  echo "  (If omitted, tries config.ini [remote] server.)"
  echo "  remote_dir: optional; default from config.ini [remote] deploy_dir, else ~/SyncTerm-IDE"
  echo "  --setup-ollama: optional; on Relay install Ollama, start ollama serve, pull config.ini [ai] ollama_model"
  echo "  --setup-train: optional; on Relay create .venv-train and install backend/training/requirements.txt"
  echo "  --setup-browser: optional; on Relay create .venv-browser and install Playwright + Chromium"
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

if [[ "$SETUP_OLLAMA" -eq 1 ]]; then
  echo "[2c/5] Setup Ollama on Relay (install / ollama serve / model pull)"
  ssh "$TARGET" "bash -lc 'cd $(rempath_quoted "$REMOTE_DIR_ABS") && chmod +x scripts/relay_setup_ollama.sh && bash scripts/relay_setup_ollama.sh .'"
fi

if [[ "$SETUP_TRAIN" -eq 1 ]]; then
  echo "[2d/5] Setup Buddy training environment (.venv-train) on Relay"
  ssh "$TARGET" "bash -lc 'cd $(rempath_quoted "$REMOTE_DIR_ABS") && chmod +x scripts/setup_training_env.sh && bash scripts/setup_training_env.sh .'"
fi

if [[ "$SETUP_BROWSER" -eq 1 ]]; then
  echo "[2e/5] Setup browser research environment (.venv-browser) on Relay"
  ssh "$TARGET" "bash -lc 'cd $(rempath_quoted "$REMOTE_DIR_ABS") && chmod +x scripts/setup_browser_env.sh && bash scripts/setup_browser_env.sh .'"
fi

echo "[3/5] Create venv and install dependencies (may take 1–2 min, please wait)..."
ssh "$TARGET" "bash -lc '
set -euo pipefail
cd $(rempath_quoted "$REMOTE_DIR_ABS")
APP_ROOT=\$(pwd)
REQ_FILE=\"\$APP_ROOT/backend/requirements.txt\"
if [[ ! -f \"\$REQ_FILE\" ]]; then
  echo \"ERROR: \$REQ_FILE not found. Ensure [1/5] sync completed and remote path contains backend/\"
  exit 1
fi
echo \"  Creating .venv-backend...\"
python3 -m venv .venv-backend
. .venv-backend/bin/activate
pip install --upgrade pip -q
echo \"  Installing packages from requirements.txt...\"
pip install -r \"\$REQ_FILE\"
chmod +x watcher_manager_rt.sh scripts/*.sh scripts/wsl/*.sh 2>/dev/null || true
'"

echo "[4/5] Restart backend service"
ssh "$TARGET" "bash -lc '
set -euo pipefail
cd $(rempath_quoted "$REMOTE_DIR_ABS")
# backend.pid のプロセスを停止
if [[ -f backend.pid ]]; then
  old_pid=\$(cat backend.pid || true)
  if [[ -n \"\${old_pid}\" ]] && kill -0 \"\$old_pid\" 2>/dev/null; then
    kill \"\$old_pid\" || true
    sleep 1
  fi
fi
# ポート占有しているプロセスをすべて停止（古い uvicorn が残っていると 405 等になる）
# NOTE: lsof は DNS/サービス名解決で遅くなることがあるので -nP を付ける
if command -v lsof >/dev/null 2>&1; then
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    pids=\$(lsof -nP -iTCP:\"$BACKEND_PORT\" -sTCP:LISTEN -t 2>/dev/null | tr \"\\n\" \" \" | xargs echo -n || true)
    [[ -z \"\$pids\" ]] && break
    echo \"Killing process(es) on port $BACKEND_PORT (attempt \$attempt): \$pids\"
    # まず TERM、残るなら KILL
    kill \$pids 2>/dev/null || true
    sleep 0.7
    still=\$(lsof -nP -iTCP:\"$BACKEND_PORT\" -sTCP:LISTEN -t 2>/dev/null | tr \"\\n\" \" \" | xargs echo -n || true)
    if [[ -n \"\$still\" ]]; then
      echo \"Still listening after TERM, sending KILL: \$still\"
      kill -9 \$still 2>/dev/null || true
      sleep 0.7
    fi
  done
else
  echo \"[WARN] lsof not found on remote; skipping port-kill step\"
fi
sleep 1
. .venv-backend/bin/activate
nohup uvicorn backend.app.main:app --host 0.0.0.0 --port \"$BACKEND_PORT\" > backend.log 2>&1 &
echo \$! > backend.pid
sleep 1
if ! kill -0 \$(cat backend.pid) 2>/dev/null; then
  echo \"[WARN] uvicorn may have exited. Check backend.log:\"
  tail -30 backend.log
  exit 1
fi
'"

echo "[5/5] Done"
echo "Backend URL: http://$BACKEND_HOST:$BACKEND_PORT"
echo ""
echo "Verify file-ops (POST /files) is available:"
echo "  curl -s http://localhost:8002/health   # via tunnel → expect {\"status\":\"ok\",\"file_ops\":true}"
echo "  curl -s -X POST http://localhost:8002/watchers/WID/sessions/SESS/files -H 'Content-Type: application/json' -d '{\"path\":\"x.txt\",\"kind\":\"file\"}'  # 200 = OK, 405 = old backend still running"
echo ""
echo "Tip: Check server log with:"
printf '  ssh %s "tail -f %s/backend.log"\n' "$TARGET" "$REMOTE_DIR_ABS"

