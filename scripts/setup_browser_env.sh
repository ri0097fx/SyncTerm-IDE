#!/usr/bin/env bash
set -euo pipefail

# Relay 上でブラウザ調査用の仮想環境 (.venv-browser) を構築するスクリプト。
# Playwright + Chromium をこの環境内にのみインストールする。
#
# Usage (relay 上):
#   cd /path/to/SyncTerm-IDE
#   bash scripts/setup_browser_env.sh .
#
# ※ 初回実行時は playwright install chromium に時間がかかります。

APP_ROOT="${1:-.}"
cd "$APP_ROOT"

if [[ ! -d "backend" ]]; then
  echo "ERROR: backend ディレクトリが見つかりません: $APP_ROOT"
  exit 1
fi

echo "[browser-setup] Creating .venv-browser..."
python3 -m venv .venv-browser
. .venv-browser/bin/activate

echo "[browser-setup] Installing Playwright..."
pip install --upgrade pip -q
pip install playwright -q

echo "[browser-setup] Installing Chromium for Playwright..."
python -m playwright install chromium

echo "[browser-setup] Done.  Use .venv-browser for browser-based research tools."

