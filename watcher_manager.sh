#!/usr/bin/env bash
# watcher_manager.sh
# - セッションは「push を先、pull を後」
# - pull は commands.txt のみ（原子的置換）。.commands.offset は Watcher が正：pull しない
# - レジストリは <watcher_id>.json のみ push（--delete 禁止）
# - rsync/ssh は非対話化、ディレクトリは常に末尾 / を付与

set -euo pipefail
shopt -s nullglob

# ===== 引数処理 =====
WATCHER_ID="${1:?引数1: WatcherのユニークIDを指定してください}"
DISPLAY_NAME="${2:?引数2: GUIに表示するWatcherの表示名を指定してください}"

# 誤って "foo.json" が来ても "foo" に矯正。スラッシュ等はアンダースコア化
WATCHER_ID="${WATCHER_ID%.json}"
WATCHER_ID="${WATCHER_ID//\//_}"
WATCHER_ID="${WATCHER_ID//\\/_}"

# ===== 設定ファイル =====
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.ini"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[ERROR] 設定ファイルが見つかりません: $CONFIG_FILE" >&2
  exit 1
fi

# ===== 設定読み込み =====
trim() { sed -E 's/^[[:space:]]+|[[:space:]]+$//g'; }
getv() { grep -E "^$1[[:space:]]*=" "$CONFIG_FILE" | cut -d '=' -f 2- | trim; }

SERVER="$(getv server)"
BASE_REMOTE_ROOT="$(getv base_path)"
SESSIONS_DIR_NAME="$(getv sessions_dir_name)"; : "${SESSIONS_DIR_NAME:=sessions}"
REGISTRY_DIR_NAME="$(getv registry_dir_name)"; : "${REGISTRY_DIR_NAME:=_registry}"
WATCHER_MIRROR_DIR_RAW="$(getv watcher_mirror_dir || true)"

: "${SERVER:?server が config.ini に必要です}"
: "${BASE_REMOTE_ROOT:?base_path が config.ini に必要です}"

# パス構築
BASE_REMOTE="$BASE_REMOTE_ROOT/$SESSIONS_DIR_NAME"            # 例：/home/user/remote_dev/sessions
REMOTE_WATCHER_DIR="$BASE_REMOTE/$WATCHER_ID"                 # 例：.../sessions/<id>
REMOTE_REGISTRY_DIR="$BASE_REMOTE_ROOT/$REGISTRY_DIR_NAME"    # 例：.../_registry

WATCHER_MIRROR_DIR="${WATCHER_MIRROR_DIR_RAW/#\~/$HOME}"
LOCAL_BASE="${WATCHER_LOCAL_DIR:-${WATCHER_MIRROR_DIR:-$HOME/watcher_local_mirror}}"
LOCAL_SESSIONS_ROOT="$LOCAL_BASE/$SESSIONS_DIR_NAME"
LOCAL_WATCHER_DIR="$LOCAL_SESSIONS_ROOT/$WATCHER_ID"
LOCAL_REGISTRY_DIR="$LOCAL_BASE/$REGISTRY_DIR_NAME"

# ===== SSH/rsync オプション =====
RSYNC_SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
RSYNC_PUSH=(rsync -az -e "ssh $RSYNC_SSH_OPTS")                  # push 共通
RSYNC_PULL_CMD=(rsync -az -e "ssh $RSYNC_SSH_OPTS")              # pull（個別フィルタで使う）
INTERVAL="${INTERVAL:-5}"                                        # ループ間隔（秒）

# ===== プロセス管理 =====
WATCHER_SCRIPT_PATH="$SCRIPT_DIR/command_watcher.py"
PID_DIR="/tmp/watcher_pids_${WATCHER_ID}"

start_watcher_process() {
  local session="$1"
  local session_dir_local="$LOCAL_WATCHER_DIR/$session"
  local pid_file="$PID_DIR/$session.pid"
  local register_name="$DISPLAY_NAME"

  mkdir -p "$session_dir_local"
  echo "[MANAGER] Starting watcher process for session '${session}'..."

  (
    COMMANDS_DIR="$session_dir_local" \
    REMOTE_SESSIONS_ROOT="$BASE_REMOTE" \
    REGISTRY_DIR_NAME="$REGISTRY_DIR_NAME" \
    nohup python "$WATCHER_SCRIPT_PATH" --name "$register_name" \
      >> "/tmp/watcher_${WATCHER_ID}_${session}.log" 2>&1 &
    echo $! > "$pid_file"
  )
}

