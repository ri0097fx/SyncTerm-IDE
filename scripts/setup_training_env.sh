#!/usr/bin/env bash
set -euo pipefail

# Relay 上で Buddy 学習用の Python 環境をセットアップするスクリプト。
# deploy_backend.sh から --setup-train オプション経由で呼び出されることを想定。
#
# Usage (relay 上で):
#   cd /path/to/SyncTerm-IDE
#   bash scripts/setup_training_env.sh .

APP_ROOT="${1:-.}"
cd "$APP_ROOT"

if [[ ! -d "backend" ]]; then
  echo "ERROR: backend ディレクトリが見つかりません: $APP_ROOT"
  exit 1
fi

REQ_FILE="backend/training/requirements.txt"
if [[ ! -f "$REQ_FILE" ]]; then
  echo "ERROR: $REQ_FILE が見つかりません。"
  exit 1
fi

echo "[train-setup] Creating .venv-train..."
python3 -m venv .venv-train
. .venv-train/bin/activate
pip install --upgrade pip -q
echo "[train-setup] Installing training requirements..."
pip install -r "$REQ_FILE"

mkdir -p training_data training_checkpoints

echo "[train-setup] Done.  .venv-train / training_data / training_checkpoints を作成しました。"

