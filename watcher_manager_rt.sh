#!/usr/bin/env bash
# watcher_manager_rt.sh - リバーストンネル版 Watcher マネージャ
# 既存の watcher_manager.sh とは別。RT モード時はコマンドを HTTP で即送信。
#
# 使い方: ./watcher_manager_rt.sh <WATCHER_ID> <DISPLAY_NAME>
# 前提: config.ini の [rt] セクションで rt_enabled=1, rt_port=9001 等を設定

set -euo pipefail
shopt -s nullglob

WATCHER_ID="${1:?引数1: WatcherのユニークIDを指定}"
DISPLAY_NAME="${2:?引数2: GUIに表示するWatcher名を指定}"

WATCHER_ID="${WATCHER_ID%.json}"
WATCHER_ID="${WATCHER_ID//\//_}"
WATCHER_ID="${WATCHER_ID//\\/_}"

# ===== 設定 =====
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.ini"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[ERROR] 設定ファイルが見つかりません: $CONFIG_FILE" >&2
  exit 1
fi

getv() {
  awk -F= -v k="$1" '
    $0 ~ "^[[:space:]]*"k"[[:space:]]*=" {
      sub(/^[[:space:]]*[^=]+=[[:space:]]*/, "", $0);
      sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "");
      print $0; exit
    }' "$CONFIG_FILE"
}
getv_section() {
  awk -F= -v k="$1" -v sec="$2" '
    $0 ~ "^\\[" sec "\\]" { in_sec=1; next }
    in_sec && /^\[/ { in_sec=0 }
    in_sec && $0 ~ "^[[:space:]]*"k"[[:space:]]*=" {
      sub(/^[[:space:]]*[^=]+=[[:space:]]*/, "", $0);
      sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "");
      print $0; exit
    }' "$CONFIG_FILE"
}

SERVER="$(getv server)"
BASE_REMOTE_ROOT="$(getv base_path)"
SESSIONS_DIR_NAME="$(getv sessions_dir_name)"
REGISTRY_DIR_NAME="$(getv registry_dir_name)"
WATCHER_MIRROR_DIR_RAW="$(getv watcher_mirror_dir)"
: "${SESSIONS_DIR_NAME:=sessions}"
: "${REGISTRY_DIR_NAME:=_registry}"

# [rt] セクション（なければデフォルト）
RT_PORT="${RT_PORT:-$(getv_section rt_port rt)}"
RT_PORT="${RT_PORT:-9001}"
BACKEND_PORT="${BACKEND_PORT:-$(getv_section backend_port rt)}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
# relay_local_port: Watcher 側で -L に使うローカルポート（8000 が Cursor 等で使われている場合は 8001 等に）
RELAY_LOCAL_PORT="${RELAY_LOCAL_PORT:-$(getv_section relay_local_port rt)}"
RELAY_LOCAL_PORT="${RELAY_LOCAL_PORT:-8001}"
DOCKER_CONTAINER_NAME="$(getv docker_container_name)"
DOCKER_IMAGE_NAME="$(getv docker_image_name)"
DOCKER_WORK_DIR="$(getv docker_work_dir)"

: "${SERVER:?server が config.ini に必要です}"
: "${BASE_REMOTE_ROOT:?base_path が config.ini に必要です}"

BASE_REMOTE="$BASE_REMOTE_ROOT/$SESSIONS_DIR_NAME"
REMOTE_WATCHER_DIR="$BASE_REMOTE/$WATCHER_ID"
REMOTE_REGISTRY_DIR="$BASE_REMOTE_ROOT/$REGISTRY_DIR_NAME"

WATCHER_MIRROR_DIR="${WATCHER_MIRROR_DIR_RAW/#\~/$HOME}"
LOCAL_BASE="${WATCHER_LOCAL_DIR:-${WATCHER_MIRROR_DIR:-$HOME/watcher_local_mirror}}"
LOCAL_SESSIONS_ROOT="$LOCAL_BASE/$SESSIONS_DIR_NAME"
LOCAL_WATCHER_DIR="$LOCAL_SESSIONS_ROOT/$WATCHER_ID"
LOCAL_REGISTRY_DIR="$LOCAL_BASE/$REGISTRY_DIR_NAME"

SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-10}"
INTERVAL="${INTERVAL:-5}"

rsync_push() { rsync -az --timeout="$RSYNC_TIMEOUT" -e "ssh $SSH_OPTS" "$@"; }
rsync_pull() { rsync -az --timeout="$RSYNC_TIMEOUT" -e "ssh $SSH_OPTS" "$@"; }

retry() {
  local max="${RETRY_MAX:-5}" delay="${RETRY_DELAY:-2}" n=1 rc
  while :; do
    set +e; "$@"; rc=$?; set -e
    [[ $rc -eq 0 ]] && return 0
    echo "[WARN] failed (rc=$rc) try $n/$max: $*" >&2
    [[ $n -ge $max ]] && return $rc
    sleep "$delay"; ((n++))
  done
}
run_nofail() { retry "$@" || echo "[ERROR] $*" >&2; }

# ===== プロセス管理 =====
WATCHER_RT_SCRIPT="$SCRIPT_DIR/scripts/command_watcher_rt.py"
[[ -f "$WATCHER_RT_SCRIPT" ]] || WATCHER_RT_SCRIPT="$SCRIPT_DIR/command_watcher_rt.py"
[[ -f "$WATCHER_RT_SCRIPT" ]] || WATCHER_RT_SCRIPT="$(find "$SCRIPT_DIR" -name "command_watcher_rt.py" -type f 2>/dev/null | head -1)"
: "${WATCHER_RT_SCRIPT:?command_watcher_rt.py が見つかりません}"