stop_watcher_process() {
  local session="$1"
  local pid_file="$PID_DIR/$session.pid"
  [ -f "$pid_file" ] || return 0
  local pid; pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "${pid:-}" ]; then
    echo "[MANAGER] Stopping process for session '${session}' (PID $pid)..."
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

cleanup() {
  echo -e "\n[MANAGER] Cleaning up..."
  if [ -d "$PID_DIR" ]; then
    for pf in "$PID_DIR"/*.pid; do
      [ -f "$pf" ] || continue
      stop_watcher_process "$(basename "$pf" .pid)"
    done
    rm -rf "$PID_DIR"
  fi
  # レジストリ削除
  rm -f "$LOCAL_REGISTRY_DIR/${WATCHER_ID}.json" || true
  ssh -o BatchMode=yes $SERVER "rm -f '$REMOTE_REGISTRY_DIR/${WATCHER_ID}.json'" || true
  echo "[MANAGER] Cleanup finished."
}
trap cleanup EXIT

# ===== 初期化 =====
echo "[MANAGER] Started for WATCHER_ID='${WATCHER_ID}'  DISPLAY_NAME='${DISPLAY_NAME}'"
mkdir -p "$LOCAL_WATCHER_DIR" "$LOCAL_REGISTRY_DIR" "$PID_DIR"
ssh -o BatchMode=yes $SERVER "mkdir -p '$REMOTE_WATCHER_DIR' '$REMOTE_REGISTRY_DIR'"

# ===== メインループ =====
while true; do
  # --- Step 0: Heartbeat を先に書く（直近の生存を示す） ---
  now_sec=$(date +%s)
  display_escaped=${DISPLAY_NAME//\"/\\\"}
  json_path="$LOCAL_REGISTRY_DIR/${WATCHER_ID}.json"
  printf '{"watcher_id":"%s","display_name":"%s","last_heartbeat":%s}\n' \
    "$WATCHER_ID" "$display_escaped" "$now_sec" > "$json_path"

  # 自分の JSON だけ push（--delete 禁止）
  "${RSYNC_PUSH[@]}" "$json_path" "$SERVER:$REMOTE_REGISTRY_DIR/"

  # --- Step 1: セッションを push（commands.txt は除外、.commands.offset は送る） ---
  echo "[MANAGER] Syncing sessions to server (excluding commands.txt)..."
  "${RSYNC_PUSH[@]}" \
    --exclude '*/commands.txt' \
    "$LOCAL_WATCHER_DIR/" "$SERVER:$REMOTE_WATCHER_DIR/"

  # --- Step 2: commands.txt を pull（原子的に、offset は pull しない） ---
  echo "[MANAGER] Pulling commands.txt from server (atomic replace)..."
  "${RSYNC_PULL_CMD[@]}" \
    --prune-empty-dirs \
    --include '*/' \
    --include '*/commands.txt' \
    --exclude '*' \
    "$SERVER:$REMOTE_WATCHER_DIR/" "$LOCAL_WATCHER_DIR/"

  # --- Step 3: プロセス管理（pull 後に実施） ---
  echo "[MANAGER] Managing watcher processes..."
  # ローカルの <watcher_id> 配下の直下ディレクトリ = セッション名
  server_sessions=$(find "$LOCAL_WATCHER_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null || true)

  # 起動（未起動のもの）
  for session in $server_sessions; do
    pid_file="$PID_DIR/$session.pid"
    if [ ! -f "$pid_file" ]; then
      start_watcher_process "$session"
    fi
  done

  # 停止（ディレクトリが消えたもの）
  if [ -d "$PID_DIR" ] && [ -n "$(ls -A "$PID_DIR" 2>/dev/null || true)" ]; then
    for pf in "$PID_DIR"/*.pid; do
      [ -f "$pf" ] || continue
      sess="$(basename "$pf" .pid)"
      if ! echo "$server_sessions" | grep -qx "$sess"; then
        stop_watcher_process "$sess"
      fi
    done
  fi

  sleep "$INTERVAL"
done
