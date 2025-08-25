#!/usr/bin/env bash
# watcher_manager.sh (同期機能統合・設定ファイル分離・自己登録対応版)
#
# 変更点（要旨）:
# - 「push を先、pull を後」に変更してローカルの最新ログを保護
# - サーバ→ローカルの同期は -u/--inplace を採用（新しいローカルを上書きしない）
# - rsync/ssh を非対話・安定化 (BatchMode, accept-new)
# - トレーリングスラッシュ等を明示

$1shopt -s nullglob

# ===== 引数処理 =====
WATCHER_ID="${1:?引数1: WatcherのユニークIDを指定してください}"
DISPLAY_NAME="${2:?引数2: GUIに表示するWatcherの基本名(例: 'GPU-Server')を指定してください}"

# ===== 設定ファイルのパス =====
# このスクリプトと同じディレクトリにあるconfig.iniを指す
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.ini"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[ERROR] 設定ファイルが見つかりません: $CONFIG_FILE" >&2
  exit 1
fi

# ===== 設定の読み込み =====
# config.iniから設定を読み込む。`xargs`で前後の空白を除去
SERVER=$(grep -E '^server\s*=' "$CONFIG_FILE" | cut -d '=' -f 2- | xargs)
BASE_REMOTE_ROOT=$(grep -E '^base_path\s*=' "$CONFIG_FILE" | cut -d '=' -f 2- | xargs)
SESSIONS_DIR_NAME=$(grep -E '^sessions_dir_name\s*=' "$CONFIG_FILE" | cut -d '=' -f 2- | xargs)
REGISTRY_DIR_NAME=$(grep -E '^registry_dir_name\s*=' "$CONFIG_FILE" | cut -d '=' -f 2- | xargs)
# Watcherマネージャー専用のミラーパスを読み込む
WATCHER_MIRROR_DIR_RAW=$(grep -E '^watcher_mirror_dir\s*=' "$CONFIG_FILE" | cut -d '=' -f 2- | xargs)

# 必須項目が設定されていなければエラーで終了
: "${SERVER:?serverがconfig.iniに設定されていません}"
: "${BASE_REMOTE_ROOT:?base_pathがconfig.iniに設定されていません}"

# 設定値がなければデフォルト値を割り当て
SESSIONS_DIR_NAME=${SESSIONS_DIR_NAME:-sessions}
REGISTRY_DIR_NAME=${REGISTRY_DIR_NAME:-_registry}

# リモートのフルパスを構築
BASE_REMOTE="$BASE_REMOTE_ROOT/$SESSIONS_DIR_NAME"

# ===== プロセス管理設定 =====
WATCHER_SCRIPT_PATH="$SCRIPT_DIR/command_watcher.py"
INTERVAL=${INTERVAL:-5}   # 同期とプロセスチェックの間隔（秒）。環境変数で上書き可

# ===== ローカルパス設定 =====
# 設定ファイルの '~' を $HOME に置換
WATCHER_MIRROR_DIR="${WATCHER_MIRROR_DIR_RAW/#\~/$HOME}"
# 環境変数 WATCHER_LOCAL_DIR があれば優先し、なければ設定ファイルの値、それもなければデフォルト値を使用
LOCAL_BASE="${WATCHER_LOCAL_DIR:-${WATCHER_MIRROR_DIR:-$HOME/watcher_local_mirror}}"
LOCAL_SESSIONS_ROOT="$LOCAL_BASE/$SESSIONS_DIR_NAME"
PID_DIR="/tmp/watcher_pids_${WATCHER_ID}"

# --- 同期用パス設定 ---
REMOTE_WATCHER_DIR="$BASE_REMOTE/$WATCHER_ID"
LOCAL_WATCHER_DIR="$LOCAL_SESSIONS_ROOT/$WATCHER_ID"

REMOTE_REGISTRY_DIR="$BASE_REMOTE_ROOT/$REGISTRY_DIR_NAME"
LOCAL_REGISTRY_DIR="$LOCAL_BASE/$REGISTRY_DIR_NAME"

# ===== rsync/ssh 共通オプション =====
RSYNC_SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
RSYNC_PUSH=(rsync -az -e "ssh $RSYNC_SSH_OPTS")
RSYNC_PULL_SAFE=(rsync -azvu --inplace -e "ssh $RSYNC_SSH_OPTS")
RSYNC_REG_PUSH=(rsync -az --delete -e "ssh $RSYNC_SSH_OPTS")

# ===== 関数定義 =====
start_watcher_process() {
  local session="$1"
  local session_dir_local="$LOCAL_WATCHER_DIR/$session"
  local pid_file="$PID_DIR/$session.pid"
  local register_name="$DISPLAY_NAME"

  echo "[MANAGER] Starting watcher process for session '$session'..."

  # command_watcher.py にリモートのルートパスとレジストリ名を環境変数で渡す
  (
    COMMANDS_DIR="$session_dir_local" \
    REMOTE_SESSIONS_ROOT="$BASE_REMOTE" \
    REGISTRY_DIR_NAME="$REGISTRY_DIR_NAME" \
    nohup python "$WATCHER_SCRIPT_PATH" --name "$register_name" \
      >> "/tmp/watcher_${WATCHER_ID}_${session}.log" 2>&1 &
    echo $! > "$pid_file"
  )
}

