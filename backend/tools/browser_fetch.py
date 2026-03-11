"""
Headless ブラウザ（Playwright）を使ってページを開き、
JS 実行後の DOM からテキストを抽出する簡易ツール。

Agent からは <command>python backend/tools/browser_fetch.py --url 'https://example.com'</command>
のように呼び出し、その標準出力(JSON)を読んで要約に使う想定。
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def extract_text(page) -> str:
  # ページ全体のテキストを取得（display:none 等も含まれるが、まずはシンプルに）
  return page.inner_text("body")


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--url", required=True, help="target URL (http/https)")
  parser.add_argument(
    "--wait",
    type=float,
    default=3.0,
    help="seconds to wait after initial load for JS to settle",
  )
  parser.add_argument(
    "--max-chars",
    type=int,
    default=8000,
    help="max characters of text to output",
  )
  args = parser.parse_args()

  url = args.url.strip()
  if not (url.startswith("http://") or url.startswith("https://")):
    raise SystemExit("only http/https URLs are supported")

  result = {
    "url": url,
    "ok": False,
    "error": None,
    "title": None,
    "text": "",
  }

  try:
    with sync_playwright() as p:
      browser = p.chromium.launch(headless=True)
      page = browser.new_page()
      page.goto(url, wait_until="load", timeout=30000)
      if args.wait > 0:
        page.wait_for_timeout(int(args.wait * 1000))
      result["title"] = page.title()
      text = extract_text(page)
      if args.max_chars > 0:
        text = text[: args.max_chars]
      result["text"] = text
      result["ok"] = True
      browser.close()
  except Exception as e:
    result["error"] = str(e)

  print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
  main()

