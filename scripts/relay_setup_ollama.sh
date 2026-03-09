#!/usr/bin/env bash
# Relay 上で Ollama のインストール・起動・モデル pull を行う。
# deploy_backend.sh から --setup-ollama で呼ばれる想定。実行時はアプリルート（config.ini があるディレクトリ）で実行すること。
# インストールは $HOME/.local/ollama にバイナリのみ展開（sudo 不要・SSH 非対話で実行可能）。
set -euo pipefail

APP_ROOT="${1:-.}"
cd "$APP_ROOT"
CONFIG="${APP_ROOT}/config.ini"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
DEFAULT_MODEL="qwen2.5-coder:7b"

# config.ini の [ai] ollama_model を読む
get_ollama_model() {
  if [[ -f "$CONFIG" ]]; then
    val=$(python3 -c "
import configparser
c = configparser.ConfigParser()
c.read('$CONFIG')
if c.has_section('ai') and c.has_option('ai', 'ollama_model'):
    print(c.get('ai', 'ollama_model').strip())
" 2>/dev/null) || true
    [[ -n "$val" ]] && { echo "$val"; return; }
  fi
  echo "$DEFAULT_MODEL"
}

MODEL=$(get_ollama_model)
[[ -z "$MODEL" ]] && MODEL="$DEFAULT_MODEL"

echo "[Ollama] Using model: $MODEL"

# 1) 未インストールならユーザー領域にインストール（sudo 不要・SSH 非対話で実行可能）
OLLAMA_USER_DIR="${OLLAMA_USER_DIR:-$HOME/.local/ollama}"
install_ollama_user() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "[Ollama] Unsupported arch: $(uname -m)" >&2; return 1 ;;
  esac
  mkdir -p "$OLLAMA_USER_DIR"
  local base="https://ollama.com/download/ollama-linux-${arch}"
  echo "[Ollama] Downloading Ollama for linux-${arch} (no sudo)..."

  # 1) システムの zstd があればそれで .tar.zst を展開
  if command -v zstd >/dev/null 2>&1; then
    if curl -fsSL --location "${base}.tar.zst" | zstd -d | tar -xf - -C "$OLLAMA_USER_DIR" 2>/dev/null; then
      export PATH="$OLLAMA_USER_DIR/bin:$PATH"
      return 0
    fi
  fi

  # 2) zstd が無い場合は Python の zstandard で展開（pip install --user で取得）
  if command -v python3 >/dev/null 2>&1; then
    if python3 -c "import zstandard" 2>/dev/null; then
      :
    else
      echo "[Ollama] zstd not in PATH, trying: python3 -m pip install --user zstandard..."
      python3 -m pip install --user zstandard >/dev/null 2>&1 || true
    fi
    if python3 -c "import zstandard" 2>/dev/null; then
      local url="${base}.tar.zst"
      echo "[Ollama] Downloading and extracting with Python zstandard..."
      if python3 - "$url" "$OLLAMA_USER_DIR" << 'PY'
import sys, urllib.request, tarfile, io
try:
  import zstandard as zstd
except ImportError:
  sys.exit(1)
url, dest = sys.argv[1], sys.argv[2]
data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/7"})).read()
# 複数フレーム／ストリーム形式に対応するためストリーミング展開
dctx = zstd.ZstdDecompressor()
out = io.BytesIO()
dctx.copy_stream(io.BytesIO(data), out)
dec = out.getvalue()
with tarfile.open(fileobj=io.BytesIO(dec), mode="r:") as tf:
  tf.extractall(dest)
PY
      then
        export PATH="$OLLAMA_USER_DIR/bin:$PATH"
        return 0
      fi
    fi
  fi

  # 3) .tgz は公式では廃止だが念のため試行
  if curl -fsSL --location "${base}.tgz" 2>/dev/null | tar -xzf - -C "$OLLAMA_USER_DIR" 2>/dev/null; then
    export PATH="$OLLAMA_USER_DIR/bin:$PATH"
    return 0
  fi

  echo "[Ollama] Download failed. On Relay either: (1) install zstd: sudo apt install zstd, or (2) run: curl -fsSL https://ollama.com/install.sh | sh (requires sudo)" >&2
  return 1
}

if ! command -v ollama >/dev/null 2>&1; then
  if [[ -x "$OLLAMA_USER_DIR/bin/ollama" ]]; then
    export PATH="$OLLAMA_USER_DIR/bin:$PATH"
    echo "[Ollama] Using existing: $OLLAMA_USER_DIR/bin/ollama"
  else
    echo "[Ollama] Installing Ollama to $OLLAMA_USER_DIR (no sudo)..."
    install_ollama_user || { echo "[Ollama] Install failed. On Relay run manually: curl -fsSL https://ollama.com/install.sh | sh" >&2; exit 1; }
  fi
else
  echo "[Ollama] Already installed: $(command -v ollama)"
fi

# 以降で使う ollama コマンド（ユーザー領域優先）
if [[ -x "$OLLAMA_USER_DIR/bin/ollama" ]]; then
  OLLAMA_CMD="$OLLAMA_USER_DIR/bin/ollama"
else
  OLLAMA_CMD="ollama"
fi

# 2) 11434 で listen していなければ ollama serve を起動
if command -v lsof >/dev/null 2>&1; then
  if ! lsof -nP -i "TCP:${OLLAMA_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "[Ollama] Starting ollama serve (port $OLLAMA_PORT)..."
    ( cd "$APP_ROOT" && nohup $OLLAMA_CMD serve </dev/null >> ollama.log 2>&1 & )
    disown 2>/dev/null || true
    sleep 2
  else
    echo "[Ollama] Already listening on port $OLLAMA_PORT"
  fi
else
  if ! pgrep -f "ollama serve" >/dev/null 2>&1; then
    echo "[Ollama] Starting ollama serve..."
    ( cd "$APP_ROOT" && nohup $OLLAMA_CMD serve </dev/null >> ollama.log 2>&1 & )
    disown 2>/dev/null || true
    sleep 2
  fi
fi

# 3) モデルを pull（既にあればスキップされる）
echo "[Ollama] Pulling model: $MODEL (may take a while on first run)"
$OLLAMA_CMD pull "$MODEL"

echo "[Ollama] Setup done. Backend can use Ollama at http://127.0.0.1:${OLLAMA_PORT}"