cleanup() {
  echo -e "\n[MANAGER] Cleaning up..."
  if [ -d "$PID_DIR" ]; then
    for pid_file in "$PID_DIR"/*.pid; do
      [ -f "$pid_file" ] || continue
      pid_to_kill=$(cat "$pid_file")
      echo "[MANAGER] Killing process PID $pid_to_kill."
      kill "$pid_to_kill" 2>/dev/null || true
    done
    rm -rf "$PID_DIR"
  fi
  # 登録解除のために、対応するレジストリファイルを削除
  rm -f "$LOCAL_REGISTRY_DIR/$WATCHER_ID"
  # サーバーに最後の状態を同期して削除を反映
  ssh -o BatchMode=yes "$SERVER" "mkdir -p '$REMOTE_REGISTRY_DIR'"
  "${RSYNC_REG_PUSH[@]}" "$LOCAL_REGISTRY_DIR/" "$SERVER:$REMOTE_REGISTRY_DIR/"
  echo "[MANAGER] Cleanup finished."
}
trap cleanup EXIT

# ===== メインループ =====
printf '[MANAGER] Started for WATCHER_ID="%s"\n' "$WATCHER_ID"
# 必要なディレクトリを最初に作成
mkdir -p "$LOCAL_WATCHER_DIR" "$LOCAL_REGISTRY_DIR" "$PID_DIR"

# リモート側の親ディレクトリを用意
ssh -o BatchMode=yes "$SERVER" \
  "mkdir -p '$REMOTE_WATCHER_DIR' '$REMOTE_REGISTRY_DIR'"

while true; do
  # --- ステップ1: まず push（ローカル→サーバ）でログ/変更を失わない ---
  echo "[MANAGER] Syncing to server (sessions/logs first)..."
  "${RSYNC_PUSH[@]}" --exclude '*/commands.txt' "$LOCAL_WATCHER_DIR/" "$SERVER:$REMOTE_WATCHER_DIR/"

  # レジストリは削除反映も必要（ハートビートの古いものを消す）
  "${RSYNC_REG_PUSH[@]}" "$LOCAL_REGISTRY_DIR/" "$SERVER:$REMOTE_REGISTRY_DIR/"

  # --- ステップ2: 同期後の状態でプロセスを管理 ---
  echo "[MANAGER] Managing processes..."
  server_sessions=$(find "$LOCAL_WATCHER_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null || true)

  # 起動処理
  for session in $server_sessions; do
    pid_file="$PID_DIR/$session.pid"
    if [ ! -f "$pid_file" ]; then
      start_watcher_process "$session"
      echo "[MANAGER] Launched new process for session '$session'"
    fi
  done

  # 停止処理
  if [ -d "$PID_DIR" ] && [ -n "$(ls -A "$PID_DIR" 2>/dev/null || true)" ]; then
    for pid_file in "$PID_DIR"/*.pid; do
      [ -f "$pid_file" ] || continue
      session_name=$(basename "$pid_file" .pid)
      if ! echo "$server_sessions" | grep -qx "$session_name"; then
        pid_to_kill=$(cat "$pid_file")
        echo "[MANAGER] Session '$session_name' removed. Stopping process PID $pid_to_kill..."
        kill "$pid_to_kill" 2>/dev/null || true
        rm -f "$pid_file"
      fi
    done
  fi

  # --- ステップ2.5: Watcher自身の生存登録（ハートビート） ---
  current_time=$(date +%s)
  json_content=$(printf '{"display_name": "%s", "last_heartbeat": %s}' "$DISPLAY_NAME" "$current_time")
  echo "$json_content" > "$LOCAL_REGISTRY_DIR/$WATCHER_ID"
  # すぐに反映
  "${RSYNC_REG_PUSH[@]}" "$LOCAL_REGISTRY_DIR/" "$SERVER:$REMOTE_REGISTRY_DIR/"

  # --- ステップ3: pull（サーバ→ローカル）は安全に（新しいローカルは保護） ---
  echo "[MANAGER] Syncing from server (preserve newer local)..."
  ssh -o BatchMode=yes "$SERVER" "mkdir -p '$REMOTE_WATCHER_DIR'"
  # -u: 受け側(ローカル)が新しければ上書きしない / --inplace: ログ追記と相性が良い
  "${RSYNC_PULL_SAFE[@]}" --exclude '*/commands.log' "$SERVER:$REMOTE_WATCHER_DIR/" "$LOCAL_WATCHER_DIR/"

  # --- ループの待機 ---
  sleep "$INTERVAL"

done
