#!/usr/bin/env bash
set -euo pipefail

# Relay 上で Buddy 用 LoRA 学習を一括実行するスクリプト。
# 例: cron から定期実行することで、蓄積されたフィードバックを元に
#     教師データの構築＋LoRA 学習を自動で回すことができる。
#
# Usage:
#   cd /path/to/SyncTerm-IDE
#   bash scripts/run_buddy_training.sh

APP_ROOT="${1:-.}"
cd "$APP_ROOT"

if [[ ! -d "backend" ]] || [[ ! -d ".venv-train" ]]; then
  echo "ERROR: backend/.venv-train が見つかりません。先に scripts/setup_training_env.sh を実行してください。"
  exit 1
fi

. .venv-train/bin/activate

echo "[buddy-train] Step 1: build dataset from Buddy memory..."
python backend/training/build_buddy_dataset.py --out training_data/buddy_supervised_raw.jsonl

echo "[buddy-train] Step 2: train LoRA adapter..."
python backend/training/train_lora.py \
  --data training_data/buddy_supervised_raw.jsonl \
  --output-dir training_checkpoints/buddy-lora

echo "[buddy-train] Done."

