import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

import configparser


def load_base_path() -> Path:
  """
  backend/app/main.py と同じルールで BASE_PATH を解決する。
  （config.ini があるディレクトリをアプリルートとみなす）
  """
  here = Path(__file__).resolve()
  repo_root = here.parents[2]  # backend/training/ → backend → REPO_ROOT
  config_path = repo_root / "config.ini"
  if not config_path.exists():
    raise RuntimeError(f"config.ini not found at {config_path}")
  parser = configparser.ConfigParser()
  parser.read(config_path)
  structure = dict(parser["structure"]) if parser.has_section("structure") else {}
  # backend/app/main.py と合わせて、BASE_PATH = REPO_ROOT
  _ = structure  # 将来の拡張用
  return repo_root


def load_buddy_memory(base_path: Path) -> List[Dict[str, Any]]:
  path = base_path / "ai_buddy_memory.jsonl"
  if not path.exists():
    return []
  items: List[Dict[str, Any]] = []
  with path.open("r", encoding="utf-8") as f:
    for line in f:
      line = line.strip()
      if not line:
        continue
      try:
        obj = json.loads(line)
      except Exception:
        continue
      if isinstance(obj, dict):
        items.append(obj)
  return items


def build_supervised_examples(memory: List[Dict[str, Any]]) -> List[Dict[str, str]]:
  """
  ai_buddy_memory.jsonl から「教師データ候補」を構築する。

  現状のメモリにはユーザー質問そのものは含まれていないため、
  ここでは以下のような簡易的な教師データを作る：

  - rating == "good" かつ role == "assistant" の message を「良い回答の例」とみなし、
    その回答スタイルを模倣する形式の instruction/output ペアを生成する。

  これは「模範解答のスタイル蒸留」に近い用途で、ベースモデルに
  「こういう書き方をしてほしい」というバイアスを与えることを意図している。
  本格的な supervised fine-tuning のためには、将来的に
  質問テキストも一緒に保存する拡張が望ましい。
  """
  examples: List[Dict[str, str]] = []
  for item in memory:
    if item.get("kind") != "feedback":
      continue
    if item.get("rating") != "good":
      continue
    role = (item.get("role") or "").strip().lower()
    if role != "assistant":
      continue
    msg = (item.get("message") or "").strip()
    if not msg:
      continue
    task_type = (item.get("taskType") or "chat").strip()
    mode = (item.get("mode") or "ask").strip()
    thinking = (item.get("thinking") or "balanced").strip()

    instruction = (
      "次のテキストは、Buddy が良いと評価された回答の例です。"
      "同じようなタスク（taskType / mode / thinking）に対して、"
      "このスタイルを保った模範的な解答を書いてください。"
      f"\n\n[メタ情報]\n"
      f"- taskType: {task_type}\n"
      f"- mode: {mode}\n"
      f"- thinking: {thinking}\n"
      "\n[元の回答例]\n"
      f"{msg}\n"
    )
    # output 側は「より整った模範解答」を入れたいが、ここでは元回答そのものを入れ、
    # 後段の教師モデルによるリライトで上書きできるようにする。
    examples.append(
      {
        "instruction": instruction,
        "output": msg,
      }
    )
  return examples


def main() -> None:
  parser = argparse.ArgumentParser(description="Buddy AI 用の教師データ下地を構築するスクリプト")
  parser.add_argument(
    "--out",
    type=str,
    default="training_data/buddy_supervised_raw.jsonl",
    help="出力先 JSONL パス（アプリルートからの相対パス）",
  )
  args = parser.parse_args()

  base_path = load_base_path()
  memory = load_buddy_memory(base_path)
  examples = build_supervised_examples(memory)

  out_path = base_path / args.out
  out_path.parent.mkdir(parents=True, exist_ok=True)
  with out_path.open("w", encoding="utf-8") as f:
    for ex in examples:
      f.write(json.dumps(ex, ensure_ascii=False) + "\n")

  print(f"wrote {len(examples)} examples to {out_path}")


if __name__ == "__main__":
  main()

