#!/usr/bin/env bash
# scripts/wsl/bootstrap.sh
# --------------------------------------------------------------------
# WSL(Ubuntu/Debian系) 側の初期化スクリプト
# - 必須パッケージ導入 (python/venv, rsync, ssh, git など)
# - SSH鍵セットアップ（必要なら Windows 側からコピー）
# - SSH クライアントの安全な既定値
# - プロジェクト venv 構築 & requirements.txt インストール
#
# 使い方（WSL/Ubuntu ターミナルで）:
#   chmod +x scripts/wsl/bootstrap.sh
#   ./scripts/wsl/bootstrap.sh "<リポジトリのWSLパス>"
#   # 例: ./scripts/wsl/bootstrap.sh "/mnt/c/Users/you/SyncTerm-IDE"
# --------------------------------------------------------------------
set -euo pipefail

REPO_ROOT=${1:-"$PWD"}

log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✔\033[0m  %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*"; }

# --- 0) 実行環境の確認 --------------------------------------------------------
if ! command -v uname >/dev/null 2>&1; then
  echo "This script must run on Linux (WSL)."; exit 1
fi

DIST_ID=$(
  . /etc/os-release 2>/dev/null || true
  echo "${ID:-unknown}"
)

# --- 1) APT パッケージ導入 ----------------------------------------------------
log "Updating APT and installing required packages..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    python3 python3-pip python3-venv \
    rsync openssh-client git \
    jq unzip
else
  warn "apt-get が見つかりません。対応ディストリではありません。必要パッケージを手動で導入してください。"
fi
ok "Base packages installed (or already present)."

# --- 2) SSH 鍵セットアップ ----------------------------------------------------
log "Configuring SSH keys..."
WSL_SSH_DIR="$HOME/.ssh"
mkdir -p "$WSL_SSH_DIR"
chmod 700 "$WSL_SSH_DIR"

# Windows 側の既存鍵を流用（存在すれば）
if grep -qi microsoft /proc/version 2>/dev/null; then
  WIN_USER="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "${WIN_USER:-}" ]]; then
    WIN_SSH_DIR="/mnt/c/Users/${WIN_USER}/.ssh"
    if [[ -f "${WIN_SSH_DIR}/id_rsa" && ! -f "${WSL_SSH_DIR}/id_rsa" ]]; then
      cp "${WIN_SSH_DIR}/id_rsa" "${WSL_SSH_DIR}/id_rsa"
      chmod 600 "${WSL_SSH_DIR}/id_rsa"
      ok "Copied private key from Windows."
    fi
    if [[ -f "${WIN_SSH_DIR}/id_rsa.pub" && ! -f "${WSL_SSH_DIR}/id_rsa.pub" ]]; then
      cp "${WIN_SSH_DIR}/id_rsa.pub" "${WSL_SSH_DIR}/id_rsa.pub"
      chmod 644 "${WSL_SSH_DIR}/id_rsa.pub"
      ok "Copied public key from Windows."
    fi
  fi
fi

# なければ新規生成
if [[ ! -f "${WSL_SSH_DIR}/id_rsa" ]]; then
  ssh-keygen -t rsa -b 4096 -N "" -f "${WSL_SSH_DIR}/id_rsa" >/dev/null
  chmod 600 "${WSL_SSH_DIR}/id_rsa"
  ok "Generated new SSH key."
fi

# SSHクライアント設定の安全既定
SSH_CFG="${WSL_SSH_DIR}/config"
touch "${SSH_CFG}"
chmod 600 "${SSH_CFG}"
if ! grep -q "StrictHostKeyChecking" "${SSH_CFG}"; then
  cat >> "${SSH_CFG}" <<'CFG'
Host *
    ServerAliveInterval 15
    ServerAliveCountMax 2
    StrictHostKeyChecking accept-new
    TCPKeepAlive yes
CFG
  ok "Updated ~/.ssh/config defaults."
fi

# --- 3) Git の小設定（CRLFトラブル防止） --------------------------------------
if command -v git >/dev/null 2>&1; then
  git config --global --type=bool core.autocrlf false || true
  git config --global core.fileMode false || true
  ok "Git defaults set (autocrlf=false, fileMode=false)."
fi

# --- 4) プロジェクトの Python venv -------------------------------------------
log "Setting up Python virtual environment for the project..."
cd "${REPO_ROOT}"

# venv 作成
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
  ok "Created .venv"
fi

# pip アップグレード & 依存導入
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip wheel setuptools >/dev/null

if [[ -f "requirements.txt" ]]; then
  pip install -r requirements.txt
  ok "Installed requirements.txt"
else
  warn "requirements.txt がありません。必要なら後で追加して 'pip install -r requirements.txt' を実行してください。"
fi

# --- 5) WSL 用の環境ディレクトリ（サンプル） -----------------------------------
# env.example.wsl があれば、この場でディレクトリだけ作っておく
if [[ -f "scripts/wsl/env.example.wsl" ]]; then
  # shellcheck disable=SC1090
  set +u
  source "scripts/wsl/env.example.wsl"
  set -u
  ok "Initialized directories from env.example.wsl (if any)."
fi

# --- 6) 動作確認メッセージ ----------------------------------------------------
echo
ok "Bootstrap finished."
echo "Next steps:"
echo "  1) 必要なら 'source ${REPO_ROOT}/scripts/wsl/env.example.wsl' を実行"
echo "  2) 疎通テスト:  bash ${REPO_ROOT}/scripts/wsl/relay_test.sh"
echo
