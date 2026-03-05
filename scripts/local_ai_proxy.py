#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


class AiAssistPayload(BaseModel):
  path: str
  action: str
  prompt: str
  selectedText: Optional[str] = None
  fileContent: str
  watcherId: Optional[str] = None
  session: Optional[str] = None


class AiInlinePayload(BaseModel):
  path: str
  prefix: str
  suffix: str
  language: Optional[str] = None
  watcherId: Optional[str] = None
  session: Optional[str] = None


app = FastAPI(title="SyncTerm Local AI Proxy")
app.add_middleware(
  CORSMiddleware,
  allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)


def trim_echoed_prefix(prefix: str, completion: str) -> str:
  if not completion:
    return ""
  text = completion
  # Remove overlap where completion starts with already-typed suffix.
  tail = prefix[-4000:] if prefix else ""
  max_k = min(len(tail), len(text))
  for k in range(max_k, 0, -1):
    if tail.endswith(text[:k]):
      text = text[k:]
      break
  return text


def call_openai(messages, max_tokens: int = 512, temperature: float = 0.2) -> str:
  api_key = os.environ.get("OPENAI_API_KEY")
  if not api_key:
    raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set on local AI proxy")
  model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
  body = json.dumps(
    {
      "model": model,
      "temperature": temperature,
      "max_tokens": max_tokens,
      "messages": messages,
    }
  ).encode("utf-8")

  req = urllib.request.Request(
    "https://api.openai.com/v1/chat/completions",
    data=body,
    headers={
      "Content-Type": "application/json",
      "Authorization": f"Bearer {api_key}",
    },
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=45) as resp:
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
  except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", errors="replace")
    status = int(getattr(e, "code", 502) or 502)
    if status == 429:
      raise HTTPException(
        status_code=429,
        detail=(
          "OpenAIの利用上限に達しました。"
          "請求設定/残高/利用制限を確認し、必要ならモデルを軽量化してください。"
        ),
      )
    raise HTTPException(status_code=502, detail=f"openai upstream error (status={status})")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"openai request failed: {e}")

  try:
    return str(data["choices"][0]["message"]["content"]).strip()
  except Exception:
    raise HTTPException(status_code=500, detail="invalid openai response format")


def call_ollama(messages, max_tokens: int = 512, temperature: float = 0.2) -> str:
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  model = os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b")
  body = json.dumps(
    {
      "model": model,
      "messages": messages,
      "stream": False,
      "options": {
        "temperature": temperature,
        "num_predict": max_tokens,
      },
    }
  ).encode("utf-8")
  req = urllib.request.Request(
    f"{base.rstrip('/')}/api/chat",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=90) as resp:
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
  except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", errors="replace")
    status = int(getattr(e, "code", 502) or 502)
    raise HTTPException(status_code=502, detail=f"ollama upstream error (status={status}): {detail}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"ollama request failed: {e}")

  try:
    return str(data["message"]["content"]).strip()
  except Exception:
    raise HTTPException(status_code=500, detail="invalid ollama response format")


def call_llm(messages, max_tokens: int = 512, temperature: float = 0.2) -> str:
  provider = os.environ.get("AI_PROVIDER", "ollama").strip().lower()
  if provider == "openai":
    return call_openai(messages, max_tokens=max_tokens, temperature=temperature)
  if provider == "ollama":
    return call_ollama(messages, max_tokens=max_tokens, temperature=temperature)
  raise HTTPException(status_code=400, detail=f"unsupported AI_PROVIDER: {provider}")


@app.post("/ai-assist")
def ai_assist(payload: AiAssistPayload):
  scope_text = (payload.selectedText or "").strip() or payload.fileContent
  user_prompt = (
    "You are a coding assistant. Return only code text without markdown fences.\n"
    f"Action: {payload.action}\n"
    f"Instruction: {payload.prompt}\n"
    f"File: {payload.path}\n\n"
    "Input:\n"
    f"{scope_text}"
  )
  result = call_llm(
    [
      {
        "role": "system",
        "content": "You are an expert software engineer. Keep output concise and directly usable.",
      },
      {"role": "user", "content": user_prompt},
    ],
    max_tokens=900,
    temperature=0.2,
  )
  return {"result": result}


@app.post("/ai-inline")
def ai_inline(payload: AiInlinePayload):
  prefix = payload.prefix[-3000:]
  suffix = payload.suffix[:800]
  if not prefix.strip():
    return {"completion": ""}

  user_prompt = (
    "Return ONLY the immediate continuation at the cursor.\n"
    "STRICT RULES:\n"
    "- Output plain text only (no markdown, no code fences).\n"
    "- Output at most one logical line.\n"
    "- Do not repeat existing code.\n"
    "- Do not add imports, function/class definitions, or explanations.\n"
    f"Language: {payload.language or 'unknown'}\n"
    f"File: {payload.path}\n\n"
    "Text before cursor:\n"
    f"{prefix}\n\n"
    "Text after cursor:\n"
    f"{suffix}\n"
  )
  result = call_llm(
    [
      {
        "role": "system",
        "content": "You are an inline code completion engine. Output only continuation text.",
      },
      {"role": "user", "content": user_prompt},
    ],
    max_tokens=48,
    temperature=0.1,
  )
  text = result.replace("\r\n", "\n")
  if not text.strip():
    return {"completion": ""}
  # Guardrails: inline completion should never be a big block.
  if "```" in text:
    return {"completion": ""}
  first_line = text.split("\n", 1)[0].rstrip()
  first_line = trim_echoed_prefix(prefix, first_line)
  if not first_line.strip():
    return {"completion": ""}
  if len(first_line) > 160:
    first_line = first_line[:160].rstrip()
  lowered = first_line.lower()
  if lowered.startswith("import ") or lowered.startswith("from "):
    return {"completion": ""}
  return {"completion": first_line}


if __name__ == "__main__":
  import uvicorn

  host = os.environ.get("LOCAL_AI_PROXY_HOST", "127.0.0.1")
  port = int(os.environ.get("LOCAL_AI_PROXY_PORT", "8011"))
  uvicorn.run(app, host=host, port=port, reload=False)

