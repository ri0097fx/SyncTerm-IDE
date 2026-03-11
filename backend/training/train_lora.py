"""
Buddy 用の LoRA 学習スクリプト（シンプルなサンプル実装）。

- ベースモデル本体は Hugging Face Transformers 互換のモデルを想定
- 学習結果は LoRA アダプタとして保存し、ベースモデルとは分離
- 実運用では VRAM / データサイズに応じてハイパーパラメータを調整してください
"""

import argparse
import json
from pathlib import Path

from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer


def load_base_path() -> Path:
  here = Path(__file__).resolve()
  return here.parents[2]  # backend/training → backend → REPO_ROOT


def build_hf_dataset(dataset_path: Path):
  """
  build_buddy_dataset.py が出力した JSONL（instruction/output）を
  Transformers/datasets で扱える形式に変換する。
  """
  # datasets.load_dataset("json", data_files=...) を使うとそのまま読める
  ds = load_dataset("json", data_files=str(dataset_path))

  def format_example(batch):
    # 単純な instruction-only フォーマット:
    # [INST] ... [/INST] <answer>
    instructions = batch["instruction"]
    outputs = batch["output"]
    texts = []
    for inst, out in zip(instructions, outputs):
      inst = inst.strip()
      out = out.strip()
      if not inst or not out:
        texts.append("")
        continue
      texts.append(f"<s>[INST]\n{inst}\n[/INST]\n{out}</s>")
    return {"text": texts}

  ds = ds.map(format_example, batched=True, remove_columns=ds["train"].column_names)
  return ds


def main() -> None:
  parser = argparse.ArgumentParser(description="Buddy 用 LoRA 学習スクリプト")
  parser.add_argument(
    "--data",
    type=str,
    default="training_data/buddy_supervised_raw.jsonl",
    help="学習データ JSONL（instruction/output）への相対パス",
  )
  parser.add_argument(
    "--base-model",
    type=str,
    default="Qwen/Qwen2.5-Coder-7B-Instruct",
    help="ベースモデル名（Hugging Face 形式）",
  )
  parser.add_argument(
    "--output-dir",
    type=str,
    default="training_checkpoints/buddy-lora",
    help="LoRA アダプタの出力ディレクトリ（相対パス）",
  )
  parser.add_argument(
    "--micro-batch-size",
    type=int,
    default=4,
  )
  parser.add_argument(
    "--epochs",
    type=int,
    default=1,
  )
  args = parser.parse_args()

  base_path = load_base_path()
  data_path = base_path / args.data
  if not data_path.exists():
    raise SystemExit(f"dataset not found: {data_path}. 先に build_buddy_dataset.py を実行してください。")

  out_dir = base_path / args.output_dir
  out_dir.mkdir(parents=True, exist_ok=True)

  print(f"[train_lora] loading dataset from {data_path}")
  ds = build_hf_dataset(data_path)

  print(f"[train_lora] loading base model: {args.base_model}")
  tokenizer = AutoTokenizer.from_pretrained(args.base_model, use_fast=True)
  if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

  model = AutoModelForCausalLM.from_pretrained(
    args.base_model,
    load_in_8bit=False,
    load_in_4bit=False,
  )
  model = prepare_model_for_kbit_training(model)

  lora_config = LoraConfig(
    r=8,
    lora_alpha=16,
    target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
  )
  model = get_peft_model(model, lora_config)

  def tokenize_function(batch):
    return tokenizer(
      batch["text"],
      padding="max_length",
      truncation=True,
      max_length=2048,
    )

  tokenized = ds.map(tokenize_function, batched=True, remove_columns=["text"])
  tokenized.set_format(type="torch")

  training_args = TrainingArguments(
    output_dir=str(out_dir),
    per_device_train_batch_size=args.micro_batch_size,
    num_train_epochs=args.epochs,
    learning_rate=2e-4,
    weight_decay=0.01,
    logging_steps=10,
    save_steps=200,
    save_total_limit=3,
    bf16=False,
    fp16=True,
  )

  trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=tokenized["train"],
    tokenizer=tokenizer,
  )

  print("[train_lora] start training...")
  trainer.train()
  print("[train_lora] saving adapter...")
  model.save_pretrained(str(out_dir))

  meta_path = out_dir / "buddy_lora_meta.json"
  meta = {
    "base_model": args.base_model,
    "data_path": str(data_path),
    "epochs": args.epochs,
  }
  meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
  print(f"[train_lora] done. adapter + meta saved under {out_dir}")


if __name__ == "__main__":
  main()

