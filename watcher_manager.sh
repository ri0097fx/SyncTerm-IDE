#!/usr/bin/env bash
# watcher_manager.sh (Fixed: Prevent Push from deleting staged files)
# - Step 1 (Push) で .staged_uploads 等を除外設定に追加

set -euo pipefail
shopt -s nullglob

# ===== 引数処理 =====
WATCHER_ID="${1:?引数1: WatcherのユニークIDを指定してください}"
DISPLAY_NAME="${2:?引数2: GUIに表示するWatcher名を指定してください}"

WATCHER_ID="${WATCHER_ID%.json}"
WATCHER_ID="${WATCHER_ID//\//_}"
WATCHER_ID="${WATCHER_ID//\\/_}"

# ===== 設定ファイル読み込み =====
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.ini"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[ERROR] 設定ファイルが見つかりません: $CONFIG_FILE" >&2
  exit 1
fi

getv() {
  awk -F= -v k="$1" '
    $0 ~ "^[[:space:]]*"k"[[:space:]]*=" {
      sub(/^[[:space:]]*[^=]+=[[:space:]]*/, "", $0);
      sub(/^[[:space:]]+/, "", $0);
      sub(/[[:space:]]+$/, "", $0);
      print $0; exit
    }' "$CONFIG_FILE"
  return 0
}

SERVER="$(getv server)"
BASE_REMOTE_ROOT="$(getv base_path)"
SESSIONS_DIR_NAME="$(getv sessions_dir_name)"; : "${SESSIONS_DIR_NAME:=sessions}"
REGISTRY_DIR_NAME="$(getv registry_dir_name)"; : "${REGISTRY_DIR_NAME:=_registry}"
WATCHER_MIRROR_DIR_RAW="$(getv watcher_mirror_dir)"

# --- Docker Config ---
DOCKER_CONTAINER_NAME="$(getv docker_container_name)"
DOCKER_IMAGE_NAME="$(getv docker_image_name)"
DOCKER_WORK_DIR="$(getv docker_work_dir)"; : "${DOCKER_WORK_DIR:=/workspace}"

: "${SERVER:?server が config.ini に必要です}"
: "${BASE_REMOTE_ROOT:?base_path が config.ini に必要です}"

# ===== パス構築 =====
BASE_REMOTE="$BASE_REMOTE_ROOT/$SESSIONS_DIR_NAME"
REMOTE_WATCHER_DIR="$BASE_REMOTE/$WATCHER_ID"
REMOTE_REGISTRY_DIR="$BASE_REMOTE_ROOT/$REGISTRY_DIR_NAME"

WATCHER_MIRROR_DIR="${WATCHER_MIRROR_DIR_RAW/#\~/$HOME}"
LOCAL_BASE="${WATCHER_LOCAL_DIR:-${WATCHER_MIRROR_DIR:-$HOME/watcher_local_mirror}}"
LOCAL_SESSIONS_ROOT="$LOCAL_BASE/$SESSIONS_DIR_NAME"
LOCAL_WATCHER_DIR="$LOCAL_SESSIONS_ROOT/$WATCHER_ID"
LOCAL_REGISTRY_DIR="$LOCAL_BASE/$REGISTRY_DIR_NAME"

# ===== SSH / rsync 設定 =====
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-10}"
INTERVAL="${INTERVAL:-5}"

rsync_push() {
  rsync -az --timeout="$RSYNC_TIMEOUT" -e "ssh $SSH_OPTS" "$@"
}
rsync_pull() {
  rsync -az --timeout="$RSYNC_TIMEOUT" -e "ssh $SSH_OPTS" "$@"
}

retry() {
  local max="${RETRY_MAX:-5}" delay="${RETRY_DELAY:-2}" n=1 rc
  while :; do
    set +e
    "$@"; rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then return 0; fi
    echo "[WARN] command failed (rc=$rc), try $n/$max: $*" >&2
    if [[ "$n" -ge "$max" ]]; then
      echo "[WARN] giving up: $*" >&2
      return "$rc"
    fi
    sleep "$delay"
    ((n++))
  done
}
run_nofail() { retry "$@" || echo "[ERROR] Command failed but continuing: $*" >&2; }

# ===== プロセス管理 =====
WATCHER_SCRIPT_PATH="$SCRIPT_DIR/command_watcher.py"
PID_DIR="/tmp/watcher_pids_${WATCHER_ID}"

