#!/bin/bash
# watcher_manager.sh (同期機能統合・設定ファイル分離・自己登録対応版)
#
# 機能:
# 1. config.iniからGUI用とWatcher用の設定を個別に読み込む。
# 2. 定期的にサーバーと自身のローカルミラーを同期する。
# 3. 自身の生存を知らせるハートビートファイルを定期的に書き出す (セッション0個問題の解決策)。
# 4. 同期後のローカルミラーの状態に基づき、セッションごとの command_watcher.py プロセスを起動・維持する。

set -eu

# ===== 引数処理 =====
WATCHER_ID="${1:?引数1: WatcherのユニークIDを指定してください}"
DISPLAY_NAME="${2:?引数2: GUIに表示するWatcherの基本名(例: 'GPU-Server')を指定してください}"

# ===== 設定ファイルのパス =====
# このスクリプトと同じディレクトリにあるconfig.iniを指す
CONFIG_FILE="$(dirname "$0")/config.ini"
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
WATCHER_SCRIPT_PATH="$(dirname "$0")/command_watcher.py"
INTERVAL=5 # 同期とプロセスチェックの間隔

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
      if [ -f "$pid_file" ]; then
        pid_to_kill=$(cat "$pid_file")
        echo "[MANAGER] Killing process PID $pid_to_kill."
        # killコマンドのエラーは無視する（プロセスが既に存在しない場合など）
        kill "$pid_to_kill" 2>/dev/null || true
      fi
    done
    rm -rf "$PID_DIR"
  fi
  # 登録解除のために、対応するレジストリファイルを削除
  # この削除処理も、最終的にサーバーに同期される
  rm -f "$LOCAL_REGISTRY_DIR/$WATCHER_ID"
  # サーバーに最後の状態を同期して削除を反映
  rsync -az --delete "$LOCAL_REGISTRY_DIR/" "$SERVER:$REMOTE_REGISTRY_DIR/"
  echo "[MANAGER] Cleanup finished."
}
trap cleanup EXIT

# ===== メインループ =====
echo "[MANAGER] Started for WATCHER_ID='$WATCHER_ID'"
# 必要なディレクトリを最初に作成
mkdir -p "$LOCAL_WATCHER_DIR"
mkdir -p "$LOCAL_REGISTRY_DIR"
mkdir -p "$PID_DIR"

while true; do
  # --- ステップ1: サーバーからローカルへ同期 ---
  echo "[MANAGER] Syncing from server..."
  # 初回起動時にリモートディレクトリが存在しない問題を解決するため、mkdir -p を実行
  ssh "$SERVER" "mkdir -p '$REMOTE_WATCHER_DIR'"
  rsync -az --delete "$SERVER:$REMOTE_WATCHER_DIR/" "$LOCAL_WATCHER_DIR/"

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
  if [ -d "$PID_DIR" ] && [ -n "$(ls -A "$PID_DIR")" ]; then
    for pid_file in "$PID_DIR"/*.pid; do
      session_name=$(basename "$pid_file" .pid)
      if ! echo "$server_sessions" | grep -qx "$session_name"; then
        pid_to_kill=$(cat "$pid_file")
        echo "[MANAGER] Session '$session_name' removed. Stopping process PID $pid_to_kill..."
        kill "$pid_to_kill" 2>/dev/null || true
        rm -f "$pid_file"
      fi
    done
  fi

  # --- ステップ2.5: Watcher自身の生存登録 ---
  # セッションが0個でもWatcherがオンラインであることをGUIに知らせるため、
  # マネージャー自身がハートビートを書き込む。(デッドロック解消策)
  current_time=$(date +%s)
  json_content=$(printf '{"display_name": "%s", "last_heartbeat": %s}' "$DISPLAY_NAME" "$current_time")
  echo "$json_content" > "$LOCAL_REGISTRY_DIR/$WATCHER_ID"

  # --- ステップ3: ローカルからサーバーへ同期 ---
  # ログ、および上で生成したハートビートファイルなどをサーバーにアップロード
  echo "[MANAGER] Syncing to server..."
  rsync -az "$LOCAL_WATCHER_DIR/" "$SERVER:$REMOTE_WATCHER_DIR/"
  rsync -az --delete "$LOCAL_REGISTRY_DIR/" "$SERVER:$REMOTE_REGISTRY_DIR/"

  # --- ループの待機 ---
  sleep "$INTERVAL"
done