PID_DIR="/tmp/watcher_rt_pids_${WATCHER_ID}"
TUNNEL_PID_FILE="$PID_DIR/tunnel.pid"
WATCHER_PID_FILE="$PID_DIR/watcher.pid"

start_tunnel() {
  if [[ -f "$TUNNEL_PID_FILE" ]]; then
    local pid
    pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  echo "[RT] Starting SSH tunnel: -R ${RT_PORT}:localhost:${RT_PORT} -L ${RELAY_LOCAL_PORT}:localhost:${BACKEND_PORT} $SERVER"
  ssh -f -N -R "${RT_PORT}:localhost:${RT_PORT}" -L "${RELAY_LOCAL_PORT}:localhost:${BACKEND_PORT}" $SSH_OPTS "$SERVER" \
    -o ExitOnForwardFailure=yes
  sleep 1
  local tunnel_pid
  tunnel_pid="$(pgrep -f "ssh.*-R ${RT_PORT}:localhost:${RT_PORT}.*${SERVER}" | head -1 || true)"
  if [[ -n "${tunnel_pid:-}" ]]; then
    echo "$tunnel_pid" > "$TUNNEL_PID_FILE"
  fi
}

stop_tunnel() {
  [[ -f "$TUNNEL_PID_FILE" ]] || return 0
  local pid
  pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" 2>/dev/null || true
    rm -f "$TUNNEL_PID_FILE"
  fi
}

start_watcher_rt() {
  if [[ -f "$WATCHER_PID_FILE" ]]; then
    local pid
    pid="$(cat "$WATCHER_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  echo "[RT] Starting command_watcher_rt on port $RT_PORT"
  RT_HTTP_PORT="$RT_PORT" \
  WATCHER_ID="$WATCHER_ID" \
  DISPLAY_NAME="$DISPLAY_NAME" \
  LOCAL_WATCHER_DIR="$LOCAL_WATCHER_DIR" \
  RT_RELAY_LOG_URL="http://127.0.0.1:${RELAY_LOCAL_PORT}" \
  REMOTE_SESSIONS_ROOT="$BASE_REMOTE" \
  REGISTRY_DIR_NAME="$REGISTRY_DIR_NAME" \
  DOCKER_CONTAINER_NAME="${DOCKER_CONTAINER_NAME:-}" \
  DOCKER_IMAGE_NAME="${DOCKER_IMAGE_NAME:-}" \
  DOCKER_WORK_DIR="${DOCKER_WORK_DIR:-/workspace}" \
  nohup python3 "$WATCHER_RT_SCRIPT" >> "/tmp/watcher_rt_${WATCHER_ID}.log" 2>&1 &
  echo $! > "$WATCHER_PID_FILE"
}

stop_watcher_rt() {
  [[ -f "$WATCHER_PID_FILE" ]] || return 0
  local pid
  pid="$(cat "$WATCHER_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" 2>/dev/null || true
    rm -f "$WATCHER_PID_FILE"
  fi
}

cleanup() {
  echo "[RT] Cleaning up..."
  stop_watcher_rt
  stop_tunnel
  rm -f "$LOCAL_REGISTRY_DIR/${WATCHER_ID}.rt_port"
  run_nofail ssh $SSH_OPTS "$SERVER" "rm -f '$REMOTE_REGISTRY_DIR/${WATCHER_ID}.rt_port'" 2>/dev/null || true
  echo "[RT] Done."
}
trap cleanup EXIT

# ===== メイン =====
echo "[RT] Started for WATCHER_ID='${WATCHER_ID}' DISPLAY_NAME='${DISPLAY_NAME}'"
mkdir -p "$LOCAL_WATCHER_DIR" "$LOCAL_REGISTRY_DIR" "$PID_DIR"
run_nofail ssh $SSH_OPTS "$SERVER" "mkdir -p '$REMOTE_WATCHER_DIR' '$REMOTE_REGISTRY_DIR'"

# RT ポートをレジストリに登録（backend が HTTP でコマンド送信するため）
echo "$RT_PORT" > "$LOCAL_REGISTRY_DIR/${WATCHER_ID}.rt_port"
run_nofail rsync_push "$LOCAL_REGISTRY_DIR/${WATCHER_ID}.rt_port" "$SERVER:$REMOTE_REGISTRY_DIR/"

while true; do
  # Heartbeat
  now_sec=$(date +%s)
  printf '{"watcher_id":"%s","display_name":"%s","last_heartbeat":%s}\n' \
    "$WATCHER_ID" "$(echo "$DISPLAY_NAME" | sed 's/"/\\"/g')" "$now_sec" > "$LOCAL_REGISTRY_DIR/${WATCHER_ID}.json"
  run_nofail rsync_push "$LOCAL_REGISTRY_DIR/${WATCHER_ID}.json" "$SERVER:$REMOTE_REGISTRY_DIR/"

  # Rsync: push
  run_nofail rsync_push --delete \
    --exclude '*/commands.txt' \
    --exclude '*/.runner_config.json' \
    --exclude '*/.staged_uploads/' \
    --exclude '*/.staged_uploads/**' \
    "$LOCAL_WATCHER_DIR/" "$SERVER:$REMOTE_WATCHER_DIR/"

  # Rsync: pull
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

  # RT: トンネルと watcher 起動
  start_tunnel
  start_watcher_rt

  sleep "$INTERVAL"
done