start_watcher_process() {
  local session="$1"
  local session_dir_local="$LOCAL_WATCHER_DIR/$session"
  local pid_file="$PID_DIR/$session.pid"

  mkdir -p "$session_dir_local"
  echo "[MANAGER] Starting watcher process for session '${session}'..."

  (
    COMMANDS_DIR="$session_dir_local" \
    REMOTE_SESSIONS_ROOT="$BASE_REMOTE" \
    REGISTRY_DIR_NAME="$REGISTRY_DIR_NAME" \
    DOCKER_CONTAINER_NAME="$DOCKER_CONTAINER_NAME" \
    DOCKER_IMAGE_NAME="$DOCKER_IMAGE_NAME" \
    DOCKER_WORK_DIR="$DOCKER_WORK_DIR" \
    nohup python3 "$WATCHER_SCRIPT_PATH" \
      --name "$DISPLAY_NAME" \
      >> "/tmp/watcher_${WATCHER_ID}_${session}.log" 2>&1 &
    echo $! > "$pid_file"
  )
}

stop_watcher_process() {
  local session="$1"
  local pid_file="$PID_DIR/$session.pid"
  [[ -f "$pid_file" ]] || return 0

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]]; then
    echo "[MANAGER] Stopping process for session '${session}' (PID $pid)..."
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

cleanup() {
  echo -e "\n[MANAGER] Cleaning up..."
  if [[ -d "$PID_DIR" ]]; then
    for pf in "$PID_DIR"/*.pid; do
      [[ -f "$pf" ]] || continue
      stop_watcher_process "$(basename "$pf" .pid)"
    done
    rm -rf "$PID_DIR"
  fi
  rm -f "$LOCAL_REGISTRY_DIR/${WATCHER_ID}.json" || true
  run_nofail ssh $SSH_OPTS "$SERVER" "rm -f '$REMOTE_REGISTRY_DIR/${WATCHER_ID}.json'"
  echo "[MANAGER] Cleanup finished."
}
trap cleanup EXIT

# ===== 初期化 =====
echo "[MANAGER] Started for WATCHER_ID='${WATCHER_ID}'  DISPLAY_NAME='${DISPLAY_NAME}'"
mkdir -p "$LOCAL_WATCHER_DIR" "$LOCAL_REGISTRY_DIR" "$PID_DIR"
run_nofail ssh $SSH_OPTS "$SERVER" "mkdir -p '$REMOTE_WATCHER_DIR' '$REMOTE_REGISTRY_DIR'"

# ===== メインループ =====
while true; do
  # --- Step 0: Heartbeat ---
  now_sec=$(date +%s)
  display_escaped=${DISPLAY_NAME//\"/\\\"}
  json_path="$LOCAL_REGISTRY_DIR/${WATCHER_ID}.json"
  printf '{"watcher_id":"%s","display_name":"%s","last_heartbeat":%s}\n' \
    "$WATCHER_ID" "$display_escaped" "$now_sec" > "$json_path"

  run_nofail rsync_push "$json_path" "$SERVER:$REMOTE_REGISTRY_DIR/"

  # --- Step 1: セッションを push（commands.txt などは除外） ---
  # ★ 修正: GUIから送られるファイル群を push時の削除対象から除外する
  echo "[MANAGER] Syncing sessions to server..."
  run_nofail rsync_push --delete\
    --exclude '*/commands.txt' \
    --exclude '*/.runner_config.json' \
    --exclude '*/.staged_uploads/' \
    --exclude '*/.staged_uploads/**' \
    "$LOCAL_WATCHER_DIR/" "$SERVER:$REMOTE_WATCHER_DIR/"

  # --- Step 2: commands.txt & config & uploads を pull ---
  echo "[MANAGER] Pulling commands & configs from server..."
  run_nofail rsync_pull \
    --include '*/' \
    --include '*/commands.txt' \
    --include '*/.runner_config.json' \
    --include '*/.docker_images.txt' \
    --include '*/.docker_containers.txt' \
    --include '*/.staged_uploads/' \
    --include '*/.staged_uploads/**' \
    --exclude '*' \
    "$SERVER:$REMOTE_WATCHER_DIR/" "$LOCAL_WATCHER_DIR/"

  # --- Step 3: プロセス管理 ---
  # echo "[MANAGER] Managing watcher processes..."
  server_sessions=$(find "$LOCAL_WATCHER_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null || true)

  for session in $server_sessions; do
    pid_file="$PID_DIR/$session.pid"
    [[ -f "$pid_file" ]] || start_watcher_process "$session"
  done

  if [[ -d "$PID_DIR" ]] && [[ -n "$(ls -A "$PID_DIR" 2>/dev/null || true)" ]]; then
    for pf in "$PID_DIR"/*.pid; do
      [[ -f "$pf" ]] || continue
      sess="$(basename "$pf" .pid)"
      if ! echo "$server_sessions" | grep -qx "$sess"; then
        stop_watcher_process "$sess"
      fi
    done
  fi

  sleep "$INTERVAL"
done
