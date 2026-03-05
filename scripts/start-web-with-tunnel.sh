#!/usr/bin/env bash
# トンネル + Web フロントを一括起動する。
# 使い方:
#   ./scripts/start-web-with-tunnel.sh
# または syncterm-web から:
#   npm run dev:tunnel
#
# オプション: リポジトリ直下に .env.tunnel を置く（例は .env.tunnel.example 参照）。
#   TUNNEL_SSH=user@relay-host
#   TUNNEL_LOCAL_PORT=8002
#   TUNNEL_REMOTE_PORT=8000
# .env.tunnel が無い、または TUNNEL_SSH が未設定の場合はトンネルなしで npm run dev のみ実行。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# オプション: .env.tunnel を読み込む
if [[ -f "$REPO_ROOT/.env.tunnel" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env.tunnel"
  set +a
fi

TUNNEL_SSH="${TUNNEL_SSH:-}"
TUNNEL_LOCAL_PORT="${TUNNEL_LOCAL_PORT:-8002}"
TUNNEL_REMOTE_PORT="${TUNNEL_REMOTE_PORT:-8000}"

SSH_PID=""
cleanup() {
  if [[ -n "$SSH_PID" ]] && kill -0 "$SSH_PID" 2>/dev/null; then
    echo "[tunnel] Stopping SSH (PID $SSH_PID)"
    kill "$SSH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "$TUNNEL_SSH" ]]; then
  echo "[tunnel] Starting: ssh -L ${TUNNEL_LOCAL_PORT}:127.0.0.1:${TUNNEL_REMOTE_PORT} ${TUNNEL_SSH} -N"
  ssh -L "${TUNNEL_LOCAL_PORT}:127.0.0.1:${TUNNEL_REMOTE_PORT}" "$TUNNEL_SSH" -N &
  SSH_PID=$!
  sleep 1
  if ! kill -0 "$SSH_PID" 2>/dev/null; then
    echo "[tunnel] SSH failed to start (check host/key). Continuing without tunnel."
    SSH_PID=""
  else
    echo "[tunnel] Backend will be available at http://localhost:${TUNNEL_LOCAL_PORT}"
  fi
else
  echo "[tunnel] TUNNEL_SSH not set. Copy .env.tunnel.example to .env.tunnel and set TUNNEL_SSH to use tunnel."
fi

echo "[web] Starting Vite dev server..."
cd "$REPO_ROOT/syncterm-web"
exec npm run dev
