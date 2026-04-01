from __future__ import annotations

import base64
import configparser
import json
import logging
import mimetypes
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from html.parser import HTMLParser
from pathlib import PurePosixPath
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .schemas import (
  AiAssistPayload,
  AiAssistResponse,
  AiEnsureModelPayload,
  AiInlinePayload,
  AgentCommandLog,
  BuddyFeedbackPayload,
  ChatMessage,
  CommandPayload,
  CopyPathPayload,
  CreateLinkPayload,
  CreatePathPayload,
  CreateSessionModel,
  DebateThread,
  DebateTurn,
  DeletePathPayload,
  FileChunkModel,
  FileContentPayload,
  FileEntryModel,
  LogChunk,
  MovePathPayload,
  RunnerConfigModel,
  RunnerConfigUpdatePayload,
  SessionModel,
  UploadFilePayload,
  WatcherModel,
  WatcherStatusModel,
)

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config.ini"


def load_paths():
  """アプリルート（REPO_ROOT = config.ini があるディレクトリ）を base に、sessions / _registry をその下に置く。base_path は廃止し ~/SyncTerm-IDE 相当に統一。"""
  if not CONFIG_PATH.exists():
    raise RuntimeError(f"config.ini not found at {CONFIG_PATH}")
  parser = configparser.ConfigParser()
  parser.read(CONFIG_PATH)
  structure = dict(parser["structure"]) if parser.has_section("structure") else {}
  sessions_dir_name = structure.get("sessions_dir_name", "sessions")
  registry_dir_name = structure.get("registry_dir_name", "_registry")
  base_path = REPO_ROOT
  sessions_root = base_path / sessions_dir_name
  registry_root = base_path / registry_dir_name
  return base_path, sessions_root, registry_root


BASE_PATH, SESSIONS_ROOT, REGISTRY_ROOT = load_paths()


def _get_available_vram_gb() -> Optional[int]:
  """利用可能な VRAM (GB) を推定する。

  現状は環境変数 / config.ini の設定値のみを参照し、自動検出は行わない。
  - 環境変数: AI_VRAM_GB
  - config.ini: [ai] vram_gb
  """
  env = os.environ.get("AI_VRAM_GB")
  if env:
    try:
      return int(env)
    except ValueError:
      pass
  try:
    parser = configparser.ConfigParser()
    parser.read(CONFIG_PATH)
    if parser.has_section("ai") and parser.has_option("ai", "vram_gb"):
      raw = parser.get("ai", "vram_gb").strip()
      if raw:
        return int(raw)
  except Exception:
    pass
  return None


def route_model(
  mode: str,
  requires_reasoning: bool,
  requires_code_generation: bool,
  requires_repo_read: bool,
  complexity: str,
  available_vram: Optional[int],
) -> Dict[str, Any]:
  """タスク内容と VRAM から、planner / executor / inspector / reviewer 用のモデルを選択する。

  - mode: "ask" / "plan" / "agent" / "debug" など
  - requires_*: タスクの性質
  - complexity: "low" / "medium" / "high" などの目安（現状はヒューリスティック用途）
  - available_vram: 利用可能な VRAM (GB)。None の場合は low memory とみなす
  """

  # 利用可能 VRAM に応じて許可されるモデル群を決定
  vram = available_vram or 0
  allowed: List[str]
  if vram >= 80:
    # 80GB 以上: すべて許可
    allowed = [
      "qwen3.5",
      "qwen2.5-coder:1.5b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
      "qwen2.5-coder:14b",
      "qwen2.5-coder:32b",
      "qwen2.5:72b-instruct-q3_K_M",
      "deepseek-coder:1.3b",
      "deepseek-coder:6.7b",
      "deepseek-coder:33b",
      "deepseek-coder-v2:16b",
      "deepseek-coder-v2:236b",
      "llama3.2",
      "llama3:8b",
      "llama3:70b",
      "mistral",
      "mistral-large",
    ]
  elif vram >= 48:
    allowed = [
      "qwen3.5",
      "llama3:70b",
      "qwen2.5-coder:32b",
      "deepseek-coder-v2:16b",
      "qwen2.5-coder:14b",
      "deepseek-coder:6.7b",
      "llama3:8b",
      "qwen2.5-coder:7b",
      "mistral",
    ]
  elif vram >= 24:
    allowed = [
      "qwen3.5",
      "qwen2.5-coder:32b",
      "deepseek-coder-v2:16b",
      "qwen2.5-coder:14b",
      "deepseek-coder:6.7b",
      "llama3:8b",
      "qwen2.5-coder:7b",
      "mistral",
    ]
  elif vram >= 16:
    allowed = [
      "qwen3.5",
      "qwen2.5-coder:14b",
      "deepseek-coder-v2:16b",
      "deepseek-coder:6.7b",
      "qwen2.5-coder:7b",
      "llama3:8b",
      "mistral",
    ]
  elif vram >= 8:
    allowed = [
      "qwen3.5",
      "qwen2.5-coder:7b",
      "deepseek-coder:6.7b",
      "llama3:8b",
      "qwen2.5-coder:3b",
      "deepseek-coder:1.3b",
    ]
  else:
    # low memory
    allowed = [
      "qwen2.5-coder:3b",
      "deepseek-coder:1.3b",
      "qwen2.5-coder:1.5b",
    ]

  def pick(preferred: List[str]) -> str:
    for m in preferred:
      if m in allowed:
        return m
    # fallback: 最初の allowed
    return allowed[0]

  # インストール済みモデルのみを候補とする（未インストールモデルは自動選択の対象外）
  installed = _get_ollama_installed_models()
  if installed:
    allowed = [m for m in allowed if m in installed] or allowed

  # ロールごとの優先モデル（仕様書より）
  planner_pref = ["llama3:70b", "qwen2.5:72b-instruct-q3_K_M", "mistral-large"]
  executor_pref = ["qwen2.5-coder:32b", "deepseek-coder-v2:16b", "qwen2.5-coder:14b"]
  inspector_pref = ["deepseek-coder-v2:16b", "qwen2.5-coder:32b", "deepseek-coder:6.7b"]
  reviewer_pref = ["mistral-large", "llama3:70b", "qwen2.5:72b-instruct-q3_K_M"]

  planner_model = pick(planner_pref)
  executor_model = pick(executor_pref)
  inspector_model = pick(inspector_pref)
  reviewer_model = pick(reviewer_pref)

  # 戦略決定（現段階では主にヒントとして使用）
  strategy = "single_model"
  m = mode.strip().lower()
  if m in ("ask", "plan"):
    strategy = "single_model"
  elif m == "debug":
    strategy = "two_stage_debug"
  elif m == "agent":
    if requires_code_generation:
      strategy = "planner_executor"
    else:
      strategy = "single_model"

  return {
    "planner_model": planner_model,
    "executor_model": executor_model,
    "inspector_model": inspector_model,
    "reviewer_model": reviewer_model,
    "strategy": strategy,
    "allowed": allowed,
    "vram_gb": vram,
  }


def load_ai_config() -> None:
  """config.ini の [ai] を読み、未設定の環境変数にだけ反映する（起動スクリプトで export しなくてよい）。"""
  if not CONFIG_PATH.exists():
    return
  parser = configparser.ConfigParser()
  try:
    parser.read(CONFIG_PATH)
  except Exception:
    return
  if not parser.has_section("ai"):
    return
  mapping = [
    ("ollama_base_url", "OLLAMA_BASE_URL"),
    ("ollama_model", "OLLAMA_MODEL"),
    ("ai_provider", "AI_PROVIDER"),
  ]
  for ini_key, env_key in mapping:
    if parser.has_option("ai", ini_key):
      val = parser.get("ai", ini_key).strip()
      if val and env_key not in os.environ:
        os.environ[env_key] = val

  # AI デバイス指定（cpu / gpu）。未指定時は cpu をデフォルトにする。
  if "AI_DEVICE" not in os.environ:
    if parser.has_option("ai", "device"):
      raw = parser.get("ai", "device").strip().lower()
      if raw in ("cpu", "gpu"):
        os.environ["AI_DEVICE"] = raw
      else:
        os.environ["AI_DEVICE"] = "cpu"
    else:
      os.environ["AI_DEVICE"] = "cpu"


load_ai_config()

# Ensure session/registry dirs exist at startup (e.g. after deploy)
SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
REGISTRY_ROOT.mkdir(parents=True, exist_ok=True)
MAX_FILE_BYTES = 2_000_000  # full-load limit for editor (2MB)
MAX_CHUNK_BYTES = 300_000   # chunk endpoint limit per request
MAX_LOG_CHUNK_BYTES = 1_000_000
MAX_TREE_DEPTH = 4
MAX_CHILDREN_PER_DIR = 200
MAX_RAW_FILE_BYTES = 20_000_000


def _norm_rel(path: str) -> str:
  """Session-relative path to Watcher rel path (no leading /, no ..)."""
  p = path.strip().lstrip("/").replace("\\", "/")
  if ".." in p.split("/") or p.startswith(".."):
    raise ValueError("path must not contain ..")
  return p or "."


def watcher_registry_files():
  if not REGISTRY_ROOT.exists():
    return []
  return sorted(REGISTRY_ROOT.glob("*.json"), key=lambda p: p.name.lower())


def load_watchers(timeout_sec: float = 30.0) -> List[WatcherModel]:
  import time

  now = time.time()
  res: List[WatcherModel] = []
  for path in watcher_registry_files():
    try:
      data = json.loads(path.read_text("utf-8"))
    except Exception:
      continue
    ts = data.get("last_heartbeat") or data.get("last_seen") or data.get("heartbeat_ts")
    if ts is None:
      ts = path.stat().st_mtime
    try:
      ts_f = float(ts)
    except Exception:
      continue
    if now - ts_f > timeout_sec:
      continue
    wid = path.stem
    display = data.get("display_name") or wid
    res.append(WatcherModel(id=wid, displayName=display, lastHeartbeat=ts_f))
  return res


def session_root(watcher_id: str, session: str) -> Path:
  root = SESSIONS_ROOT / watcher_id / session
  if not root.exists():
    raise HTTPException(status_code=404, detail="Session not found")
  return root


def resolve_session_file(root: Path, req_path: str) -> Path:
  rel = req_path.replace("\\", "/").lstrip("/")
  rel_path = PurePosixPath(rel)
  if rel_path.is_absolute() or ".." in rel_path.parts:
    raise HTTPException(status_code=400, detail="unsafe path")
  target = root / Path(*rel_path.parts)
  try:
    target.relative_to(root)
  except ValueError:
    raise HTTPException(status_code=400, detail="unsafe path")
  return target


def normalize_rel_path(req_path: str) -> str:
  rel = req_path.replace("\\", "/").lstrip("/")
  rel_path = PurePosixPath(rel)
  if rel_path.is_absolute() or ".." in rel_path.parts:
    raise HTTPException(status_code=400, detail="unsafe path")
  return rel


def path_has_symlink_component(root: Path, rel_path: str) -> bool:
  parts = [p for p in PurePosixPath(rel_path).parts if p not in ("", ".")]
  cur = root
  for part in parts:
    cur = cur / part
    try:
      if cur.is_symlink():
        return True
    except Exception:
      return False
  return False


def build_entry(root: Path, p: Path, children: Optional[List[FileEntryModel]] = None) -> FileEntryModel:
  is_symlink = p.is_symlink()
  is_dir_like = p.is_dir()
  if is_symlink:
    kind = "symlink"
  elif is_dir_like:
    kind = "dir"
  else:
    kind = "file"

  return FileEntryModel(
    id=str(p.relative_to(root)).replace("\\", "/") if p != root else "root",
    name=p.name if p != root else root.name,
    path="/" + str(p.relative_to(root)).replace("\\", "/") if p != root else "/",
    kind=kind,
    hasChildren=bool(is_dir_like),
    isRemoteLink=bool(is_symlink),
    children=children,
  )


def build_entry_from_name(
  root: Path,
  base_dir: Path,
  raw_name: str,
  path_prefix: Optional[str] = None,
) -> Optional[FileEntryModel]:
  # ls -F style suffixes:
  #   / = directory, @ = symlink, * = executable file, | = fifo, = = socket
  marker = raw_name[-1] if raw_name and raw_name[-1] in ("/", "@", "*", "|", "=") else ""
  clean_name = raw_name[:-1] if marker else raw_name
  clean_name = clean_name.strip()
  if not clean_name or clean_name in (".", ".."):
    return None
  if clean_name.startswith("."):
    return None

  p = base_dir / clean_name
  if path_prefix is not None:
    rel = f"{path_prefix.rstrip('/')}/{clean_name}" if path_prefix else clean_name
  else:
    try:
      rel = str(p.relative_to(root)).replace("\\", "/")
    except ValueError:
      return None
  path = "/" + rel if rel else "/"

  if marker == "/":
    kind = "dir"
    has_children = True
    is_remote_link = False
  elif marker == "@":
    kind = "symlink"
    # We keep this true to allow lazy expand attempt from UI.
    has_children = True
    is_remote_link = True
  else:
    kind = "file"
    has_children = False
    is_remote_link = False

  return FileEntryModel(
    id=rel or "root",
    name=clean_name,
    path=path,
    kind=kind,
    hasChildren=has_children,
    isRemoteLink=is_remote_link,
    children=None,
  )


def _ls_row_from_path(base_dir: Path, p: Path) -> str:
  """Path から ls -F 形式の行を生成（/ = dir, @ = symlink）"""
  name = p.name
  if p.is_dir() and not p.is_symlink():
    return name + "/"
  if p.is_symlink():
    return name + "@"
  return name


def list_dir_entries_python(root: Path, base_dir: Path, path_prefix: Optional[str] = None) -> List[FileEntryModel]:
  """Path.iterdir で一覧取得（symlink 展開用、subprocess に依存しない）"""
  if not base_dir.exists() or not base_dir.is_dir():
    return []
  out: List[FileEntryModel] = []
  try:
    entries = sorted(base_dir.iterdir(), key=lambda p: p.name.lower())
  except Exception:
    return []
  for p in entries[:MAX_CHILDREN_PER_DIR]:
    if p.name.startswith("."):
      continue
    row = _ls_row_from_path(base_dir, p)
    item = build_entry_from_name(root, base_dir, row, path_prefix=path_prefix)
    if item is not None:
      out.append(item)
  return out


def list_dir_entries(root: Path, base_dir: Path, path_prefix: Optional[str] = None) -> List[FileEntryModel]:
  if not base_dir.exists() or not base_dir.is_dir():
    return []
  try:
    proc = subprocess.run(
      ["ls", "-1AF", str(base_dir)],
      check=True,
      capture_output=True,
      text=True,
      encoding="utf-8",
      errors="replace",
    )
  except subprocess.CalledProcessError:
    return []

  rows = [r for r in proc.stdout.splitlines() if r.strip()]
  rows = rows[:MAX_CHILDREN_PER_DIR]
  out: List[FileEntryModel] = []
  for row in rows:
    item = build_entry_from_name(root, base_dir, row, path_prefix=path_prefix)
    if item is not None:
      out.append(item)
  return out


def serialize_file_tree(root: Path) -> List[FileEntryModel]:
  # Keep initial payload shallow for responsiveness; children are loaded lazily.
  root_children = list_dir_entries(root, root)
  return [build_entry(root, root, children=root_children)]


def _cleanup_old_staged_files():
  """relay 上の古い .staged_for_download* と .staged_uploads/* を削除（1 時間以上経過）"""
  cutoff = time.time() - 3600.0
  try:
    for wid_dir in SESSIONS_ROOT.iterdir() if SESSIONS_ROOT.exists() else []:
      if not wid_dir.is_dir():
        continue
      for sess_dir in wid_dir.iterdir():
        if not sess_dir.is_dir():
          continue
        try:
          for p in sess_dir.glob(".staged_for_download*"):
            if p.is_file() and p.stat().st_mtime < cutoff:
              p.unlink(missing_ok=True)
          uploads = sess_dir / ".staged_uploads"
          if uploads.is_dir():
            for p in uploads.iterdir():
              if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except Exception:
          pass
  except Exception:
    pass


app = FastAPI(title="SyncTerm Web Backend")

app.add_middleware(
  CORSMiddleware,
  allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)


@app.on_event("startup")
def _startup_cleanup_staged():
  _cleanup_old_staged_files()


@app.get("/info")
def backend_info():
  """デバッグ用: バックエンドが参照しているパスと _registry の状態。Watcher が一覧に出ないときに確認用。"""
  import time
  now = time.time()
  registry_files: List[str] = []
  file_states: List[dict] = []
  if REGISTRY_ROOT.exists():
    for path in sorted(REGISTRY_ROOT.glob("*.json"), key=lambda p: p.name.lower()):
      registry_files.append(path.name)
      try:
        data = json.loads(path.read_text("utf-8"))
        ts = data.get("last_heartbeat") or data.get("last_seen") or data.get("heartbeat_ts") or path.stat().st_mtime
        age_sec = now - float(ts) if ts is not None else None
        file_states.append({"file": path.name, "age_sec": round(age_sec, 1) if age_sec is not None else None, "included": age_sec is not None and age_sec <= 30.0})
      except Exception:
        file_states.append({"file": path.name, "age_sec": None, "included": False})
  return {
    "registry_root": str(REGISTRY_ROOT),
    "sessions_root": str(SESSIONS_ROOT),
    "registry_files": registry_files,
    "file_states": file_states,
    "watcher_count": len(load_watchers()),
  }


@app.get("/tools/fetch")
def fetch_url(url: str, max_chars: int = 8000):
  """
  シンプルな Web 情報取得用エンドポイント。

  - http(s) のみ許可
  - HTML の場合はタグを落としてプレーンテキスト化
  - 返却テキストは max_chars でカット（フロント／Agent が要約しやすいように）
  """
  url = url.strip()
  if not url:
    raise HTTPException(status_code=400, detail="url is required")
  if not (url.startswith("http://") or url.startswith("https://")):
    raise HTTPException(status_code=400, detail="only http/https URLs are allowed")

  req = urllib.request.Request(url, headers={"User-Agent": "SyncTerm-Buddy/0.1"})
  try:
    with urllib.request.urlopen(req, timeout=15) as resp:
      raw = resp.read()
      ctype = resp.headers.get("Content-Type", "")
  except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", errors="replace")
    raise HTTPException(status_code=e.code, detail=f"HTTP error from upstream: {detail[:2000]}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"Failed to fetch URL: {e}")

  # テキスト系のみ扱う
  text: str
  try:
    text = raw.decode("utf-8", errors="replace")
  except Exception:
    text = raw.decode("latin-1", errors="replace")

  if "html" in ctype.lower():
    text = _html_to_text(text)

  if max_chars > 0:
    text = text[:max_chars]

  return {
    "url": url,
    "contentType": ctype,
    "text": text,
  }


@app.get("/health")
def health():
  """デプロイ確認用: このバックエンドがファイル操作ルート (POST /files 等) を持つか返す"""
  return {"status": "ok", "file_ops": True}


@app.get("/watchers", response_model=List[WatcherModel])
def list_watchers():
  return load_watchers()


DEFAULT_SESSION_NAME = "default"


@app.get("/watchers/{wid}/sessions", response_model=List[SessionModel])
def list_sessions(wid: str):
  root = SESSIONS_ROOT / wid
  if not root.exists():
    return []
  sessions: List[SessionModel] = []
  for d in sorted(root.iterdir()):
    if d.is_dir():
      sessions.append(SessionModel(name=d.name, watcherId=wid))
  # Watcher にセッションが一つも無い場合は default を自動作成（初起動時など）
  if not sessions:
    default_root = root / DEFAULT_SESSION_NAME
    try:
      default_root.mkdir(parents=True, exist_ok=False)
      sessions.append(SessionModel(name=DEFAULT_SESSION_NAME, watcherId=wid))
    except OSError:
      pass
  return sessions


@app.post("/watchers/{wid}/sessions", response_model=SessionModel)
def create_session(wid: str, body: CreateSessionModel):
  """Relay 上にセッション用ディレクトリを作成する。GET は一覧、POST は作成。名前は / .. 不可・空白不可。"""
  name = (body.name or "").strip()
  if not name:
    raise HTTPException(status_code=400, detail="session name is required")
  if "/" in name or ".." in name or "\\" in name:
    raise HTTPException(status_code=400, detail="session name must not contain / \\ or ..")
  root = SESSIONS_ROOT / wid / name
  if root.exists():
    raise HTTPException(status_code=409, detail="session already exists")
  try:
    root.mkdir(parents=True, exist_ok=False)
  except OSError as e:
    raise HTTPException(status_code=500, detail=str(e))
  return SessionModel(name=name, watcherId=wid)


@app.get("/watchers/{wid}/sessions/{sess}/status", response_model=WatcherStatusModel)
def get_status(wid: str, sess: str):
  root = session_root(wid, sess)
  status_path = root / ".watcher_status.json"
  if not status_path.exists():
    raise HTTPException(status_code=404, detail="status file not found")
  try:
    data = json.loads(status_path.read_text("utf-8"))
  except Exception:
    raise HTTPException(status_code=500, detail="status file invalid")
  return WatcherStatusModel(
    user=data.get("user", ""),
    host=data.get("host", ""),
    cwd=data.get("cwd", ""),
    fullCwd=data.get("full_cwd", ""),
    condaEnv=data.get("conda_env"),
    dockerMode=data.get("docker_mode"),
  )


@app.get("/watchers/{wid}/sessions/{sess}/debug/rt")
def debug_rt(wid: str, sess: str):
  """RT モードの接続テスト。HTTP で echo コマンドを送り、応答または失敗理由を返す"""
  port = _get_rt_port(wid)
  if port is None:
    return {"ok": False, "error": "rt_port not found", "port": None}
  url = f"http://127.0.0.1:{port}/command"
  body = json.dumps({"watcherId": wid, "session": sess, "command": "echo __RT_TEST__"}, ensure_ascii=False).encode("utf-8")
  try:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
    return {"ok": True, "port": port, "response": data}
  except urllib.error.URLError as e:
    reason = e.reason if e.reason else str(e)
    return {"ok": False, "error": f"HTTP request failed: {reason}", "port": port}
  except Exception as e:
    return {"ok": False, "error": f"HTTP request failed: {type(e).__name__}: {e}", "port": port}


@app.get("/watchers/{wid}/sessions/{sess}/debug/file-raw")
def debug_file_raw(wid: str, sess: str, path: str = Query(..., description="path like /SyncTerm-IDE/foo.png")):
  """file-raw の RT 経路診断。実際のファイルは返さず、結果のみ JSON で返す"""
  rel = normalize_rel_path(path)
  result = {"path": path, "rel": rel, "rt_port": None, "rt_ok": False, "has_base64": False, "size": None, "error": None}
  port = _get_rt_port(wid)
  result["rt_port"] = port
  if port is None:
    result["error"] = "rt_port not found"
    return result
  token = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
  cmd = f"_internal_stage_file_for_download::{rel}::{token}"
  resp, _ = _post_command_via_rt_with_response(wid, sess, cmd)
  if resp is None:
    result["error"] = "HTTP request to watcher failed (timeout or connection refused)"
    return result
  result["rt_ok"] = resp.get("ok") is True
  b64 = resp.get("file_content_base64")
  if isinstance(b64, str):
    result["has_base64"] = True
    try:
      result["size"] = len(base64.b64decode(b64))
    except Exception as e:
      result["error"] = f"base64 decode failed: {e}"
  elif resp.get("file_content") is not None:
    result["error"] = "watcher returned file_content (text) not file_content_base64; image needs binary"
  else:
    result["error"] = "watcher response had no file_content_base64 (file missing, too large, or watcher error)"
  return result


@app.get("/watchers/{wid}/sessions/{sess}/debug/symlink")
def debug_symlink(wid: str, sess: str, path: str = Query(..., description="path like /mylink")):
  """symlink 展開の診断用（問題特定後は削除可）"""
  root = session_root(wid, sess)
  target = resolve_session_file(root, path)
  rel = path.lstrip("/") or "."
  info: dict = {
    "path": path,
    "rel": rel,
    "target_str": str(target),
    "target_exists": target.exists(),
    "target_is_symlink": target.is_symlink() if target.exists() else False,
    "resolved_str": None,
    "resolved_exists": None,
    "resolved_is_dir": None,
    "direct_entries_count": None,
    "watcher_fallback": None,
    "error": None,
  }
  try:
    if target.exists() and target.is_symlink():
      resolved = target.resolve(strict=False)
      info["resolved_str"] = str(resolved)
      info["resolved_exists"] = resolved.exists()
      info["resolved_is_dir"] = resolved.is_dir() if resolved.exists() else False
      if resolved.exists() and resolved.is_dir():
        entries = list_dir_entries_python(root, resolved, path_prefix=rel)
        info["direct_entries_count"] = len(entries)
      else:
        info["watcher_fallback"] = "resolved not exists or not dir"
    else:
      info["watcher_fallback"] = "target not symlink or not exists"
  except Exception as e:
    info["error"] = str(e)
  return info


@app.get("/watchers/{wid}/sessions/{sess}/files", response_model=List[FileEntryModel])
def get_file_tree(
  wid: str,
  sess: str,
  path: str = Query("/", description="root path, currently ignored"),
  source: str = Query("relay", description="relay | watcher"),
):
  root = session_root(wid, sess)
  if (source or "").strip().lower() == "watcher":
    # RT がある場合は Watcher 経由で root の children を取得し、relay mirror の遅延を避ける
    children = list_dir_entries_via_watcher(wid, sess, root, ".")
    return [build_entry(root, root, children=children)]
  return serialize_file_tree(root)


@app.get("/watchers/{wid}/sessions/{sess}/files/children", response_model=List[FileEntryModel])
def get_file_children(wid: str, sess: str, path: str = Query("/", description="dir path under session root")):
  root = session_root(wid, sess)
  target = resolve_session_file(root, path)
  rel = path.lstrip("/") or "."

  # Symlink: まず relay 上で解決して直接一覧取得を試す（RT モードで Watcher が別マシンの場合、symlink 先が relay 上にあれば成功）
  if target.is_symlink():
    try:
      resolved = target.resolve(strict=False)
      if resolved.exists() and resolved.is_dir():
        return list_dir_entries_python(root, resolved, path_prefix=rel)
    except Exception:
      pass
    return list_dir_entries_via_watcher(wid, sess, root, rel)

  if not target.exists():
    return list_dir_entries_via_watcher(wid, sess, root, rel)

  if not target.is_dir():
    return []
  return list_dir_entries(root, target)


@app.get("/watchers/{wid}/sessions/{sess}/file")
def get_file_content(wid: str, sess: str, path: str = Query(..., description="absolute-ish path like /src/main.py")):
  root = session_root(wid, sess)
  rel = normalize_rel_path(path)
  target = resolve_session_file(root, path)
  use_watcher = path_has_symlink_component(root, rel)
  if use_watcher or (not target.exists()) or (not target.is_file()):
    # symlink / watcher-only path fallback
    return {"path": path, "content": fetch_file_via_watcher(root, rel, wid=wid, sess=sess)}
  size = target.stat().st_size
  if size > MAX_FILE_BYTES:
    raise HTTPException(
      status_code=413,
      detail=f"file too large for full-load editor ({size} bytes > {MAX_FILE_BYTES} bytes)"
    )
  try:
    text = target.read_text("utf-8")
  except UnicodeDecodeError:
    raise HTTPException(status_code=400, detail="binary file not supported")
  return {"path": path, "content": text}


@app.get("/watchers/{wid}/sessions/{sess}/file-chunk", response_model=FileChunkModel)
def get_file_chunk(
  wid: str,
  sess: str,
  path: str = Query(...),
  offset: int = Query(0, ge=0),
  length: int = Query(MAX_CHUNK_BYTES, ge=1, le=MAX_CHUNK_BYTES),
):
  root = session_root(wid, sess)
  rel = normalize_rel_path(path)
  target = resolve_session_file(root, path)
  use_watcher = path_has_symlink_component(root, rel)
  if use_watcher or (not target.exists()) or (not target.is_file()):
    # fallback for watcher-only path (e.g., symlink target not on relay fs)
    text = fetch_file_via_watcher(root, rel, wid=wid, sess=sess)
    total = len(text.encode("utf-8", errors="replace"))
    if offset > total:
      offset = total
    # For fallback, chunk by character index for simplicity.
    part = text[offset: offset + length]
    next_offset = offset + len(part)
    return FileChunkModel(
      path=path,
      offset=offset,
      length=len(part.encode("utf-8", errors="replace")),
      totalSize=total,
      content=part,
      hasMore=next_offset < len(text),
      nextOffset=next_offset,
    )

  total = target.stat().st_size
  if offset > total:
    offset = total

  with target.open("rb") as f:
    f.seek(offset)
    data = f.read(length)

  text = data.decode("utf-8", errors="replace")
  next_offset = offset + len(data)
  return FileChunkModel(
    path=path,
    offset=offset,
    length=len(data),
    totalSize=total,
    content=text,
    hasMore=next_offset < total,
    nextOffset=next_offset,
  )


@app.put("/watchers/{wid}/sessions/{sess}/file")
def put_file_content(wid: str, sess: str, payload: FileContentPayload):
  root = session_root(wid, sess)
  rel = normalize_rel_path(payload.path)
  # Always use watcher staging semantics so symlink targets on watcher are supported.
  save_file_via_watcher(root, rel, payload.content, wid=wid, sess=sess)
  return {"ok": True}


@app.get("/watchers/{wid}/sessions/{sess}/file-raw")
def get_file_raw(wid: str, sess: str, path: str = Query(..., description="path under session root")):
  root = session_root(wid, sess)
  rel = normalize_rel_path(path)
  target = resolve_session_file(root, path)
  use_watcher = path_has_symlink_component(root, rel)

  if (not use_watcher) and target.exists() and target.is_file():
    size = target.stat().st_size
    if size > MAX_RAW_FILE_BYTES:
      raise HTTPException(
        status_code=413,
        detail=f"file too large for preview ({size} bytes > {MAX_RAW_FILE_BYTES} bytes)"
      )
    data = target.read_bytes()
  else:
    data = fetch_file_bytes_via_watcher(root, rel, wid=wid, sess=sess)
    if len(data) > MAX_RAW_FILE_BYTES:
      raise HTTPException(
        status_code=413,
        detail=f"file too large for preview ({len(data)} bytes > {MAX_RAW_FILE_BYTES} bytes)"
      )

  mime, _ = mimetypes.guess_type(path)
  return Response(content=data, media_type=mime or "application/octet-stream")


@app.get("/watchers/{wid}/sessions/{sess}/log", response_model=LogChunk)
def get_log_chunk(wid: str, sess: str, fromOffset: int = 0):
  # RT モードでは Relay にセッション dir が無いことがあるため 404 にしない
  root = SESSIONS_ROOT / wid / sess
  log_path = root / "commands.log"
  if not root.exists() or not log_path.exists():
    return LogChunk(lines=[], nextOffset=0, hasMore=False)

  total_size = log_path.stat().st_size
  if fromOffset < 0:
    fromOffset = 0
  if fromOffset > total_size:
    fromOffset = total_size

  # 先頭から順に返す。再アクセス・他デバイスからでも保存済みログを最初から取得できる。
  start = fromOffset

  with log_path.open("rb") as f:
    f.seek(start)
    chunk = f.read(MAX_LOG_CHUNK_BYTES)

  try:
    text = chunk.decode("utf-8", errors="replace")
  except Exception:
    text = ""

  # 進捗バーなどの \r（キャリッジリターン）を「同じ行の上書き」として扱う。
  # 文字列を \n 単位で分割し、その中で最後の \r 以降だけを残すことで、
  # "aaa\rbbb\rccc\n" のような出力は最終状態 "ccc" だけが 1 行として表示される。
  # 通常の出力には影響しないよう、\n が無い場合もそのまま 1 行として扱う。
  raw_lines = text.split("\n")
  lines: List[str] = []
  for raw in raw_lines:
    if not raw:
      continue
    cleaned = raw.split("\r")[-1]
    cleaned = cleaned.strip("\r")
    if cleaned:
      # Trim pathological long lines so frontend rendering remains responsive.
      lines.append(cleaned[:4000])
  next_offset = start + len(chunk)
  return LogChunk(lines=lines, nextOffset=next_offset, hasMore=next_offset < total_size)


def _get_rt_port(wid: str) -> Optional[int]:
  """RT モードの Watcher が登録しているポートを取得"""
  port_file = REGISTRY_ROOT / f"{wid}.rt_port"
  if not port_file.exists():
    return None
  try:
    return int(port_file.read_text("utf-8").strip())
  except Exception:
    return None


def _post_command_via_rt(wid: str, sess: str, command: str) -> tuple[bool, str]:
  """RT 経由でコマンド送信。(成功したか, 失敗時は理由)"""
  port = _get_rt_port(wid)
  if port is None:
    return False, "rt_port_not_found"
  url = f"http://127.0.0.1:{port}/command"
  body = json.dumps({"watcherId": wid, "session": sess, "command": command}, ensure_ascii=False).encode("utf-8")
  try:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
      return (resp.status == 200), ""
  except urllib.error.URLError as e:
    return False, str(e.reason) if e.reason else str(e)
  except Exception as e:
    return False, str(e)


def _post_command_via_rt_with_response(wid: str, sess: str, command: str, timeout: int = 7200) -> tuple[Optional[dict], str]:
  """RT 経由でコマンド送信し、(レスポンス JSON, 失敗時は理由) を返す。Watcher が 404 の場合は reason に 'session_not_found' を返す。timeout は秒（省略時 7200）。"""
  port = _get_rt_port(wid)
  if port is None:
    return None, "rt_port_not_found"
  url = f"http://127.0.0.1:{port}/command"
  body = json.dumps({"watcherId": wid, "session": sess, "command": command}, ensure_ascii=False).encode("utf-8")
  try:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
      return json.loads(resp.read().decode("utf-8", errors="replace")), ""
  except urllib.error.HTTPError as e:
    if e.code == 404:
      return None, "session_not_found"
    return None, f"HTTP {e.code}"
  except urllib.error.URLError as e:
    return None, str(e.reason) if e.reason else str(e)
  except Exception as e:
    return None, str(e)


def _post_gpu_status_via_rt(wid: str, sess: str) -> tuple[Optional[dict], str]:
  """Watcher の /gpu-status を呼ぶ。command は空で送り、Watcher 側で nvitop 優先→nvidia-smi フォールバック。"""
  port = _get_rt_port(wid)
  if port is None:
    return None, "rt_port_not_found"
  url = f"http://127.0.0.1:{port}/gpu-status"
  body = json.dumps({"watcherId": wid, "session": sess, "command": ""}, ensure_ascii=False).encode("utf-8")
  try:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
      return data, ""
  except urllib.error.HTTPError as e:
    if e.code == 404:
      return None, "session_not_found"
    return None, f"HTTP {e.code}"
  except urllib.error.URLError as e:
    return None, str(e.reason) if e.reason else str(e)
  except Exception as e:
    return None, str(e)


@app.post("/watchers/{wid}/sessions/{sess}/log-append")
async def post_log_append(wid: str, sess: str, request: Request):
  """RT Watcher からログを即時受信（リバーストンネル用）"""
  root = session_root(wid, sess)
  body = await request.body()
  log_file = root / "commands.log"
  log_file.parent.mkdir(parents=True, exist_ok=True)
  text = body.decode("utf-8", errors="replace")
  if text and not text.endswith("\n"):
    text += "\n"
  with log_file.open("ab") as f:
    f.write(text.encode("utf-8"))
  return {"ok": True}


@app.get("/watchers/{wid}/rt-status")
def get_rt_status(wid: str):
  """RT モード診断: rt_port ファイルの有無とポート番号を返す"""
  port = _get_rt_port(wid)
  port_file = REGISTRY_ROOT / f"{wid}.rt_port"
  return {
    "registry_root": str(REGISTRY_ROOT),
    "rt_port_file_exists": port_file.exists(),
    "rt_port": port,
  }


@app.get("/watchers/{wid}/sessions/{sess}/gpu-status")
def get_gpu_status(wid: str, sess: str):
  """Watcher の /gpu-status。nvitop 優先、失敗時は nvidia-smi（GPU+プロセス）。ターミナルには流さない。"""
  data, reason = _post_gpu_status_via_rt(wid, sess)
  if data is None:
    return {"output": "", "error": reason, "ok": False, "source": "nvidia-smi"}
  output = data.get("output", "")
  source = data.get("source", "nvidia-smi")
  result = {
    "output": output,
    "exitCode": data.get("exitCode"),
    "ok": data.get("ok", False),
    "source": source,
  }
  if source == "nvitop" and output.strip().startswith("{"):
    try:
      result["data"] = json.loads(output)
    except Exception:
      pass
  return result


@app.post("/watchers/{wid}/sessions/{sess}/commands")
def post_command(wid: str, sess: str, payload: CommandPayload):
  cmd = payload.command.rstrip()
  logger.info("command received wid=%s sess=%s cmd_len=%d cmd_preview=%r", wid, sess, len(cmd), (cmd[:60] + "..") if len(cmd) > 60 else cmd)

  # RT を先に試す（Relay にセッション dir が無くても Watcher に届く）
  rt_resp, rt_error = _post_command_via_rt_with_response(wid, sess, cmd)
  if rt_resp is not None:
    out = _strip_cmd_exit_markers(rt_resp.get("output", ""))
    exit_code = rt_resp.get("exitCode", 0)
    out_lines = len(out.splitlines()) if out else 0
    logger.info("command delivered via RT wid=%s sess=%s output_lines=%d exitCode=%s", wid, sess, out_lines, exit_code)
    # RT 成功時は commands.txt に書かない（Watcher が rsync pull で commands.txt を読んで再実行するため二重実行になる）
    return {
      "ok": True,
      "rt": True,
      "output": out,
      "exitCode": exit_code,
      "_trace": {"method": "rt", "outputLineCount": out_lines, "exitCode": exit_code},
    }

  # rt_port がある = RT 用 Watcher。届かなかったら 503 で理由を返す（commands.txt は別マシンでは読めない）
  rt_port = _get_rt_port(wid)
  if rt_port is not None:
    logger.warning("command RT failed wid=%s sess=%s rt_error=%s", wid, sess, rt_error)
    raise HTTPException(
      status_code=503,
      detail={
        "code": "rt_delivery_failed",
        "rt_failed_reason": rt_error,
        "hint": f"Relay→Watcher の HTTP が失敗しました（{rt_error}）。接続診断の「RT 接続テスト」で詳細を確認してください。",
      },
    )

  # フォールバック: commands.txt に追記（Relay にセッション dir が必要・同一/共有 FS 用）
  root = SESSIONS_ROOT / wid / sess
  if not root.exists():
    logger.warning("command no session dir wid=%s sess=%s rt_error=%s", wid, sess, rt_error)
    raise HTTPException(
      status_code=503,
      detail={
        "code": "command_delivery_failed",
        "rt_failed_reason": rt_error,
        "hint": "RT failed and session dir does not exist on relay. Check: 1) Watcher is running (watcher_manager_rt.sh), 2) Relay app root (e.g. ~/SyncTerm-IDE) has sessions/_registry, 3) GET /watchers/{wid}/rt-status to see rt_port.",
      },
    )
  cmd_file = root / "commands.txt"
  cmd_file.parent.mkdir(parents=True, exist_ok=True)
  with cmd_file.open("a", encoding="utf-8") as f:
    f.write(cmd + "\n")
  logger.info("command written to commands.txt wid=%s sess=%s path=%s", wid, sess, cmd_file)
  return {"ok": True, "_trace": {"method": "commands_txt"}}


@app.post("/watchers/{wid}/sessions/{sess}/cleanup-staged")
def cleanup_staged(wid: str, sess: str):
  """現在セッションの .staged_for_download* と .staged_uploads/* を一括削除（relay と Watcher 両方）。
  RT モードでは relay にセッション dir が無いことがあるため、無くても 404 にせず Watcher 側のみ削除する。"""
  root = SESSIONS_ROOT / wid / sess
  relay_session_exists = root.exists()
  deleted = 0
  failed = 0
  if relay_session_exists:
    for p in root.glob(".staged_for_download*"):
      if p.is_file():
        try:
          p.unlink(missing_ok=True)
          deleted += 1
        except OSError:
          try:
            os.chmod(p, 0o644)
            p.unlink(missing_ok=True)
            deleted += 1
          except Exception:
            failed += 1
    uploads = root / ".staged_uploads"
    if uploads.is_dir():
      for p in uploads.iterdir():
        if p.is_file():
          try:
            p.unlink(missing_ok=True)
            deleted += 1
          except OSError:
            try:
              os.chmod(p, 0o644)
              p.unlink(missing_ok=True)
              deleted += 1
            except Exception:
              failed += 1
    cmd_file = root / "commands.txt"
    offset_file = root / ".commands.offset"
    try:
      if cmd_file.exists():
        cmd_file.write_text("", encoding="utf-8")
      if offset_file.exists():
        offset_file.write_text("0", encoding="utf-8")
    except Exception as e:
      logger.warning("commands.txt/offset reset failed wid=%s sess=%s: %s", wid, sess, e)
  watcher_cleaned = _post_command_via_rt(wid, sess, "_internal_cleanup_staged")[0]
  return {
    "ok": True,
    "deleted": deleted,
    "failed": failed,
    "watcher_cleaned": watcher_cleaned,
    "relay_session_exists": relay_session_exists,
  }


@app.post("/watchers/{wid}/sessions/{sess}/clear-commands")
def clear_commands(wid: str, sess: str):
  """commands.txt と .commands.offset のみを Relay と Watcher 両方でクリアする（staged ファイルは触らない）。"""
  root = SESSIONS_ROOT / wid / sess
  relay_done = False
  if root.exists():
    cmd_file = root / "commands.txt"
    offset_file = root / ".commands.offset"
    try:
      if cmd_file.exists():
        cmd_file.write_text("", encoding="utf-8")
      if offset_file.exists():
        offset_file.write_text("0", encoding="utf-8")
      relay_done = True
    except Exception as e:
      logger.warning("clear-commands relay failed wid=%s sess=%s: %s", wid, sess, e)
  watcher_cleaned = _post_command_via_rt(wid, sess, "_internal_clear_commands")[0]
  return {"ok": True, "relay_cleared": relay_done, "watcher_cleaned": watcher_cleaned}


def list_dir_entries_via_watcher(wid: str, sess: str, root: Path, rel_path: str) -> List[FileEntryModel]:
  # RT モード: HTTP で即送信し、レスポンスの ls_result を直接使う（rsync 待ち不要）
  cmd = f"_internal_list_dir::{rel_path}"
  resp, _ = _post_command_via_rt_with_response(wid, sess, cmd)
  if resp is not None:
    ls_result = resp.get("ls_result")
    if ls_result is not None and isinstance(ls_result, str) and not ls_result.startswith("ERROR:"):
      return _parse_ls_result_to_entries(rel_path, ls_result)

  # フォールバック: commands.txt 経由（従来モード or RT で HTTP 失敗時）
  cmd_file = root / "commands.txt"
  log_file = root / "commands.log"
  ls_file = root / ".ls_result.txt"

  start_size = log_file.stat().st_size if log_file.exists() else 0
  before_ls_mtime = ls_file.stat().st_mtime if ls_file.exists() else -1.0

  cmd_file.parent.mkdir(parents=True, exist_ok=True)
  with cmd_file.open("a", encoding="utf-8") as f:
    f.write(cmd + "\n")

  deadline = time.time() + 12.0
  saw_done = False
  saw_any_ls_done = False
  while time.time() < deadline:
    if ls_file.exists():
      try:
        now_mtime = ls_file.stat().st_mtime
        if before_ls_mtime < 0 or now_mtime > before_ls_mtime:
          saw_done = True
          break
      except Exception:
        pass
    if log_file.exists():
      try:
        with log_file.open("rb") as lf:
          lf.seek(start_size)
          chunk = lf.read().decode("utf-8", errors="replace")
        if "__LS_DONE__::" in chunk:
          saw_any_ls_done = True
        if f"__LS_DONE__::{rel_path}" in chunk:
          saw_done = True
          break
      except Exception:
        pass
    time.sleep(0.2)

  # Fallback: accept generic LS completion if result file exists.
  if not saw_done and saw_any_ls_done and ls_file.exists():
    saw_done = True

  if not saw_done:
    return []
  # __LS_DONE__ で break した場合、.ls_result.txt が rsync で届くまで待つ（最大 8 秒）
  if not ls_file.exists():
    file_deadline = time.time() + 8.0
    while time.time() < file_deadline:
      if ls_file.exists():
        break
      time.sleep(0.3)
  if not ls_file.exists():
    return []
  if before_ls_mtime >= 0 and ls_file.stat().st_mtime <= before_ls_mtime:
    # stale result; give watcher a short extra window
    time.sleep(0.3)

  try:
    text = ls_file.read_text("utf-8", errors="replace")
  except Exception:
    return []
  return _parse_ls_result_to_entries(rel_path, text)


def _parse_ls_result_to_entries(rel_path: str, text: str) -> List[FileEntryModel]:
  """ls -p 形式の出力を FileEntryModel のリストに変換"""
  if text.startswith("ERROR:"):
    return []
  base_rel = rel_path if rel_path != "." else ""
  out: List[FileEntryModel] = []
  for raw in text.splitlines()[:MAX_CHILDREN_PER_DIR]:
    name = raw.strip()
    if not name or name in (".", ".."):
      continue
    # ls -F style suffixes:
    #   / = directory, @ = symlink, * = executable file, | = fifo, = = socket
    marker = name[-1] if name and name[-1] in ("/", "@", "*", "|", "=") else ""
    clean = name[:-1] if marker else name
    if not clean or clean.startswith("."):
      continue
    item_rel = f"{base_rel}/{clean}" if base_rel else clean
    if marker == "/":
      kind: FileKind = "dir"
      has_children = True
      is_remote_link = False
    elif marker == "@":
      kind = "symlink"
      # Watcher 側の ls はリンク先がディレクトリでも "/" を付けないため、
      # UI 側で lazy expand できるよう hasChildren を真にしておく。
      has_children = True
      is_remote_link = True
    else:
      kind = "file"
      has_children = False
      is_remote_link = False
    out.append(
      FileEntryModel(
        id=item_rel,
        name=clean,
        path="/" + item_rel,
        kind=kind,
        hasChildren=has_children,
        isRemoteLink=is_remote_link,
        children=None,
      )
    )
  return out


def wait_internal_exit(log_file: Path, start_size: int, timeout_sec: float = 12.0) -> bool:
  marker_prefix = "__CMD_EXIT_CODE__::INTERNAL:"
  deadline = time.time() + timeout_sec
  pos = start_size

  while time.time() < deadline:
    if log_file.exists():
      try:
        with log_file.open("rb") as lf:
          lf.seek(pos)
          chunk = lf.read().decode("utf-8", errors="replace")
          pos = lf.tell()
        for line in chunk.splitlines():
          if line.startswith(marker_prefix):
            code = line.split(marker_prefix, 1)[1].strip()
            return code == "0"
      except Exception:
        pass
    time.sleep(0.15)
  return False


def _strip_cmd_exit_markers(text: str) -> str:
  """Watcher 側が付与する内部マーカー行を除去する（UI へ露出させない）。"""
  if not text:
    return ""
  out_lines: List[str] = []
  for line in str(text).splitlines():
    # 例: "__CMD_EXIT_CODE__::0" / "__CMD_EXIT_CODE__::INTERNAL:0"
    if line.startswith("__CMD_EXIT_CODE__::"):
      continue
    out_lines.append(line)
  # 元の末尾改行は UI 的に重要ではないので統一
  return "\n".join(out_lines).strip("\n")


def _count_command_lines(cmd_file: Path) -> int:
  if not cmd_file.exists():
    return 0
  try:
    with cmd_file.open("rb") as f:
      return f.read().count(b"\n")
  except Exception:
    return 0


def _read_commands_offset(offset_file: Path) -> int:
  if not offset_file.exists():
    return 0
  try:
    return int(offset_file.read_text("utf-8", errors="replace").strip() or "0")
  except Exception:
    return 0


def append_command_and_wait_processed(root: Path, command: str, timeout_sec: float = 20.0) -> bool:
  cmd_file = root / "commands.txt"
  offset_file = root / ".commands.offset"
  cmd_file.parent.mkdir(parents=True, exist_ok=True)

  target_offset = _count_command_lines(cmd_file) + 1
  with cmd_file.open("a", encoding="utf-8") as f:
    f.write(command.rstrip() + "\n")

  deadline = time.time() + timeout_sec
  while time.time() < deadline:
    if _read_commands_offset(offset_file) >= target_offset:
      return True
    time.sleep(0.15)
  return False


def request_staged_file_from_watcher(root: Path, rel_path: str, timeout_sec: float = 20.0) -> Path:
  # Preferred path: tokenized staging (new watcher behavior).
  token = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
  token_file = root / f".staged_for_download.{token}"
  try:
    token_file.unlink(missing_ok=True)
  except Exception:
    pass
  ok = append_command_and_wait_processed(
    root,
    f"_internal_stage_file_for_download::{rel_path}::{token}",
    timeout_sec=timeout_sec
  )
  if ok and token_file.exists():
    return token_file

  # Backward-compatible fallback: legacy fixed staged filename.
  legacy_file = root / ".staged_for_download"
  before_mtime = legacy_file.stat().st_mtime if legacy_file.exists() else -1.0
  stage_started_ts = time.time()
  ok = append_command_and_wait_processed(
    root,
    f"_internal_stage_file_for_download::{rel_path}",
    timeout_sec=timeout_sec
  )
  if not ok:
    raise HTTPException(status_code=404, detail="watcher failed to stage file")

  deadline = time.time() + timeout_sec
  threshold = max(before_mtime + 1e-6, stage_started_ts - 0.25)
  while time.time() < deadline:
    if legacy_file.exists():
      try:
        if legacy_file.stat().st_mtime >= threshold:
          return legacy_file
      except Exception:
        pass
    time.sleep(0.15)
  raise HTTPException(status_code=404, detail="staged file not found")


def fetch_file_via_watcher_rt(wid: str, sess: str, rel_path: str) -> Optional[str]:
  """RT モードで HTTP 経由でファイル内容を取得。取れればその文字列、失敗時は None"""
  token = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
  cmd = f"_internal_stage_file_for_download::{rel_path}::{token}"
  resp, _ = _post_command_via_rt_with_response(wid, sess, cmd)
  if resp is None:
    return None
  content = resp.get("file_content")
  if isinstance(content, str):
    return content
  return None


def fetch_file_via_watcher(root: Path, rel_path: str, wid: Optional[str] = None, sess: Optional[str] = None) -> str:
  # RT モード: HTTP で即取得を試す
  if wid is not None and sess is not None:
    content = fetch_file_via_watcher_rt(wid, sess, rel_path)
    if content is not None:
      return content
  staged_file = request_staged_file_from_watcher(root, rel_path, timeout_sec=20.0)

  try:
    return staged_file.read_text("utf-8")
  except UnicodeDecodeError:
    raise HTTPException(status_code=400, detail="binary file not supported")
  finally:
    try:
      staged_file.unlink(missing_ok=True)
    except Exception:
      pass


def fetch_file_bytes_via_watcher_rt(wid: str, sess: str, rel_path: str) -> Optional[bytes]:
  """RT モードで HTTP 経由でバイナリ取得。取れれば bytes、失敗時は None"""
  token = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
  cmd = f"_internal_stage_file_for_download::{rel_path}::{token}"
  resp, _ = _post_command_via_rt_with_response(wid, sess, cmd)
  if resp is None:
    return None
  b64 = resp.get("file_content_base64")
  if isinstance(b64, str):
    try:
      return base64.b64decode(b64)
    except Exception:
      return None
  return None


def fetch_file_bytes_via_watcher(root: Path, rel_path: str, wid: Optional[str] = None, sess: Optional[str] = None) -> bytes:
  if wid is not None and sess is not None:
    data = fetch_file_bytes_via_watcher_rt(wid, sess, rel_path)
    if data is not None:
      return data
  staged_file = request_staged_file_from_watcher(root, rel_path, timeout_sec=20.0)

  try:
    return staged_file.read_bytes()
  except Exception:
    raise HTTPException(status_code=500, detail="failed to read staged file")
  finally:
    try:
      staged_file.unlink(missing_ok=True)
    except Exception:
      pass


def save_file_via_watcher_rt(wid: str, sess: str, rel_path: str, content: str) -> bool:
  """RT モードで HTTP 経由で保存。成功時 True"""
  token = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
  cmd = f"_internal_move_staged_file::{token}::{rel_path}"
  body = json.dumps(
    {"watcherId": wid, "session": sess, "command": cmd, "stagedContent": content},
    ensure_ascii=False,
  ).encode("utf-8")
  port = _get_rt_port(wid)
  if port is None:
    return False
  url = f"http://127.0.0.1:{port}/command"
  try:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
      if resp.status != 200:
        return False
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
      return data.get("ok") is True
  except Exception:
    return False


def save_file_via_watcher(root: Path, rel_path: str, content: str, wid: Optional[str] = None, sess: Optional[str] = None) -> None:
  # RT モード: HTTP で即保存を試す
  if wid is not None and sess is not None and save_file_via_watcher_rt(wid, sess, rel_path, content):
    return
  staged_dir = root / ".staged_uploads"
  staged_dir.mkdir(parents=True, exist_ok=True)
  token = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
  staged_file = staged_dir / token
  if content.startswith("base64:"):
    staged_file.write_bytes(base64.b64decode(content[7:]))
  else:
    staged_file.write_text(content, encoding="utf-8")

  ok = append_command_and_wait_processed(
    root,
    f"_internal_move_staged_file::{token}::{rel_path}",
    timeout_sec=25.0
  )
  if not ok:
    raise HTTPException(status_code=500, detail="watcher failed to apply staged file")


def build_ai_prompt(payload: AiAssistPayload) -> str:
  target_text = (payload.selectedText or "").strip()
  scope_label = "selected text" if target_text else "full file"
  scope_text = target_text if target_text else payload.fileContent
  return (
    "You are a concise coding assistant. Think carefully about the best change, but RETURN ONLY the edited code text.\n"
    "Do not include markdown fences, comments explaining the change, or placeholder code such as '...' or 'pass' unless the original also used them intentionally.\n"
    "Always return valid, directly usable code that can replace the target scope.\n"
    f"Action: {payload.action}\n"
    f"User instruction: {payload.prompt}\n"
    f"File path: {payload.path}\n"
    f"Scope: {scope_label}\n\n"
    "Input:\n"
    f"{scope_text}"
  )


def _cleanup_llm_output(text: str, max_repeats: int = 2) -> str:
  """LLM 出力の単純な後処理。

  - 全く同じ行が max_repeats 回を超えて現れる場合、以降を削除して重複を抑制する。
  - 空行はそのまま維持する。
  """
  lines = text.splitlines()
  seen: dict[str, int] = {}
  out: list[str] = []
  for line in lines:
    key = line.strip()
    if key == "":
      out.append(line)
      continue
    count = seen.get(key, 0)
    if count < max_repeats:
      out.append(line)
      seen[key] = count + 1
    # それ以上はスキップ
  return "\n".join(out)


def _call_ollama_with_meta(
  messages: list,
  max_tokens: int = 512,
  temperature: float = 0.2,
  model: Optional[str] = None,
) -> Tuple[str, bool]:
  """Ollama を呼ぶ（API キー不要。Relay 上で ollama serve を起動しておく）。

  戻り値は (content, truncated)。truncated は done_reason が length のとき True。
  """
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  model = model or os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b")
  device = os.environ.get("AI_DEVICE", "cpu").lower()
  options: Dict[str, Any] = {"temperature": temperature, "num_predict": max_tokens}
  if device == "cpu":
    # GPU を使わず CPU のみで実行させる
    options.setdefault("num_gpu", 0)
  body = json.dumps(
    {
      "model": model,
      "messages": messages,
      "stream": False,
      "options": options,
    }
  ).encode("utf-8")
  req = urllib.request.Request(
    f"{base.rstrip('/')}/api/chat",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=120) as resp:
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
  except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", errors="replace")
    raise HTTPException(status_code=502, detail=f"Ollama error: {detail}")
  except OSError as e:
    if e.errno == 111:  # Connection refused
      base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
      raise HTTPException(
        status_code=502,
        detail=f"Ollama に接続できません（Connection refused）。Relay サーバー上で ollama serve を起動し、ollama_base_url={base} が正しいか config.ini を確認してください。"
      )
    raise HTTPException(status_code=502, detail=f"Ollama request failed: {e}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"Ollama request failed: {e}")
  try:
    content = str(data.get("message", {}).get("content", "")).strip()
    content = _cleanup_llm_output(content)
    done_reason = str(data.get("done_reason") or "").lower()
    truncated = done_reason == "length"
    return content, truncated
  except Exception:
    raise HTTPException(status_code=500, detail="invalid Ollama response format")


def _call_ollama(
  messages: list,
  max_tokens: int = 512,
  temperature: float = 0.2,
  model: Optional[str] = None,
) -> str:
  """_call_ollama_with_meta の後方互換ラッパー（content のみ返す）。"""
  content, _truncated = _call_ollama_with_meta(messages, max_tokens=max_tokens, temperature=temperature, model=model)
  return content


def _stream_ollama_chat(
  messages: list,
  max_tokens: int = 512,
  temperature: float = 0.2,
  model: Optional[str] = None,
):
  """Ollama /api/chat を stream=True で呼び出し、部分テキストを逐次 yield する。

  戻り値は {"type": "token"|"done", ...} 形式の dict を yield するイテレータ。
  """
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  model = model or os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b")
  device = os.environ.get("AI_DEVICE", "cpu").lower()
  options: Dict[str, Any] = {"temperature": temperature, "num_predict": max_tokens}
  if device == "cpu":
    options.setdefault("num_gpu", 0)
  body = json.dumps(
    {
      "model": model,
      "messages": messages,
      "stream": True,
      "options": options,
    }
  ).encode("utf-8")
  req = urllib.request.Request(
    f"{base.rstrip('/')}/api/chat",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  acc_chunks: List[str] = []
  truncated = False
  try:
    with urllib.request.urlopen(req, timeout=120) as resp:
      buf = b""
      while True:
        chunk = resp.read(4096)
        if not chunk:
          break
        buf += chunk
        while b"\n" in buf:
          line, buf = buf.split(b"\n", 1)
          line = line.strip()
          if not line:
            continue
          try:
            ev = json.loads(line.decode("utf-8", errors="replace"))
          except json.JSONDecodeError:
            continue
          msg = str((ev.get("message") or {}).get("content") or "")
          if msg:
            acc_chunks.append(msg)
            yield {"type": "token", "delta": msg}
          if ev.get("done"):
            done_reason = str(ev.get("done_reason") or "").lower()
            truncated = done_reason == "length"
  except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", errors="replace")
    raise HTTPException(status_code=502, detail=f"Ollama error: {detail}")
  except OSError as e:
    if e.errno == 111:  # Connection refused
      base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
      raise HTTPException(
        status_code=502,
        detail=(
          "Ollama に接続できません（Connection refused）。"
          f"Relay サーバー上で ollama serve を起動し、ollama_base_url={base} が正しいか config.ini を確認してください。"
        ),
      )
    raise HTTPException(status_code=502, detail=f"Ollama request failed: {e}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"Ollama request failed: {e}")

  full = _cleanup_llm_output("".join(acc_chunks))
  yield {"type": "done", "result": full, "truncated": truncated}


def _call_openai_with_meta(
  messages: list,
  max_tokens: int = 512,
  temperature: float = 0.2,
) -> Tuple[str, bool]:
  """OpenAI Chat Completions API を呼び、(content, truncated) を返す。"""
  api_key = os.environ.get("OPENAI_API_KEY")
  if not api_key:
    raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set")
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
    raise HTTPException(status_code=502, detail=f"OpenAI error: {detail}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"OpenAI request failed: {e}")
  try:
    choices = data.get("choices") or []
    choice = choices[0]
    content = str(choice.get("message", {}).get("content", "")).strip()
    content = _cleanup_llm_output(content)
    finish_reason = str(choice.get("finish_reason") or "").lower()
    truncated = finish_reason == "length"
    return content, truncated
  except Exception:
    raise HTTPException(status_code=500, detail="invalid OpenAI response format")


def _call_openai(messages: list, max_tokens: int = 512, temperature: float = 0.2) -> str:
  """_call_openai_with_meta の後方互換ラッパー（content のみ返す）。"""
  content, _truncated = _call_openai_with_meta(messages, max_tokens=max_tokens, temperature=temperature)
  return content


def _stream_openai_chat(
  messages: list,
  max_tokens: int = 512,
  temperature: float = 0.2,
):
  """OpenAI Chat Completions API を stream=true で呼び出し、部分テキストを逐次 yield する。

  戻り値は {"type": "token"|"done", ...} 形式の dict を yield するイテレータ。
  """
  api_key = os.environ.get("OPENAI_API_KEY")
  if not api_key:
    raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set")
  model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
  body = json.dumps(
    {
      "model": model,
      "temperature": temperature,
      "max_tokens": max_tokens,
      "messages": messages,
      "stream": True,
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
  acc_chunks: List[str] = []
  truncated = False
  try:
    with urllib.request.urlopen(req, timeout=90) as resp:
      buf = ""
      while True:
        chunk = resp.read(4096)
        if not chunk:
          break
        buf += chunk.decode("utf-8", errors="replace")
        lines = buf.split("\n")
        buf = lines.pop() or ""
        for line in lines:
          line = line.strip()
          if not line or not line.startswith("data:"):
            continue
          data_str = line[len("data:") :].strip()
          if data_str == "[DONE]":
            break
          try:
            ev = json.loads(data_str)
          except json.JSONDecodeError:
            continue
          for choice in ev.get("choices") or []:
            delta = choice.get("delta") or {}
            content_piece = str(delta.get("content") or "")
            if content_piece:
              acc_chunks.append(content_piece)
              yield {"type": "token", "delta": content_piece}
            finish_reason = str(choice.get("finish_reason") or "").lower()
            if finish_reason == "length":
              truncated = True
  except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", errors="replace")
    raise HTTPException(status_code=502, detail=f"OpenAI error: {detail}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"OpenAI request failed: {e}")

  full = _cleanup_llm_output("".join(acc_chunks))
  yield {"type": "done", "result": full, "truncated": truncated}


def _stream_llm_messages(
  messages: List[dict],
  max_tokens: int = 900,
  temperature: float = 0.2,
  model: Optional[str] = None,
):
  """AI_PROVIDER / OPENAI_API_KEY に応じて Ollama / OpenAI のストリーミングを切り替える。"""
  provider = (os.environ.get("AI_PROVIDER") or "").strip().lower()
  if not provider and os.environ.get("OPENAI_API_KEY"):
    provider = "openai"
  if not provider:
    provider = "ollama"
  if provider == "ollama":
    return _stream_ollama_chat(messages, max_tokens=max_tokens, temperature=temperature, model=model)
  if provider == "openai":
    return _stream_openai_chat(messages, max_tokens=max_tokens, temperature=temperature)
  raise HTTPException(status_code=400, detail=f"unsupported AI_PROVIDER: {provider}")


def _call_llm(system_prompt: str, user_prompt: str, max_tokens: int = 512, temperature: float = 0.2, model: Optional[str] = None) -> str:
  """AI_PROVIDER または OPENAI_API_KEY の有無で Ollama / OpenAI を切り替え。未設定なら Ollama 優先（API フリー）。"""
  provider = (os.environ.get("AI_PROVIDER") or "").strip().lower()
  if not provider and os.environ.get("OPENAI_API_KEY"):
    provider = "openai"
  if not provider:
    provider = "ollama"
  messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": user_prompt},
  ]
  if provider == "ollama":
    return _call_ollama(messages, max_tokens=max_tokens, temperature=temperature, model=model)
  if provider == "openai":
    return _call_openai(messages, max_tokens=max_tokens, temperature=temperature)
  raise HTTPException(status_code=400, detail=f"unsupported AI_PROVIDER: {provider}")


def _call_llm_messages_with_meta(
  messages: List[dict],
  max_tokens: int = 900,
  temperature: float = 0.2,
  model: Optional[str] = None,
) -> Tuple[str, bool]:
  """複数メッセージ（会話履歴含む）で LLM を呼ぶ。

  戻り値は (content, truncated)。
  """
  provider = (os.environ.get("AI_PROVIDER") or "").strip().lower()
  if not provider and os.environ.get("OPENAI_API_KEY"):
    provider = "openai"
  if not provider:
    provider = "ollama"
  if provider == "ollama":
    return _call_ollama_with_meta(messages, max_tokens=max_tokens, temperature=temperature, model=model)
  if provider == "openai":
    return _call_openai_with_meta(messages, max_tokens=max_tokens, temperature=temperature)
  raise HTTPException(status_code=400, detail=f"unsupported AI_PROVIDER: {provider}")


def _call_llm_messages(
  messages: List[dict],
  max_tokens: int = 900,
  temperature: float = 0.2,
  model: Optional[str] = None,
) -> str:
  """従来どおり content のみを返すラッパー。"""
  content, _truncated = _call_llm_messages_with_meta(messages, max_tokens=max_tokens, temperature=temperature, model=model)
  return content


def call_openai_chat(system_prompt: str, user_prompt: str, model: Optional[str] = None) -> str:
  return _call_llm(system_prompt, user_prompt, max_tokens=900, temperature=0.2, model=model)


def call_openai_chat_limited(system_prompt: str, user_prompt: str, max_tokens: int = 160, model: Optional[str] = None) -> str:
  return _call_llm(system_prompt, user_prompt, max_tokens=max_tokens, temperature=0.1, model=model)


def _ollama_request(path: str, method: str = "GET", data: Optional[bytes] = None, timeout: float = 30) -> dict:
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  url = f"{base.rstrip('/')}{path}"
  req = urllib.request.Request(url, data=data, method=method)
  if data:
    req.add_header("Content-Type", "application/json")
  with urllib.request.urlopen(req, timeout=timeout) as resp:
    return json.loads(resp.read().decode("utf-8", errors="replace"))


def _ollama_pull(model: str, timeout: float = 600) -> None:
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  body = json.dumps({"name": model, "stream": False}).encode("utf-8")
  req = urllib.request.Request(
    f"{base.rstrip('/')}/api/pull",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  with urllib.request.urlopen(req, timeout=timeout) as resp:
    data = json.loads(resp.read().decode("utf-8", errors="replace"))
  if data.get("status") != "success":
    raise HTTPException(status_code=502, detail=f"Ollama pull failed: {data.get('status', 'unknown')}")


def _ollama_pull_stream(model: str, timeout: float = 600):
  """Ollama pull を stream で実行し、各イベントを yield する。"""
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  body = json.dumps({"name": model, "stream": True}).encode("utf-8")
  req = urllib.request.Request(
    f"{base.rstrip('/')}/api/pull",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=timeout) as resp:
      buf = b""
      while True:
        chunk = resp.read(4096)
        if not chunk:
          if buf.strip():
            try:
              yield json.loads(buf.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
              pass
          break
        buf += chunk
        while b"\n" in buf:
          line, buf = buf.split(b"\n", 1)
          line = line.strip()
          if not line:
            continue
          try:
            yield json.loads(line.decode("utf-8", errors="replace"))
          except json.JSONDecodeError:
            pass
  except urllib.error.HTTPError as e:
    yield {"status": "error", "error": e.read().decode("utf-8", errors="replace")}
  except Exception as e:
    yield {"status": "error", "error": str(e)}


def _ollama_stop_model(name: str, timeout: float = 10) -> None:
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  body = json.dumps({"name": name}).encode("utf-8")
  req = urllib.request.Request(
    f"{base.rstrip('/')}/api/stop",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=timeout):
      return
  except Exception:
    # モデルが既にアンロード済み or 未起動などは無視
    return


def _ollama_stop_unselected(chosen_model: str) -> None:
  """現在ロードされているモデルのうち、選択中以外をアンロードしてメモリを解放する。"""
  base_name = (chosen_model or "").strip()
  if not base_name:
    return
  # コロンなし表記にも対応
  base_name_short = base_name.split(":", 1)[0]
  try:
    data = _ollama_request("/api/ps", timeout=5)
    models = data.get("models", []) or []
    for m in models:
      name = (m.get("name") or "").strip()
      if not name:
        continue
      short = name.split(":", 1)[0]
      if short != base_name_short:
        _ollama_stop_model(name)
  except Exception:
    # ps 取得に失敗した場合は何もしない（安全優先）
    return


def _ollama_suggested_models() -> List[str]:
  try:
    parser = configparser.ConfigParser()
    parser.read(CONFIG_PATH)
    if parser.has_section("ai") and parser.has_option("ai", "ollama_models"):
      raw = parser.get("ai", "ollama_models").strip()
      if raw:
        user_models = [m.strip() for m in raw.split(",") if m.strip()]
        # ユーザー指定 + デフォルト候補をマージ（重複は前者優先）
        base_defaults = [
          # Qwen3.5 系（公式ファミリ＋代表的なサイズ）
          "qwen3.5",
          "qwen3.5:0.8b",
          "qwen3.5:2b",
          "qwen3.5:4b",
          "qwen3.5:9b",
          "qwen3.5:27b",
          "qwen3.5:35b",
          "qwen3.5:122b",
          # Qwen2.5 一般 / コード特化
          "qwen2.5",
          "qwen2.5-coder:1.5b",
          "qwen2.5-coder:3b",
          "qwen2.5-coder:7b",
          "qwen2.5-coder:14b",
          "qwen2.5-coder:32b",
          # DeepSeek 系（general / code / reasoning）
          "deepseek-llm",
          "deepseek-v2",
          "deepseek-v2.5",
          "deepseek-v3",
          "deepseek-v3.1",
          "deepseek-v3.2",
          "deepseek-r1",
          "deepseek-coder:1.3b",
          "deepseek-coder:6.7b",
          "deepseek-coder:33b",
          "deepseek-coder-v2:16b",
          "deepseek-coder-v2:236b",
          # Llama 3.x 系
          "llama3.1",
          "llama3.2",
          "llama3.2-vision",
          "llama3.3",
          "llama3:8b",
          "llama3:70b",
          # Phi 系
          "phi3",
          "phi3.5",
          "phi4",
          "phi4-mini",
          "phi4-reasoning",
          "phi4-mini-reasoning",
          # コード特化系
          "codestral",
          "starcoder2",
          "stable-code",
          # Mistral 系
          "mistral",
          "mistral-large",
        ]
        merged: List[str] = []
        for name in user_models + base_defaults:
          if name and name not in merged:
            merged.append(name)
        return merged
  except Exception:
    pass
  # デフォルトの候補（すべて無料のオープンモデル）
  # - qwen3.5 系: 新世代の汎用モデルファミリ
  # - qwen2.5 / qwen2.5-coder 系: 一般・コード特化モデル
  # - deepseek 系: reasoning / code / 一般（v2 / v2.5 / v3 / r1 など）
  # - llama3.x 系: Meta 系の一般用途モデル
  # - phi 系: Microsoft 系の軽量〜中規模モデル
  # - codestral / starcoder / stable-code 系: コード特化モデル
  # - mistral 系: 高性能な一般・コード向けモデル（7B / large）
  return [
    # Qwen3.5 ファミリ（汎用・マルチモーダル）
    "qwen3.5",
    "qwen3.5:0.8b",
    "qwen3.5:2b",
    "qwen3.5:4b",
    "qwen3.5:9b",
    "qwen3.5:27b",
    "qwen3.5:35b",
    "qwen3.5:122b",
    # Qwen2.5 系
    "qwen2.5",
    "qwen2.5-coder:1.5b",
    "qwen2.5-coder:3b",
    "qwen2.5-coder:7b",
    "qwen2.5-coder:14b",
    "qwen2.5-coder:32b",
    "qwen2.5:72b-instruct-q3_K_M",
    # DeepSeek 系（general / code / reasoning）
    "deepseek-llm",
    "deepseek-v2",
    "deepseek-v2.5",
    "deepseek-v3",
    "deepseek-v3.1",
    "deepseek-v3.2",
    "deepseek-r1",
    "deepseek-coder:1.3b",
    "deepseek-coder:6.7b",
    "deepseek-coder:33b",
    "deepseek-coder-v2:16b",
    "deepseek-coder-v2:236b",
    # Llama 3.x 系
    "llama3.1",
    "llama3.2",           # 小さめ汎用
    "llama3.2-vision",
    "llama3.3",
    "llama3:8b",
    "llama3:70b",
    # Phi 系
    "phi3",
    "phi3.5",
    "phi4",
    "phi4-mini",
    "phi4-reasoning",
    "phi4-mini-reasoning",
    # コード特化モデル
    "codestral",
    "starcoder2",
    "stable-code",
    # Mistral 系
    "mistral",            # 7B
    "mistral-large",      # 123B クラス
  ]


@app.get("/watchers/{wid}/sessions/{sess}/ai-models")
def get_ai_models(wid: str, sess: str):
  session_root(wid, sess)
  provider = (os.environ.get("AI_PROVIDER") or "").strip().lower()
  if not provider and os.environ.get("OPENAI_API_KEY"):
    provider = "openai"
  if not provider:
    provider = "ollama"
  if provider != "ollama":
    return {"installed": [], "suggested": [], "provider": provider}
  try:
    installed = _get_ollama_installed_models()
  except Exception:
    installed = []
  suggested_all = _ollama_suggested_models()
  # suggested は「全候補」を返し、うち VRAM 的に特に推奨したいものを recommended として別途返す
  suggested = suggested_all
  vram = _get_available_vram_gb() or 0
  # 「快適に使えるライン」の上位モデルだけを recommended として返す。
  # （インストール済みかどうかはフロントで Pull バッジを表示する）
  if vram >= 80:
    recommended = [
      "qwen2.5-coder:32b",
      "qwen2.5:72b-instruct-q3_K_M",
      "deepseek-coder-v2:16b",
      "llama3:70b",
      "mistral-large",
    ]
  elif vram >= 48:
    recommended = [
      "qwen2.5-coder:32b",
      "deepseek-coder-v2:16b",
      "llama3:70b",
      "mistral-large",
    ]
  elif vram >= 24:
    recommended = [
      "qwen2.5-coder:32b",
      "deepseek-coder-v2:16b",
      "llama3:8b",
    ]
  elif vram >= 16:
    recommended = [
      "qwen2.5-coder:14b",
      "deepseek-coder-v2:16b",
      "llama3:8b",
    ]
  elif vram >= 8:
    recommended = [
      "qwen2.5-coder:7b",
      "deepseek-coder:6.7b",
      "llama3:8b",
    ]
  else:
    recommended = [
      "qwen2.5-coder:3b",
      "deepseek-coder:1.3b",
    ]
  # 候補に存在しないものは除外
  recommended = [m for m in recommended if m in suggested_all]
  default = (os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b").strip()
  if default and default not in suggested:
    suggested = [default] + [s for s in suggested if s != default]
  if default and default not in recommended and default in suggested_all:
    recommended = [default] + [s for s in recommended if s != default]
  return {"installed": installed, "suggested": suggested, "recommended": recommended, "provider": provider}


@app.post("/watchers/{wid}/sessions/{sess}/ai-ensure-model")
def ai_ensure_model(wid: str, sess: str, payload: AiEnsureModelPayload):
  session_root(wid, sess)
  if (os.environ.get("AI_PROVIDER") or "").strip().lower() == "openai":
    return {"ok": True, "message": "OpenAI does not require model install"}
  try:
    model = payload.model.strip()
    _ollama_pull(model, timeout=600)
    _ollama_stop_unselected(model)
  except urllib.error.HTTPError as e:
    raise HTTPException(status_code=e.code, detail=e.read().decode("utf-8", errors="replace"))
  except Exception as e:
    raise HTTPException(status_code=502, detail=str(e))
  return {"ok": True}


@app.post("/watchers/{wid}/sessions/{sess}/ai-ensure-model-stream")
def ai_ensure_model_stream(wid: str, sess: str, payload: AiEnsureModelPayload):
  """モデル pull の進捗を SSE でストリームする。"""
  session_root(wid, sess)
  if (os.environ.get("AI_PROVIDER") or "").strip().lower() == "openai":
    def _openai_done():
      yield f"data: {json.dumps({'status': 'success', 'message': 'OpenAI does not require model install'})}\n\n"
    return StreamingResponse(_openai_done(), media_type="text/event-stream")

  def _gen():
    model = payload.model.strip()
    for ev in _ollama_pull_stream(model, timeout=600):
      if ev.get("status") == "error":
        yield f"data: {json.dumps(ev)}\n\n"
        return
      total = ev.get("total")
      completed = ev.get("completed")
      if isinstance(total, (int, float)) and total and isinstance(completed, (int, float)):
        ev = {**ev, "percent": min(100, round(100 * completed / total))}
      yield f"data: {json.dumps(ev)}\n\n"
    # pull 完了後に他モデルをアンロード
    _ollama_stop_unselected(model)

  return StreamingResponse(_gen(), media_type="text/event-stream")


@app.post("/watchers/{wid}/sessions/{sess}/links")
def create_link(wid: str, sess: str, payload: CreateLinkPayload):
  """Create symlink. Relay にセッション dir が無くても RT で Watcher に送る。"""
  source = payload.sourcePath.strip()
  name = payload.linkName.strip()
  if not source or not name:
    raise HTTPException(status_code=400, detail="sourcePath and linkName are required")
  if "/" in name or "\\" in name or ".." in name or "'" in name:
    raise HTTPException(status_code=400, detail="invalid linkName")
  if "'" in source:
    raise HTTPException(status_code=400, detail="single quote is not supported in sourcePath")

  cmd = f"_internal_create_link::{source}::{name}"
  return _send_internal_cmd(wid, sess, cmd)


def _send_internal_cmd(wid: str, sess: str, cmd: str) -> dict:
  """内部コマンドを RT で送信。RT 成功時は commands.txt に書かない（poll で二重実行されるため）。
  Relay 上にセッション dir が無くても送信する（RT は Watcher 側の dir で実行される）。"""
  rt_resp, rt_reason = _post_command_via_rt_with_response(wid, sess, cmd)
  if rt_resp is not None:
    return {"ok": True, "rt": True}
  if rt_reason == "session_not_found":
    raise HTTPException(
      status_code=404,
      detail="Session not found on Watcher. Ensure Watcher has LOCAL_WATCHER_DIR/session and watcher_manager_rt.sh has run.",
    )
  root = SESSIONS_ROOT / wid / sess
  cmd_file = root / "commands.txt"
  cmd_file.parent.mkdir(parents=True, exist_ok=True)
  with cmd_file.open("a", encoding="utf-8") as f:
    f.write(cmd + "\n")
  return {"ok": True, "rt": False}


@app.post("/watchers/{wid}/sessions/{sess}/files")
def create_path(wid: str, sess: str, payload: CreatePathPayload):
  """Create a new file or directory (session-relative path). Relay にセッション dir が無くても RT で Watcher に送る。"""
  rel = _norm_rel(payload.path)
  if not rel or rel == ".":
    raise HTTPException(status_code=400, detail="path is required")
  kind = (payload.kind or "file").strip().lower()
  if kind not in ("file", "dir"):
    raise HTTPException(status_code=400, detail="kind must be file or dir")
  cmd = f"_internal_create_{kind}::{rel}"
  return _send_internal_cmd(wid, sess, cmd)


@app.delete("/watchers/{wid}/sessions/{sess}/files")
def delete_path(wid: str, sess: str, path: str = Query(..., description="session-relative path")):
  """Delete a file or directory. Relay にセッション dir が無くても RT で Watcher に送る。"""
  rel = _norm_rel(path)
  if not rel or rel == ".":
    raise HTTPException(status_code=400, detail="path is required")
  cmd = f"_internal_delete_path::{rel}"
  return _send_internal_cmd(wid, sess, cmd)


@app.post("/watchers/{wid}/sessions/{sess}/files/copy")
def copy_path(wid: str, sess: str, payload: CopyPathPayload):
  """Copy file or directory to destPath. Relay にセッション dir が無くても RT で Watcher に送る。"""
  src = _norm_rel(payload.sourcePath)
  dest = _norm_rel(payload.destPath)
  if not src or src == "." or not dest or dest == ".":
    raise HTTPException(status_code=400, detail="sourcePath and destPath are required")
  cmd = f"_internal_copy_path::{src}::{dest}"
  return _send_internal_cmd(wid, sess, cmd)


@app.post("/watchers/{wid}/sessions/{sess}/files/move")
def move_path(wid: str, sess: str, payload: MovePathPayload):
  """Move/rename file or directory. Relay にセッション dir が無くても RT で Watcher に送る。"""
  src = _norm_rel(payload.sourcePath)
  dest = _norm_rel(payload.destPath)
  if not src or src == "." or not dest or dest == ".":
    raise HTTPException(status_code=400, detail="sourcePath and destPath are required")
  cmd = f"_internal_rename_path::{src}::{dest}"
  return _send_internal_cmd(wid, sess, cmd)


@app.post("/watchers/{wid}/sessions/{sess}/files/upload")
def upload_file(wid: str, sess: str, payload: UploadFilePayload):
  """Upload a file (binary via contentBase64). Creates or overwrites the path."""
  root = session_root(wid, sess)
  rel = _norm_rel(payload.path)
  if not rel or rel == ".":
    raise HTTPException(status_code=400, detail="path is required")
  if not payload.contentBase64:
    raise HTTPException(status_code=400, detail="contentBase64 is required")
  content = "base64:" + payload.contentBase64
  if wid and sess and save_file_via_watcher_rt(wid, sess, rel, content):
    return {"ok": True, "rt": True}
  save_file_via_watcher(root, rel, content, wid=wid, sess=sess)
  return {"ok": True, "rt": False}


def _extract_commands_from_response(text: str) -> List[str]:
  matches = re.findall(r"<command>\s*(.*?)\s*</command>", text, re.DOTALL | re.IGNORECASE)
  out: List[str] = []
  for m in matches:
    cmd = (m or "").strip()
    if cmd:
      out.append(cmd)
  return out


def _extract_command_from_response(text: str) -> Optional[str]:
  cmds = _extract_commands_from_response(text)
  return cmds[0] if cmds else None


def _strip_command_tags(text: str) -> str:
  return re.sub(r"<command>[\s\S]*?</command>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()


def _extract_json_object(text: str) -> Optional[str]:
  """文字列中の最初の JSON object らしき部分を抜き出す。"""
  if not text:
    return None
  start = text.find("{")
  if start < 0:
    return None
  depth = 0
  in_str = False
  esc = False
  for i in range(start, len(text)):
    ch = text[i]
    if in_str:
      if esc:
        esc = False
      elif ch == "\\":
        esc = True
      elif ch == '"':
        in_str = False
      continue
    if ch == '"':
      in_str = True
      continue
    if ch == "{":
      depth += 1
    elif ch == "}":
      depth -= 1
      if depth == 0:
        return text[start : i + 1]
  return None


def _loads_json_object(text: str) -> Optional[dict]:
  raw = _extract_json_object(text)
  if not raw:
    return None
  try:
    data = json.loads(raw)
    return data if isinstance(data, dict) else None
  except Exception:
    return None


def _to_plain_text_lines(value: Any) -> List[str]:
  if value is None:
    return []
  if isinstance(value, list):
    out: List[str] = []
    for item in value:
      s = str(item).strip()
      if s:
        out.append(s)
    return out
  s = str(value).strip()
  return [s] if s else []


def _render_structured_report(data: dict) -> str:
  """構造化 JSON を UI 向け plain text に整形する。Markdown 見出しは使わない。"""
  conclusion = "\n".join(_to_plain_text_lines(data.get("conclusion")))
  evidence = _to_plain_text_lines(data.get("evidence"))
  next_action = "\n".join(_to_plain_text_lines(data.get("next_action")))
  status = "\n".join(_to_plain_text_lines(data.get("status")))

  parts: List[str] = []
  if conclusion:
    parts.append("Conclusion:")
    parts.append(conclusion)
  if evidence:
    parts.append("")
    parts.append("Evidence:")
    for item in evidence[:8]:
      parts.append(f"- {item}")
  if next_action:
    parts.append("")
    parts.append("Next action:")
    parts.append(next_action)
  if status:
    parts.append("")
    parts.append("Status:")
    parts.append(status)
  return "\n".join(parts).strip()


def _normalize_plain_answer(text: str) -> str:
  """debate / report 系の出力を plain text 寄りに正規化する。"""
  if not text:
    return ""
  text = _strip_command_tags(text)
  # 先頭・途中の H1〜H6 を plain text ラベルに寄せる
  text = re.sub(r"^\s{0,3}#{1,6}\s*(.+?)\s*$", r"\1:", text, flags=re.MULTILINE)
  # 連続空行を抑える
  text = re.sub(r"\n{3,}", "\n\n", text)
  return text.strip()


def _is_potentially_destructive_command(cmd: str) -> bool:
  c = cmd.strip().lower()
  # very rough denylist; user can still run these manually via Terminal panel if needed
  dangerous = [
    "rm -rf",
    "mkfs",
    "dd ",
    "shutdown",
    "reboot",
    "kill -9",
    "killall",
    "diskutil erase",
    "format ",
  ]
  return any(d in c for d in dangerous)


def _truncate_agent_output(text: str, max_chars: int = 8000) -> str:
  s = _strip_cmd_exit_markers(text or "")
  if len(s) <= max_chars:
    return s
  return "... (truncated) ...\n" + s[-max_chars:]


def _format_agent_logs_for_report(logs: List[AgentCommandLog]) -> str:
  if not logs:
    return ""
  lines: List[str] = []
  for idx, lg in enumerate(logs):
    try:
      cmd = getattr(lg, "command", None) or (lg.get("command") if isinstance(lg, dict) else None)
      exit_code = getattr(lg, "exitCode", None) if not isinstance(lg, dict) else lg.get("exitCode")
      output = getattr(lg, "output", None) if not isinstance(lg, dict) else lg.get("output")
      error = getattr(lg, "error", None) if not isinstance(lg, dict) else lg.get("error")
    except Exception:
      cmd = None
      exit_code = None
      output = None
      error = None

    header = f"Command {idx+1}: {cmd or '(unknown command)'}"
    if exit_code is not None:
      header += f"  (exit {exit_code})"
    lines.append(header)
    if output:
      lines.append("STDOUT:\n" + str(output))
    if error:
      lines.append("STDERR:\n" + str(error))
  return "\n\n".join(lines)


def _classify_agent_progress(logs: List[AgentCommandLog]) -> Dict[str, str]:
  """
  logs だけを見て、最終レポート化してよいかを判定する。
  目的:
  - pwd / ls / cat requirements.txt だけで premature に finalize しない
  - 実行・import test・install・traceback などの concrete evidence が出るまで続ける
  """
  if not logs:
    return {"ready": "no", "reason": "no_logs"}

  saw_demo_attempt = False
  saw_import_test = False
  saw_install_attempt = False
  saw_traceback = False
  saw_nonzero = False
  saw_only_shallow = True

  shallow_prefixes = (
    "pwd",
    "ls",
    "cat ",
    "head ",
    "find ",
    "conda env list",
    "conda info --envs",
    "pip list",
    "pip show",
    "python --version",
  )

  for lg in logs:
    try:
      cmd = (getattr(lg, "command", None) if not isinstance(lg, dict) else lg.get("command")) or ""
      exit_code = getattr(lg, "exitCode", None) if not isinstance(lg, dict) else lg.get("exitCode")
      output = (getattr(lg, "output", None) if not isinstance(lg, dict) else lg.get("output")) or ""
      error = (getattr(lg, "error", None) if not isinstance(lg, dict) else lg.get("error")) or ""
    except Exception:
      cmd = ""
      exit_code = None
      output = ""
      error = ""

    low_cmd = cmd.strip().lower()
    merged = f"{output}\n{error}".lower()

    if exit_code not in (None, 0):
      saw_nonzero = True
    if "traceback" in merged or "error" in merged or "exception" in merged:
      saw_traceback = True
    if "demo.py" in low_cmd:
      saw_demo_attempt = True
    if "python -c" in low_cmd or ("import " in low_cmd and low_cmd.startswith("python")):
      saw_import_test = True
    if ("pip install" in low_cmd) or ("conda install" in low_cmd):
      saw_install_attempt = True

    if low_cmd and not low_cmd.startswith(shallow_prefixes):
      saw_only_shallow = False

  # 実行・失敗・install など concrete evidence があれば finalize してよい
  if saw_demo_attempt or saw_import_test or saw_install_attempt or saw_traceback or saw_nonzero:
    return {"ready": "yes", "reason": "concrete_evidence"}

  # 浅い確認だけならまだ早い
  if saw_only_shallow:
    return {"ready": "no", "reason": "shallow_only"}

  # それ以外は許可
  return {"ready": "yes", "reason": "enough_context"}


def _finalize_agent_report(
  messages: List[dict],
  logs: List[AgentCommandLog],
  model: Optional[str],
  max_tokens: int,
  temperature: float,
) -> Tuple[str, bool, bool]:
  """
  すでに集めたコマンド実行結果を、証拠付きの調査レポートへ再要約する。
  戻り値: (result, truncated, auto_continued)
  """
  log_text = _format_agent_logs_for_report(logs)

  report_messages = list(messages)
  report_messages.append(
    {
      "role": "user",
      "content": (
        "You have already gathered enough evidence.\n"
        "Now produce a concise investigation report for reviewers and the user.\n\n"
        "CRITICAL OUTPUT RULES:\n"
        "- Output ONLY one valid JSON object.\n"
        "- Do NOT output Markdown.\n"
        "- Do NOT output code fences.\n"
        "- Do NOT output any text before or after the JSON.\n"
        "- Do NOT output any <command> tags.\n"
        "- Do NOT ask the user to run commands that were already executed.\n"
        "- Base the report only on the command outputs already observed.\n"
        "- If a root cause is already visible, state it clearly instead of giving a generic checklist.\n"
        "- If evidence is still insufficient, say exactly what is missing.\n\n"
        "Return exactly this JSON shape:\n"
        "{\n"
        '  \"conclusion\": \"short paragraph\",\n'
        '  \"evidence\": [\"finding 1\", \"finding 2\", \"finding 3\"],\n'
        '  \"next_action\": \"short paragraph\",\n'
        '  \"status\": \"solved | blocked | insufficient_evidence\"\n'
        "}\n\n"
        "Shared command logs:\n"
        f"{log_text if log_text else '(none)'}"
      ),
    }
  )

  final, truncated = _call_llm_messages_with_meta(
    report_messages,
    max_tokens=max_tokens,
    temperature=temperature,
    model=model,
  )
  parsed = _loads_json_object(final)
  if parsed is not None:
    final = _render_structured_report(parsed)
  else:
    final = _normalize_plain_answer(final)
  auto_continued = False

  for _ in range(MAX_CONTINUATION_ROUNDS):
    if not truncated:
      break
    report_messages.append({"role": "assistant", "content": final})
    report_messages.append(
      {
        "role": "user",
        "content": (
          "Continue the same JSON object only. "
          "Do not add Markdown, code fences, or any new commands."
        ),
      }
    )
    extra, truncated2 = _call_llm_messages_with_meta(
      report_messages,
      max_tokens=max_tokens,
      temperature=temperature,
      model=model,
    )
    if not extra:
      truncated = truncated2
      break
    combined = final + extra
    parsed = _loads_json_object(combined)
    if parsed is not None:
      final = _render_structured_report(parsed)
    else:
      final = _normalize_plain_answer(combined)
    auto_continued = True
    truncated = truncated2

  return final, truncated, auto_continued


def _execute_agent_command(
  wid: str,
  sess: str,
  cmd: str,
  timeout: int = 120,
) -> Tuple[Optional[dict], str]:
  """
  Agent 用のコマンド実行経路を通常の /commands と揃える。
  戻り値:
    - 成功時: (response_dict, "")
    - 失敗時: (None, reason)
  """
  send_cmd = f"_agent_silent::{cmd}"

  # 1) RT を先に試す
  rt_resp, rt_error = _post_command_via_rt_with_response(wid, sess, send_cmd, timeout=timeout)
  if rt_resp is not None:
    return {
      "ok": True,
      "rt": True,
      "output": _strip_cmd_exit_markers(rt_resp.get("output", "")),
      "exitCode": rt_resp.get("exitCode", 0),
      "_trace": {"method": "rt"},
    }, ""

  # 2) RT watcher があるのに届かなかった場合は、その失敗をそのまま返す
  rt_port = _get_rt_port(wid)
  if rt_port is not None:
    return None, f"rt_delivery_failed:{rt_error}"

  # 3) 非 RT 構成なら commands.txt 経由にフォールバック
  root = SESSIONS_ROOT / wid / sess
  if not root.exists():
    return None, "session_not_found"

  ok = append_command_and_wait_processed(root, send_cmd, timeout_sec=min(float(timeout), 20.0))
  if not ok:
    return None, "commands_txt_timeout"

  # commands.txt フォールバックでは watcher 応答本文を即取得できない場合がある。
  # 少なくとも「配送・処理完了」は返し、次の推論で transport failure 扱いにしない。
  return {
    "ok": True,
    "rt": False,
    "output": "",
    "exitCode": 0,
    "_trace": {"method": "commands_txt"},
  }, ""


# トークン上限で途切れた場合に「続き」を取得する最大回数（任意長対応）
MAX_CONTINUATION_ROUNDS = 50


def _run_agent_loop(
  wid: str,
  sess: str,
  messages: List[dict],
  model: Optional[str],
  max_iterations: int = 10,
  max_tokens: int = 900,
  temperature: float = 0.2,
) -> AiAssistResponse:
  """Agent モード: 安全な <command> を自動実行し、出力を受け取って推論を続ける。
  危険そうなコマンドは実行せず、ユーザー承認用に返す。
  """
  logs: List[AgentCommandLog] = []
  shallow_deferrals = 0
  no_cmd_deferrals = 0
  for _ in range(max_iterations):
    response = _call_llm_messages(messages, max_tokens=max_tokens, temperature=temperature, model=model)
    cmds = _extract_commands_from_response(response)
    if not cmds:
      # まだ一度もコマンドを提案していない場合は、要約ではなく具体的コマンド提案を強制する
      if not logs and no_cmd_deferrals < 2:
        no_cmd_deferrals += 1
        messages.append({"role": "assistant", "content": response})
        messages.append(
          {
            "role": "user",
            "content": (
              "You have not proposed any <command> yet.\n"
              "Do not summarize or restate the plan. "
              "Now output one or more <command>...</command> blocks with the next concrete shell commands "
              "that will advance the user's task (such as running demo.py, checking imports, or installing "
              "dependencies)."
            ),
          }
        )
        continue
      if logs:
        progress = _classify_agent_progress(logs)
        if progress["ready"] != "yes" and shallow_deferrals < 2:
          shallow_deferrals += 1
          messages.append({"role": "assistant", "content": response})
          messages.append(
            {
              "role": "user",
              "content": (
                "The investigation is not complete yet.\n"
                f"Reason: {progress['reason']}\n\n"
                "Do not summarize yet. "
                "Run the NEXT concrete safe command that most directly advances the task.\n"
                "Prefer one of the following when applicable:\n"
                "- actually execute demo.py\n"
                "- run a minimal python -c import test\n"
                "- inspect the exact failing package import\n"
                "- run one concrete install command if dependency resolution is the next step\n"
                "Output only <command>...</command> blocks."
              ),
            }
          )
          continue
        final, truncated, auto_continued = _finalize_agent_report(
          messages + [{"role": "assistant", "content": response}],
          logs,
          model,
          max_tokens,
          temperature,
        )
        return AiAssistResponse(
          result=final,
          truncated=truncated,
          autoContinued=auto_continued,
          logs=logs,
        )
      return AiAssistResponse(result=_strip_command_tags(response), logs=logs)

    # 1つの <command> ブロックに複数コマンド（&& や ;）をつなげるのは禁止し、書き直しを促す
    if any(("&&" in cmd) or (";" in cmd) for cmd in cmds):
      messages.append({"role": "assistant", "content": response})
      messages.append(
        {
          "role": "user",
          "content": (
            "For safety, do NOT chain multiple shell commands with '&&' or ';' inside a single <command>...</command> block.\n"
            "Rewrite your plan so that each <command> block contains exactly ONE shell command (no &&, no ;), "
            "and try again."
          ),
        }
      )
      continue

    for cmd in cmds:
      if _is_potentially_destructive_command(cmd):
        cleaned = _strip_command_tags(response)
        if not cleaned:
          cleaned = f"危険な可能性があるコマンドのため自動実行できません。\n\n提案コマンド:\n{cmd}"
        return AiAssistResponse(result=cleaned, command=cmd, needsApproval=True, logs=logs)

    feedback_blocks: List[str] = []
    for cmd in cmds:
      exec_resp, exec_error = _execute_agent_command(wid, sess, cmd, timeout=120)
      if exec_resp is not None:
        out = _truncate_agent_output(exec_resp.get("output", ""))
        exit_code = exec_resp.get("exitCode", 0)
        logs.append(AgentCommandLog(command=cmd, exitCode=exit_code, output=out))
        feedback_blocks.append(
          f"[Command executed]\n"
          f"$ {cmd}\n\n"
          f"Exit code: {exit_code}\n\n"
          f"Output:\n{out}"
        )
      else:
        logs.append(AgentCommandLog(command=cmd, exitCode=None, output="", error=exec_error))
        feedback_blocks.append(
          f"[Command delivery failed]\n"
          f"$ {cmd}\n\n"
          f"Error: {exec_error}"
        )

    feedback = (
      "\n\n".join(feedback_blocks)
      + "\n\n"
      + "Decide the next best step. Do NOT claim that you are unable to run commands in general. "
      "If one command failed, treat it as a command-specific shell or transport failure only. "
      "If more evidence is needed, you may run another safe command."
    )
    messages.append({"role": "assistant", "content": response})
    messages.append({"role": "user", "content": feedback})

  final, truncated, auto_continued = _finalize_agent_report(
    messages,
    logs,
    model,
    max_tokens,
    temperature,
  )
  return AiAssistResponse(result=final, truncated=truncated, autoContinued=auto_continued, logs=logs)


BUDDY_MEMORY_PATH = BASE_PATH / "ai_buddy_memory.jsonl"
_BUDDY_STATE_PATH = BASE_PATH / "ai_buddy_state.json"


def append_buddy_memory_item(item: dict) -> None:
  try:
    enriched = dict(item)
    enriched.setdefault("ts", time.time())
    with BUDDY_MEMORY_PATH.open("a", encoding="utf-8") as f:
      f.write(json.dumps(enriched, ensure_ascii=False) + "\n")
  except Exception:
    logger.exception("failed to append buddy memory item")


def load_buddy_state() -> dict:
  default = {"routing": {}, "stats": {"total_feedback": 0, "per_task": {}}, "hints": []}
  try:
    if _BUDDY_STATE_PATH.exists():
      data = json.loads(_BUDDY_STATE_PATH.read_text("utf-8"))
      if isinstance(data, dict):
        for k, v in default.items():
          data.setdefault(k, v)
        return data
  except Exception:
    logger.exception("failed to load buddy state")
  return default


def save_buddy_state(state: dict) -> None:
  try:
    _BUDDY_STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
  except Exception:
    logger.exception("failed to save buddy state")


@app.post("/ai/buddy/feedback")
def ai_buddy_feedback(payload: BuddyFeedbackPayload):
  if not payload.message.strip():
    return {"ok": False}
  # メモリへの追記
  item = {
    "kind": "feedback",
    "message": payload.message,
    "role": (payload.role or "assistant").strip(),
    "rating": payload.rating,
    "taskType": payload.taskType,
    "mode": payload.mode,
    "thinking": payload.thinking,
    "model": payload.model,
    "watcherId": payload.watcherId,
    "session": payload.session,
  }
  append_buddy_memory_item(item)
  # Routing / stats の更新
  try:
    state = load_buddy_state()
    stats = state.setdefault("stats", {}).setdefault("per_task", {})
    routing = state.setdefault("routing", {})
    task = (payload.taskType or "chat").strip() or "chat"
    mode = (payload.mode or "ask").strip() or "ask"
    thinking = (payload.thinking or "balanced").strip() or "balanced"
    # stats
    per = stats.setdefault(task, {"total": 0, "good": 0, "bad": 0})
    per["total"] += 1
    if payload.rating == "good":
      per["good"] += 1
    else:
      per["bad"] += 1
    state.setdefault("stats", {})["total_feedback"] = state.get("stats", {}).get("total_feedback", 0) + 1
    # routing counts
    task_r = routing.setdefault(task, {}).setdefault(mode, {}).setdefault(thinking, {"good": 0, "bad": 0})
    if payload.rating == "good":
      task_r["good"] += 1
    else:
      task_r["bad"] += 1
    save_buddy_state(state)
  except Exception:
    logger.exception("failed to update buddy routing state")
  return {"ok": True}


@app.get("/ai/buddy/state")
def ai_buddy_state():
  state = load_buddy_state()
  routing = state.get("routing") or {}
  per_task = state.get("stats", {}).get("per_task") or {}
  # best_mode / best_thinking を計算
  for task, modes in routing.items():
    best_tuple = None
    best_score = None
    for mode, thinks in modes.items():
      for thinking, cnt in thinks.items():
        g = int(cnt.get("good") or 0)
        b = int(cnt.get("bad") or 0)
        total = g + b
        if total == 0:
          continue
        score = (g - b) / total  # -1..1
        if best_score is None or score > best_score:
          best_score = score
          best_tuple = (mode, thinking)
    if best_tuple:
      tstats = per_task.setdefault(task, {"total": 0, "good": 0, "bad": 0})
      tstats["best_mode"] = best_tuple[0]
      tstats["best_thinking"] = best_tuple[1]
  # ヒント生成（簡易）
  hints = []
  for task, tstats in per_task.items():
    total = int(tstats.get("total") or 0)
    good = int(tstats.get("good") or 0)
    bad = int(tstats.get("bad") or 0)
    best_mode = tstats.get("best_mode")
    best_thinking = tstats.get("best_thinking")
    if total >= 3 and best_mode and best_thinking:
      hints.append(
        {
          "id": f"{task}:{best_mode}:{best_thinking}",
          "text": f"{task} タスクでは {best_mode} / {best_thinking} の組み合わせで良い結果が多いようです。",
        }
      )
  return {
    "stats": state.get("stats") or {"total_feedback": 0, "per_task": {}},
    "routing": routing,
    "hints": hints,
  }


@app.post("/watchers/{wid}/sessions/{sess}/ai-assist")
def ai_assist(wid: str, sess: str, payload: AiAssistPayload):
  session_root(wid, sess)
  if not payload.prompt.strip():
    raise HTTPException(status_code=400, detail="prompt is required")

  thinking = (payload.thinking or "balanced").strip().lower()
  if thinking == "quick":
    chat_max_tokens = 1024
    code_max_tokens = 1024
    max_history = 6
    agent_iterations = 4
  elif thinking == "deep":
    # 深い思考モードは長文になりやすいので 1 回あたり多めに確保
    chat_max_tokens = 4096
    code_max_tokens = 4096
    max_history = 20
    agent_iterations = 16
  else:
    chat_max_tokens = 2048
    code_max_tokens = 2048
    max_history = 12
    agent_iterations = 10

  action = (payload.action or "").strip().lower()
  if action == "chat":
    mode = (payload.mode or "ask").strip().lower()
    # 現在のエディタ内容を全チャットモードで共有できるようにコンテキストブロックを組み立てる
    context_parts: List[str] = []
    if payload.editorPath:
      context_parts.append(f"Current file: {payload.editorPath}")
    if payload.editorSelectedText:
      context_parts.append(f"Selected text in editor:\n```\n{payload.editorSelectedText[:4000]}\n```")
    if payload.editorContent and not payload.editorSelectedText:
      context_parts.append(f"Current file content (for reference):\n```\n{payload.editorContent[:6000]}\n```")
    context_block = "\n\n".join(context_parts) if context_parts else ""
    # モデル選択:
    # - payload.model が指定されていればそれを優先
    # - Auto の場合でも hybridRouting が false のときは単一モデル（OLLAMA_MODEL or デフォルト）を使用
    # - hybridRouting が true かつ model 未指定のときだけ、route_model によるハイブリッドルーティングを行う
    requested_model = (payload.model or "").strip() or None
    use_hybrid = bool(payload.hybridRouting)
    if requested_model:
      selected_model = requested_model
    elif use_hybrid and mode != "multi":
      requires_reasoning = True
      requires_code_generation = False
      requires_repo_read = mode == "agent"
      complexity = "high" if thinking == "deep" else "medium"
      routing = route_model(
        mode=mode,
        requires_reasoning=requires_reasoning,
        requires_code_generation=requires_code_generation,
        requires_repo_read=requires_repo_read,
        complexity=complexity,
        available_vram=_get_available_vram_gb(),
      )
      if mode in ("ask", "plan", "debug"):
        selected_model = routing["planner_model"]
      elif mode == "agent":
        selected_model = routing["inspector_model"]
      else:
        selected_model = os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b"
    else:
      selected_model = os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b"
    # マルチモデル・ディベートモード（multi）はここで分岐
    if mode == "multi":
      # 代表モデル 1 つを Agent として使い、その観点でコマンド実行を行ったうえで、
      # 複数モデルがその結果をレビュー・ディベートし、最後にモデレーターが結論をまとめる。
      # 利用するモデル集合:
      # - payload.model にカンマ区切りで入っている場合はそれを優先（例: "qwen3.5:9b,deepseek-coder:6.7b"）
      # - そうでなければ、代表的な汎用＋コード特化モデルのペアを使用
      raw_models = (payload.model or "").strip()
      if raw_models:
        candidate_models = [m.strip() for m in raw_models.split(",") if m.strip()]
      else:
        candidate_models = [
          os.environ.get("OLLAMA_MODEL") or "qwen3.5",
          "qwen2.5-coder:7b",
          "deepseek-coder:6.7b",
        ]
      # ユーザーが 1 モデルだけ指定している場合は、自動的に「別系統」のモデルを補完して 2〜3 モデルにする。
      if len(candidate_models) == 1:
        base = candidate_models[0].lower()
        extras: List[str] = []
        # Qwen 系（汎用 or coder）の場合 → DeepSeek Coder + Llama 系を追加
        if base.startswith("qwen3.5") or base.startswith("qwen2.5"):
          extras.extend(["deepseek-coder:6.7b", "llama3.2"])
        # DeepSeek Coder 系の場合 → Qwen 汎用 + Llama 系を追加
        elif base.startswith("deepseek-coder"):
          extras.extend(["qwen3.5", "llama3.2"])
        # Llama 系の場合 → Qwen Coder + DeepSeek Coder を追加
        elif base.startswith("llama3"):
          extras.extend(["qwen2.5-coder:7b", "deepseek-coder:6.7b"])
        else:
          # その他 → 汎用 + コード特化の代表セットを追加
          extras.extend(["qwen3.5", "qwen2.5-coder:7b"])
        candidate_models = candidate_models + extras
      # 重複排除 + 先頭2〜3件
      seen: set[str] = set()
      models = []
      for name in candidate_models:
        if name not in seen:
          seen.add(name)
          models.append(name)
        if len(models) >= 3:
          break
      if not models:
        models = [os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b", "deepseek-coder:6.7b"]

      # Round 0 の前に、代表モデル (models[0]) を Agent ループとして動かし、
      # 必要に応じてコマンド実行を行ったうえで一次レポートを得る。
      history = payload.history or []
      history = history[-max_history:]
      # Agent 用 system プロンプト（通常の agent モードに近いが、Multi 用の軽量版）
      system_agent = (
        "You are the primary investigating agent in a multi‑model debate.\n"
        "You can run safe shell commands using the <command>...</command> format to inspect the codebase or environment.\n"
        "You ARE actually connected to a real shell via this mechanism.\n"
        "Focus on gathering concrete evidence and summarizing it clearly for other models to review.\n"
        "\n"
        "CRITICAL BEHAVIOR RULES:\n"
        "- When the user asks to run, verify, or delegate commands (e.g. environment setup, running scripts, checking versions), YOU must execute them using <command>...</command> instead of telling the user to run them.\n"
        "- Do NOT say things like 'I am an AI model and cannot run commands' or 'please run these commands yourself' — those are incorrect in this session.\n"
        "- Prefer sequences of concrete, safe commands (conda/pip installs, python -c checks, running demo scripts) wrapped in <command> blocks, and base your explanation on the actual outputs.\n"
      )
      if context_block:
        system_agent += "\n\n--- Editor context (for reference) ---\n" + context_block
      if thinking == "deep":
        system_agent += (
          "\n\n[Deep mode]\n"
          "Reason carefully and verify your hypotheses with commands when helpful, but keep your final explanation compact."
        )
      elif thinking == "quick":
        system_agent += (
          "\n\n[Quick mode]\n"
          "Prefer a short sequence of commands and a concise summary."
        )
      if payload.persona and payload.persona.strip():
        system_agent = "User-defined persona / instructions:\n" + payload.persona.strip() + "\n\n" + system_agent

      agent_messages: List[dict] = [{"role": "system", "content": system_agent}]
      for m in history:
        role = (m.role or "user").strip().lower()
        if role not in ("user", "assistant"):
          role = "user"
        agent_messages.append({"role": role, "content": (m.content or "").strip()})
      agent_user_content = payload.prompt.strip()
      agent_messages.append({"role": "user", "content": agent_user_content})

      # 代表モデルは models[0]
      representative_model = models[0]
      # Multi では無限にループさせず、Agent イテレーション数を少し絞る
      agent_max_iter = min(agent_iterations, 6)
      agent_res = _run_agent_loop(
        wid,
        sess,
        agent_messages,
        representative_model,
        max_iterations=agent_max_iter,
        max_tokens=chat_max_tokens,
      )

      history = payload.history or []
      history = history[-max_history:]
      base_messages = []
      if context_block:
        # マルチモデルでも共通の system + コンテキストは同じ
        base_system = (
          "You are one of multiple AI assistants collaborating to answer the user's question.\n"
          "First, provide your own best answer clearly.\n"
          "Later, you may receive a summary of others' answers to refine the final conclusion.\n"
        )
        system_prompt_debate = base_system + "\n\n--- Shared editor context ---\n" + context_block
      else:
        system_prompt_debate = (
          "You are one of multiple AI assistants collaborating to answer the user's question.\n"
          "First, provide your own best answer clearly.\n"
        )
      base_messages.append({"role": "system", "content": system_prompt_debate})
      for m in history:
        role = (m.role or "user").strip().lower()
        if role not in ("user", "assistant"):
          role = "user"
        base_messages.append({"role": role, "content": (m.content or "").strip()})
      user_content = payload.prompt.strip()
      base_messages.append({"role": "user", "content": user_content})

      debate_turns: List[DebateTurn] = []

      # Round 0: 代表モデル（唯一のエージェント）の一次回答のみ
      representative_model = models[0]
      primary_answer = _strip_command_tags((agent_res.result or "").strip())
      if not primary_answer:
        primary_answer = "Investigation completed, but the agent did not produce a narrative summary. Refer to the shared command logs."
      debate_turns.append(
        DebateTurn(
          round=0,
          speaker=f"agent:{representative_model}",
          model=representative_model,
          role="assistant",
          content=primary_answer,
        )
      )

      # Round 1: 他モデルは「レビューア」として一次回答の妥当性を評価（独立の再回答はしない）
      reviewer_comments: List[tuple[str, str]] = []
      # 代表エージェントが実行したコマンドログを、レビュワーにも共有するためのテキスト
      agent_logs = getattr(agent_res, "logs", []) or []
      if agent_logs:
        log_lines: List[str] = []
        for idx, lg in enumerate(agent_logs):
          try:
            cmd = getattr(lg, "command", None) or (lg.get("command") if isinstance(lg, dict) else None)
            exit_code = getattr(lg, "exitCode", None) if not isinstance(lg, dict) else lg.get("exitCode")
            output = getattr(lg, "output", None) if not isinstance(lg, dict) else lg.get("output")
            error = getattr(lg, "error", None) if not isinstance(lg, dict) else lg.get("error")
          except Exception:
            cmd = None
            exit_code = None
            output = None
            error = None
          header = f"Command {idx+1}: {cmd or '(unknown command)'}"
          if isinstance(exit_code, int):
            header += f"  (exit {exit_code})"
          log_lines.append(header)
          if output:
            log_lines.append("STDOUT:\n" + str(output))
          if error:
            log_lines.append("STDERR:\n" + str(error))
        shared_agent_log_text = "\n\n".join(log_lines)
      else:
        shared_agent_log_text = ""

      review_system = (
        "You are a reviewer in a multi-agent debate.\n"
        "You see the user's question, the PRIMARY agent's answer, "
        "and a log of the shell commands that the primary agent executed (with their outputs).\n"
        "\n"
        "CRITICAL:\n"
        "- You may rely on the provided command outputs as factual observations.\n"
        "- Never claim you directly inspected the filesystem, current directory, file list, git status, or environment beyond what is shown in the logs.\n"
        "- If the primary answer still lacks concrete evidence for a 'current state' question, explicitly ask the primary agent to run safe commands (e.g. pwd, ls -la) and include outputs.\n"
        "- Do NOT invent any file names, directory paths, or outputs that are not present in the logs or primary answer.\n"
        "- Do NOT mention your own capabilities or limitations.\n"
        "- Do NOT say 'I cannot run commands' or similar phrases.\n"
        "Task:\n"
        "- Check whether the primary answer is correct and sufficiently detailed, given the evidence from the command logs.\n"
        "- Point out concrete issues, missing steps, or risks.\n"
        "- If you agree, say so briefly and add only high-value improvements.\n"
        "Output requirements:\n"
        "- Keep it short.\n"
        "- Do NOT rewrite the whole answer.\n"
        "- Do NOT invent facts (e.g., file lists, current directory) not present in the primary answer or logs.\n"
      )
      for model_name in models[1:]:
        review_messages = [
          {"role": "system", "content": review_system},
          {
            "role": "user",
            "content": (
              "User question:\n"
              f"{payload.prompt.strip()}\n\n"
              + (
                "Primary agent command logs (shared with you):\n"
                f"{shared_agent_log_text}\n\n"
                if shared_agent_log_text
                else ""
              )
              + "Primary agent answer:\n"
              + f"{primary_answer}\n\n"
              + "Provide your review now."
            ),
          },
        ]
        comment, _tr_review = _call_llm_messages_with_meta(
          review_messages,
          max_tokens=max(256, min(1024, chat_max_tokens)),
          temperature=0.2,
          model=model_name,
        )
        comment_text = (comment or "").strip()
        reviewer_comments.append((model_name, comment_text))
        debate_turns.append(
          DebateTurn(
            round=1,
            speaker=f"reviewer:{model_name}",
            model=model_name,
            role="assistant",
            content=comment_text,
          )
        )

      # Round 2: モデレーターが一次回答＋レビューコメントから、ユーザー向けの最終回答だけを生成
      moderator_model = representative_model
      summary_prompt = (
        "You are the moderator combining multiple AI assistant answers.\n"
        "You will receive a primary answer and reviewer comments.\n"
        "\n"
        "Your primary goal is to provide the BEST POSSIBLE direct answer to the user's question.\n"
        "- Start from the primary agent answer as the backbone.\n"
        "- Integrate only genuinely important corrections or additions from reviewer comments.\n"
        "- Do NOT mention reviewers, assistants, agreements, disagreements, or meta discussion.\n"
        "- Ignore reviewer meta-comments about capabilities or inability to run commands.\n"
        "- Do NOT say that the AI system is unable to run commands.\n"
        "- If command execution failed, describe it as a shell failure or session transport failure, not as an AI limitation.\n"
        "- Do NOT generate brand-new code, configs, installation steps, or project structure unless they are directly supported by the primary answer or shared logs.\n"
        "- If the evidence is insufficient, say what is missing instead of fabricating a complete implementation guide.\n"
        "- Output a single clean plain-text answer for the user.\n"
        "- Do NOT use Markdown headings, code fences, or article-style titles.\n"
      )
      summary_messages = [
        {"role": "system", "content": summary_prompt},
      ]
      joined_reviews = []
      for idx, (model_name, text) in enumerate(reviewer_comments):
        joined_reviews.append(f"Reviewer {idx+1} ({model_name}):\n{text or '(no comment)'}")
      summary_user = (
        "User question:\n"
        f"{payload.prompt.strip()}\n\n"
        "Primary answer:\n"
        f"{primary_answer}\n\n"
        "Reviewer comments:\n\n"
        + ("\n\n---\n\n".join(joined_reviews) if joined_reviews else "(none)")
      )
      summary_messages.append({"role": "user", "content": summary_user})
      final_answer, _tr2 = _call_llm_messages_with_meta(
        summary_messages,
        max_tokens=chat_max_tokens,
        temperature=0.2,
        model=moderator_model,
      )
      final_answer = _normalize_plain_answer((final_answer or "").strip())
      if not final_answer:
        final_answer = primary_answer
      debate_turns.append(
        DebateTurn(
          round=2,
          speaker="moderator",
          model=moderator_model,
          role="assistant",
          content=final_answer,
        )
      )

      debate = DebateThread(
        id=str(uuid.uuid4()),
        title="Multi-model debate",
        models=models,
        turns=debate_turns,
      )
      # Agent の実行ログや潜在的な approval 要求も Multi の結果に伝搬する
      return AiAssistResponse(
        result=final_answer,
        command=getattr(agent_res, "command", None),
        needsApproval=getattr(agent_res, "needsApproval", False),
        logs=getattr(agent_res, "logs", []),
        debates=[debate],
        truncated=getattr(agent_res, "truncated", False),
        autoContinued=getattr(agent_res, "autoContinued", False),
      )

    if mode == "agent":
      system_prompt = (
        "You are SyncTerm-IDE's local coding agent. You collaborate with the user as a careful pair-programming partner.\n"
        "Your priorities are: (1) be correct and useful, (2) avoid destructive actions, (3) prefer small, verifiable steps, "
        "(4) prefer observation over guessing, (5) keep the user in control.\n"
        "\n"
        "You CAN run real shell commands in this session. When the user asks to inspect files, run a script, or check the environment, "
        "use the format <command>SHELL_COMMAND</command> (e.g. <command>pwd</command>, <command>ls -la</command>) and base your answer on the output.\n"
        "Never claim you cannot run commands in this session. Do NOT run destructive commands (rm -rf, mkfs, shutdown, reboot, fork bombs, etc.).\n"
        "In each <command>...</command> block, put exactly ONE shell command only (no '&&', no ';').\n"
        "Reply in the same language as the user.\n"
        "\n"
        "Execution policy:\n"
        "- Level 0 (read-only: ls, cat, rg, git status, etc.): allowed automatically when helpful.\n"
        "- Level 1 (light operations: tests, lint, dry-run builds): allowed, but briefly mention what you are about to run.\n"
        "- Level 2 (workspace modifications: edits, new files, renames): first propose a short plan (1–3 steps) and wait for the user's confirmation before running commands.\n"
        "- Level 3 (environment changes: installs, deletes, git commit/reset, system changes): NEVER execute without explicit user approval.\n"
        "  For installs/updates (pip/conda/npm/apt etc.), propose the exact command and a sandbox/venv strategy, then wait for approval.\n"
        "\n"
        "Collaboration style:\n"
        "- When the request is ambiguous or large (big refactors, new tools, environment changes), ask 1–3 clarifying questions instead of guessing.\n"
        "- Before running a series of commands or editing multiple files, show a short plan and ask whether to proceed.\n"
        "- After each major step, briefly summarize what changed and ask whether to continue, instead of trying to solve everything in one shot.\n"
        "\n"
        "Response structure for agent/debug tasks:\n"
        "- Understanding: what you think the user wants and what you observed.\n"
        "- Plan: 1–3 concrete steps you intend to take.\n"
        "- Action: what you actually did (commands, edits, inspections).\n"
        "- Result / Next: what you found or changed, and the next options for the user.\n"
      )
      if context_block:
        system_prompt += "\n\n--- Editor context (use for code changes when relevant) ---\n" + context_block
      if thinking == "deep":
        system_prompt += (
          "\n\n[Deep thinking mode]\n"
          "Before producing your final answer, internally verify your reasoning and the command outputs. "
          "Proactively decide when running shell commands will significantly reduce uncertainty, and use them as part of your thinking. "
          "In the final message, structure your answer into a few clear steps (e.g. 'Step 1', 'Step 2', ...), followed by a short summary. "
          "Do NOT expose your entire internal chain-of-thought; keep the explanation high-level."
        )
      elif thinking == "quick":
        system_prompt += (
          "\n\n[Quick mode]\n"
          "Optimize for short, direct answers. Avoid running shell commands unless the user explicitly asks for them."
        )
    elif mode == "plan":
      system_prompt = (
        "You are a planning assistant. Take a moment to think through the problem, then help the user plan:\n"
        "- Outline clear steps and milestones\n"
        "- Call out risks and alternatives when important\n"
        "Use headings and numbered lists, but keep the final answer concise."
      )
      if context_block:
        system_prompt += "\n\n--- Editor context (for planning around current code) ---\n" + context_block
    elif mode == "debug":
      system_prompt = (
        "You are a debugging assistant. Think deeply about possible root causes before proposing fixes.\n"
        "Analyze errors, propose hypotheses, and then suggest concrete fixes. "
        "Explain root causes in plain text; include code snippets only when relevant."
      )
      if context_block:
        system_prompt += "\n\n--- Editor context (use this code when debugging) ---\n" + context_block
    else:
      system_prompt = "You are a helpful assistant. Reply concisely. Use plain text, no code fences unless the user asks for code."
      if context_block:
        system_prompt += "\n\n--- Editor context (for reference) ---\n" + context_block
    if mode != "agent":
      if thinking == "deep":
        system_prompt += (
          "\n\n[Deep thinking mode]\n"
          "Take a moment to reason internally about multiple possibilities and sanity-check your final answer. "
          "In the final output, present 2–4 concise steps (or sections) that show the high-level flow of your reasoning, "
          "followed by a short conclusion. Do not expose every tiny internal reasoning step."
        )
      elif thinking == "quick":
        system_prompt += (
          "\n\n[Quick mode]\n"
          "Answer in a single short paragraph or list when possible. Focus on the most important points only."
        )
    # 共通の出力品質ルール（同じ文の繰り返しを避けるなど）
    system_prompt += (
      "\n\n[Output quality rules]\n"
      "- Do not repeat the same sentence or disclaimer multiple times.\n"
      "- If the answer cannot be determined from the provided information, say this once, then briefly suggest what additional information would be needed.\n"
    )
    if payload.persona and payload.persona.strip():
      system_prompt = "User-defined persona / instructions:\n" + payload.persona.strip() + "\n\n" + system_prompt
    history = payload.history or []
    history = history[-max_history:]
    messages = [{"role": "system", "content": system_prompt}]
    for m in history:
      role = (m.role or "user").strip().lower()
      if role not in ("user", "assistant"):
        role = "user"
      messages.append({"role": role, "content": (m.content or "").strip()})
    user_content = payload.prompt.strip()
    if mode == "agent" and (payload.editorPath or payload.editorSelectedText or payload.editorContent):
      user_content = "[User request]\n" + user_content
    messages.append({"role": "user", "content": user_content})
    if mode == "agent":
      agent_res = _run_agent_loop(
        wid,
        sess,
        messages,
        selected_model,
        max_iterations=agent_iterations,
        max_tokens=chat_max_tokens,
      )
      return agent_res
    else:
      # 通常チャットモードでは、トークン上限で切れる限り「続き」を取得して連結する（最大 MAX_CONTINUATION_ROUNDS 回）
      result, truncated = _call_llm_messages_with_meta(
        messages,
        max_tokens=chat_max_tokens,
        temperature=0.2,
        model=selected_model,
      )
      auto_continued = False
      for _ in range(MAX_CONTINUATION_ROUNDS):
        if not truncated:
          break
        messages.append({"role": "assistant", "content": result})
        messages.append(
          {
            "role": "user",
            "content": "Continue the previous answer from where you stopped, keeping the same level of detail.",
          }
        )
        extra, truncated2 = _call_llm_messages_with_meta(
          messages,
          max_tokens=chat_max_tokens,
          temperature=0.2,
          model=payload.model,
        )
        if not extra:
          truncated = truncated2
          break
        result = result + ("\n\n" if not result.endswith("\n") and extra else "") + extra
        auto_continued = True
        truncated = truncated2
  else:
    mode = (payload.mode or "ask").strip().lower()
    # コード生成系（action != "chat"）のモデル決定
    requested_model = (payload.model or "").strip() or None
    use_hybrid = bool(payload.hybridRouting)
    if requested_model:
      selected_model = requested_model
    elif use_hybrid:
      requires_reasoning = True
      requires_code_generation = True
      requires_repo_read = False
      complexity = "high"
      routing = route_model(
        mode=mode,
        requires_reasoning=requires_reasoning,
        requires_code_generation=requires_code_generation,
        requires_repo_read=requires_repo_read,
        complexity=complexity,
        available_vram=_get_available_vram_gb(),
      )
      selected_model = routing["executor_model"]
    else:
      selected_model = os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b"

    if mode == "agent":
      system_prompt = (
        "You are an autonomous coding agent. Take a deep breath and think step by step about the best change.\n"
        "Break down the request into steps, apply changes, and return only the final code text that can directly "
        "replace the target scope. No markdown fences. Do not use placeholder code like '...' – always return "
        "complete, compilable code.\n"
        "\n"
        "[File safety rules]\n"
        "- NEVER install or update packages or tools from within generated code without the user's explicit confirmation.\n"
        "- Avoid writing code that assumes global environment changes (e.g. global pip/conda installs); prefer code that can run inside a virtual environment or a clearly separated sandbox directory when such setup is needed.\n"
        "- Do not create or delete files in unexpected locations; if file creation is part of the request, make it clear in comments or surrounding text and keep all new artifacts inside a dedicated folder when possible."
      )
    elif mode == "plan":
      system_prompt = (
        "You are a planning-oriented coding assistant. First reason about the best approach, then outline it briefly. "
        "Finally, return only the code text that can directly replace the target scope. No markdown fences."
      )
    elif mode == "debug":
      system_prompt = (
        "You are a debugging expert. Think carefully about likely root causes, then fix the issue and return only the "
        "corrected code text that can directly replace the target scope. No markdown fences and no placeholder code."
      )
    else:
      system_prompt = (
        "You are an expert software engineer. Keep responses concise and return only code text "
        "that can directly replace the target scope."
      )
    if payload.persona and payload.persona.strip():
      system_prompt = "User-defined persona / instructions:\n" + payload.persona.strip() + "\n\n" + system_prompt
    user_prompt = build_ai_prompt(payload)
    result = _call_llm(system_prompt, user_prompt, max_tokens=code_max_tokens, temperature=0.2, model=selected_model)
    # コード生成モードでは安全のため自動継続は行わない
    truncated = False
    auto_continued = False
  return AiAssistResponse(result=result, truncated=truncated, autoContinued=auto_continued)


@app.post("/watchers/{wid}/sessions/{sess}/ai-stream")
def ai_stream(wid: str, sess: str, payload: AiAssistPayload):
  """AI 応答を text/event-stream でストリーミング返却するエンドポイント。

  - chat / debate（Multi モード）の通常応答は LLM ネイティブのストリーミング API を使用
  - Agent / コード生成系など複雑なモードは、従来どおり ai_assist の結果を疑似ストリーミングする
  """
  session_root(wid, sess)

  action = (payload.action or "").strip().lower()
  mode = (payload.mode or "ask").strip().lower()

  thinking = (payload.thinking or "balanced").strip().lower()
  if thinking == "quick":
    chat_max_tokens = 1024
    max_history = 6
  elif thinking == "deep":
    chat_max_tokens = 4096
    max_history = 20
  else:
    chat_max_tokens = 2048
    max_history = 12

  # chat アクションかつ Agent / Multi 以外 → 真のストリーミングで返す
  if action == "chat" and mode not in ("agent", "multi"):
    # ai_assist の chat 分岐と同じロジックでコンテキストとモデル選択を行う
      context_parts: List[str] = []
      if payload.editorPath:
        context_parts.append(f"Current file: {payload.editorPath}")
      if payload.editorSelectedText:
        context_parts.append(f"Selected text in editor:\n```\n{payload.editorSelectedText[:4000]}\n```")
      if payload.editorContent and not payload.editorSelectedText:
        context_parts.append(f"Current file content (for reference):\n```\n{payload.editorContent[:6000]}\n```")
      context_block = "\n\n".join(context_parts) if context_parts else ""

      requested_model = (payload.model or "").strip() or None
      use_hybrid = bool(payload.hybridRouting)
      if requested_model:
        selected_model = requested_model
      elif use_hybrid and mode != "multi":
        requires_reasoning = True
        requires_code_generation = False
        requires_repo_read = mode == "agent"
        complexity = "high" if thinking == "deep" else "medium"
        routing = route_model(
          mode=mode,
          requires_reasoning=requires_reasoning,
          requires_code_generation=requires_code_generation,
          requires_repo_read=requires_repo_read,
          complexity=complexity,
          available_vram=_get_available_vram_gb(),
        )
        if mode in ("ask", "plan", "debug"):
          selected_model = routing["planner_model"]
        elif mode == "agent":
          selected_model = routing["inspector_model"]
        else:
          selected_model = os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b"
      else:
        selected_model = os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b"

      # system プロンプト（ai_assist と同等だが、Agent 以外のみ）
      if mode == "plan":
        system_prompt = (
          "You are a planning assistant. Take a moment to think through the problem, then help the user plan:\n"
          "- Outline clear steps and milestones\n"
          "- Call out risks and alternatives when important\n"
          "Use headings and numbered lists, but keep the final answer concise."
        )
        if context_block:
          system_prompt += "\n\n--- Editor context (for planning around current code) ---\n" + context_block
      elif mode == "debug":
        system_prompt = (
          "You are a debugging assistant. Think deeply about possible root causes before proposing fixes.\n"
          "Analyze errors, propose hypotheses, and then suggest concrete fixes. "
          "Explain root causes in plain text; include code snippets only when relevant."
        )
        if context_block:
          system_prompt += "\n\n--- Editor context (use this code when debugging) ---\n" + context_block
      else:
        system_prompt = "You are a helpful assistant. Reply concisely. Use plain text, no code fences unless the user asks for code."
        if context_block:
          system_prompt += "\n\n--- Editor context (for reference) ---\n" + context_block

      if thinking == "deep":
        system_prompt += (
          "\n\n[Deep thinking mode]\n"
          "Take a moment to reason internally about multiple possibilities and sanity-check your final answer. "
          "In the final output, present 2–4 concise steps (or sections) that show the high-level flow of your reasoning, "
          "followed by a short conclusion. Do not expose every tiny internal reasoning step."
        )
      elif thinking == "quick":
        system_prompt += (
          "\n\n[Quick mode]\n"
          "Answer in a single short paragraph or list when possible. Focus on the most important points only."
        )

      system_prompt += (
        "\n\n[Output quality rules]\n"
        "- Do not repeat the same sentence or disclaimer multiple times.\n"
        "- If the answer cannot be determined from the provided information, say this once, then briefly suggest what additional information would be needed.\n"
      )
      if payload.persona and payload.persona.strip():
        system_prompt = "User-defined persona / instructions:\n" + payload.persona.strip() + "\n\n" + system_prompt

      history = payload.history or []
      history = history[-max_history:]
      messages: List[dict] = [{"role": "system", "content": system_prompt}]
      for m in history:
        role = (m.role or "user").strip().lower()
        if role not in ("user", "assistant"):
          role = "user"
        messages.append({"role": role, "content": (m.content or "").strip()})
      user_content = payload.prompt.strip()
      messages.append({"role": "user", "content": user_content})

      def _iter_events_chat():
        full_text = ""
        truncated_flag = False
        for ev in _stream_llm_messages(messages, max_tokens=chat_max_tokens, temperature=0.2, model=selected_model):
          if ev.get("type") == "token" and ev.get("delta"):
            full_text += str(ev.get("delta") or "")
            yield f"data: {json.dumps({'type': 'token', 'delta': ev.get('delta')}, ensure_ascii=False)}\n\n"
          elif ev.get("type") == "done":
            result_text = str(ev.get("result") or "") or full_text
            truncated_flag = bool(ev.get("truncated"))
            done_ev = {
              "type": "done",
              "result": result_text,
              "command": None,
              "needsApproval": False,
              "truncated": truncated_flag,
              "autoContinued": False,
              "logs": [],
              "debates": [],
            }
            yield f"data: {json.dumps(done_ev, ensure_ascii=False)}\n\n"

      return StreamingResponse(_iter_events_chat(), media_type="text/event-stream")

  # Multi モードでは、代表エージェント + レビューモデル + モデレーターによるディベートを
  # ラウンド／ターン単位でストリーミングする。
  if action == "chat" and mode == "multi":
    def _iter_events_multi():
      # thinking / chat_max_tokens / max_history / agent_iterations は ai_assist と同じロジックを再利用
      thinking = (payload.thinking or "balanced").strip().lower()
      if thinking == "quick":
        chat_max_tokens = 1024
        max_history = 6
        agent_iterations = 4
      elif thinking == "deep":
        chat_max_tokens = 4096
        max_history = 20
        agent_iterations = 16
      else:
        chat_max_tokens = 2048
        max_history = 12
        agent_iterations = 10

      # エディタコンテキストの組み立て（ai_assist と同じ）
      context_parts: List[str] = []
      if payload.editorPath:
        context_parts.append(f"Current file: {payload.editorPath}")
      if payload.editorSelectedText:
        context_parts.append(f"Selected text in editor:\n```\n{payload.editorSelectedText[:4000]}\n```")
      if payload.editorContent and not payload.editorSelectedText:
        context_parts.append(f"Current file content (for reference):\n```\n{payload.editorContent[:6000]}\n```")
      context_block = "\n\n".join(context_parts) if context_parts else ""

      # モデル集合の決定（ai_assist の multi と同じロジック）
      raw_models = (payload.model or "").strip()
      if raw_models:
        candidate_models = [m.strip() for m in raw_models.split(",") if m.strip()]
      else:
        candidate_models = [
          os.environ.get("OLLAMA_MODEL") or "qwen3.5",
          "qwen2.5-coder:7b",
          "deepseek-coder:6.7b",
        ]
      if len(candidate_models) == 1:
        base_name = candidate_models[0].lower()
        extras: List[str] = []
        if base_name.startswith("qwen3.5") or base_name.startswith("qwen2.5"):
          extras.extend(["deepseek-coder:6.7b", "llama3.2"])
        elif base_name.startswith("deepseek-coder"):
          extras.extend(["qwen3.5", "llama3.2"])
        elif base_name.startswith("llama3"):
          extras.extend(["qwen2.5-coder:7b", "deepseek-coder:6.7b"])
        else:
          extras.extend(["qwen3.5", "qwen2.5-coder:7b"])
        candidate_models = candidate_models + extras
      seen_models: set[str] = set()
      models: List[str] = []
      for name in candidate_models:
        if name in seen_models:
          continue
        seen_models.add(name)
        models.append(name)
        if len(models) >= 3:
          break
      if not models:
        models = [os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b", "deepseek-coder:6.7b"]

      # 代表モデル（唯一のエージェント） = models[0]
      representative_model = models[0]

      # 履歴の切り詰め
      history = payload.history or []
      history = history[-max_history:]

      # 代表エージェント用 system プロンプト
      system_agent = (
        "You are the primary investigating agent in a multi-model debate.\n"
        "Only YOU can run real shell commands in this session using <command>...</command>.\n"
        "Other models will only see your report and logs; they do NOT see the raw environment.\n"
        "You ARE actually connected to a real shell via this mechanism.\n"
        "Focus on gathering concrete evidence and summarizing it clearly for others to review.\n"
        "\n"
        "CRITICAL:\n"
        "- You DO have access to the remote session via commands. Never say you cannot access the filesystem.\n"
        "- Never say things like 'I am just an AI model and cannot run commands' or 'please run these commands yourself' — those are incorrect in this session.\n"
        "- If the user asks about CURRENT STATE (e.g. current directory, file list, git status, running processes, env), you MUST run safe commands to verify.\n"
        "- If the user delegates environment setup, dependency installation, or running demo scripts to you, plan the steps and then execute the necessary commands using <command>...</command>, asking for approval only when a command might be risky.\n"
        "- Prefer: <command>pwd</command>, <command>ls -la</command>, <command>git status</command>, conda/pip installs, python -c checks, etc.\n"
        "- When reporting files, paths, or versions, base your answer ONLY on command output. If a command failed, say so and try an alternative safe command.\n"
        "- In each <command>...</command> block, put exactly ONE shell command only (no '&&', no ';').\n"
      )
      if context_block:
        system_agent += "\n\n--- Editor context (for reference) ---\n" + context_block
      if thinking == "deep":
        system_agent += (
          "\n\n[Deep mode]\n"
          "Reason carefully and verify your hypotheses with commands when helpful, "
          "but keep your final explanation compact."
        )
      elif thinking == "quick":
        system_agent += (
          "\n\n[Quick mode]\n"
          "Prefer a short sequence of commands and a concise summary."
        )
      if payload.persona and payload.persona.strip():
        system_agent = "User-defined persona / instructions:\n" + payload.persona.strip() + "\n\n" + system_agent

      agent_messages: List[dict] = [{"role": "system", "content": system_agent}]
      for m in history:
        role = (m.role or "user").strip().lower()
        if role not in ("user", "assistant"):
          role = "user"
        agent_messages.append({"role": role, "content": (m.content or "").strip()})
      agent_user_content = payload.prompt.strip()
      agent_messages.append({"role": "user", "content": agent_user_content})

      # 代表エージェントの Agent ループ（ここは同期実行だが、完了次第すぐに debate_turn を流す）
      agent_max_iter = min(agent_iterations, 6)
      agent_res = _run_agent_loop(
        wid,
        sess,
        agent_messages,
        representative_model,
        max_iterations=agent_max_iter,
        max_tokens=chat_max_tokens,
      )

      agent_logs = getattr(agent_res, "logs", []) or []
      if agent_logs:
        log_lines: List[str] = []
        for idx, lg in enumerate(agent_logs):
          try:
            cmd = getattr(lg, "command", None) or (lg.get("command") if isinstance(lg, dict) else None)
            exit_code = getattr(lg, "exitCode", None) if not isinstance(lg, dict) else lg.get("exitCode")
            output = getattr(lg, "output", None) if not isinstance(lg, dict) else lg.get("output")
            error = getattr(lg, "error", None) if not isinstance(lg, dict) else lg.get("error")
          except Exception:
            cmd = None
            exit_code = None
            output = None
            error = None
          header = f"Command {idx+1}: {cmd or '(unknown command)'}"
          if isinstance(exit_code, int):
            header += f"  (exit {exit_code})"
          log_lines.append(header)
          if output:
            log_lines.append("STDOUT:\n" + str(output))
          if error:
            log_lines.append("STDERR:\n" + str(error))
        shared_agent_log_text = "\n\n".join(log_lines)
      else:
        shared_agent_log_text = ""

      debate_turns: List[DebateTurn] = []

      # Round 0: 代表エージェントのレポートをまず流す
      agent_text = _strip_command_tags((agent_res.result or "").strip())
      if not agent_text:
        agent_text = "Investigation completed, but the agent did not produce a narrative summary. Refer to the shared command logs."
      debate_turns.append(
        DebateTurn(
          round=0,
          speaker=f"agent:{representative_model}",
          model=representative_model,
          role="assistant",
          content=agent_text,
        )
      )
      first_debate = DebateThread(
        id=str(uuid.uuid4()),
        title="Multi-model debate",
        models=models,
        turns=debate_turns[:],
      )
      # 代表ターンを即座にフロントへ送信
      ev0 = {
        "type": "debate_turn",
        "debateId": first_debate.id,
        "turn": {
          "round": 0,
          "speaker": f"agent:{representative_model}",
          "model": representative_model,
          "role": "assistant",
          "content": agent_text,
        },
      }
      yield f"data: {json.dumps(ev0, ensure_ascii=False)}\n\n"

      debate_id = first_debate.id

      # Round 1: 他モデルは「レビューア」として一次回答を評価（再回答しない）
      review_system = (
        "You are a reviewer in a multi-agent debate.\n"
        "You see the user's question, the PRIMARY agent's answer, "
        "and a log of the shell commands that the primary agent executed (with their outputs).\n"
        "\n"
        "CRITICAL:\n"
        "- You may rely on the provided command outputs as factual observations.\n"
        "- Never claim you directly inspected the filesystem, current directory, file list, git status, or environment beyond what is shown in the logs.\n"
        "- If the primary answer still lacks concrete evidence for a current-state question, explicitly ask the primary agent to run safe commands and include outputs.\n"
        "- Do NOT invent any file names, directory paths, outputs, versions, or code that are not present in the logs or primary answer.\n"
        "- Do NOT mention your own capabilities or limitations.\n"
        "- Do NOT say 'I cannot run commands' or similar phrases.\n"
        "Task:\n"
        "- Check whether the primary answer is correct and sufficiently detailed, given the evidence from the command logs.\n"
        "- Point out concrete issues, missing steps, or risks.\n"
        "- If you agree, say so briefly and add only high-value improvements.\n"
        "Output requirements:\n"
        "- Keep it short.\n"
        "- Do NOT rewrite the whole answer.\n"
        "- Do NOT invent facts not present in the primary answer or logs.\n"
      )
      reviewer_comments: List[tuple[str, str]] = []
      for model_name in models[1:]:
        review_messages = [
          {"role": "system", "content": review_system},
          {
            "role": "user",
            "content": (
              "User question:\n"
              f"{payload.prompt.strip()}\n\n"
              + (
                "Primary agent command logs (shared with you):\n"
                f"{shared_agent_log_text}\n\n"
                if shared_agent_log_text
                else ""
              )
              + "Primary agent answer:\n"
              + f"{agent_text}\n\n"
              + "Provide your review now."
            ),
          },
        ]
        comment, _tr = _call_llm_messages_with_meta(
          review_messages,
          max_tokens=max(256, min(1024, chat_max_tokens)),
          temperature=0.2,
          model=model_name,
        )
        text = (comment or "").strip()
        reviewer_comments.append((model_name, text))
        turn = DebateTurn(
          round=1,
          speaker=f"reviewer:{model_name}",
          model=model_name,
          role="assistant",
          content=text,
        )
        debate_turns.append(turn)
        ev_turn = {
          "type": "debate_turn",
          "debateId": debate_id,
          "turn": {
            "round": 1,
            "speaker": f"reviewer:{model_name}",
            "model": model_name,
            "role": "assistant",
            "content": text,
          },
        }
        yield f"data: {json.dumps(ev_turn, ensure_ascii=False)}\n\n"

      # Round 2: モデレーターが一次回答＋レビューコメントから最終回答を作る（メタ無し）
      moderator_model = representative_model
      summary_prompt = (
        "You are the moderator.\n"
        "You will receive a primary answer and reviewer comments.\n"
        "\n"
        "Your primary goal is to provide the BEST POSSIBLE direct answer to the user's question.\n"
        "- Start from the primary answer as the backbone.\n"
        "- Integrate only genuinely important corrections or additions from reviewer comments.\n"
        "- Do NOT mention reviewers, assistants, agreements, disagreements, or meta discussion.\n"
        "- Ignore reviewer meta-comments about capabilities or inability to run commands.\n"
        "- Do NOT say that the AI system is unable to run commands.\n"
        "- If command execution failed, describe it as a shell failure or session transport failure, not as an AI limitation.\n"
        "- Do NOT generate brand-new code, configs, installation steps, or project structure unless they are directly supported by the primary answer or shared logs.\n"
        "- If the evidence is insufficient, say what is missing instead of fabricating a complete implementation guide.\n"
        "- Output a single clean plain-text answer for the user.\n"
        "- Do NOT use Markdown headings, code fences, or article-style titles.\n"
      )
      summary_messages = [
        {"role": "system", "content": summary_prompt},
      ]
      joined_reviews = []
      for idx, (model_name, text) in enumerate(reviewer_comments):
        joined_reviews.append(f"Reviewer {idx+1} ({model_name}):\n{text or '(no comment)'}")
      summary_user = (
        "User question:\n"
        f"{payload.prompt.strip()}\n\n"
        "Primary answer:\n"
        f"{agent_text}\n\n"
        "Reviewer comments:\n\n"
        + ("\n\n---\n\n".join(joined_reviews) if joined_reviews else "(none)")
      )
      summary_messages.append({"role": "user", "content": summary_user})
      final_answer, _tr2 = _call_llm_messages_with_meta(
        summary_messages,
        max_tokens=chat_max_tokens,
        temperature=0.2,
        model=moderator_model,
      )
      final_answer = _normalize_plain_answer((final_answer or "").strip())
      if not final_answer:
        final_answer = agent_text
      debate_turns.append(
        DebateTurn(
          round=2,
          speaker="moderator",
          model=moderator_model,
          role="assistant",
          content=final_answer,
        )
      )
      ev_mod = {
        "type": "debate_turn",
        "debateId": debate_id,
        "turn": {
          "round": 2,
          "speaker": "moderator",
          "model": moderator_model,
          "role": "assistant",
          "content": final_answer,
        },
      }
      yield f"data: {json.dumps(ev_mod, ensure_ascii=False)}\n\n"

      # Chat 本文はモデレーターの最終回答を token ストリームとして流す（疑似）
      text = final_answer or ""
      chunk_size = 80
      for i in range(0, len(text), chunk_size):
        chunk = text[i : i + chunk_size]
        if not chunk:
          continue
        ev = {"type": "token", "delta": chunk}
        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

      debate = DebateThread(
        id=debate_id,
        title="Multi-model debate",
        models=models,
        turns=debate_turns,
      )

      done_ev = {
        "type": "done",
        "result": final_answer,
        "command": getattr(agent_res, "command", None),
        "needsApproval": getattr(agent_res, "needsApproval", False),
        "truncated": getattr(agent_res, "truncated", False),
        "autoContinued": getattr(agent_res, "autoContinued", False),
        "logs": [l.model_dump() for l in getattr(agent_res, "logs", [])],
        "debates": [debate.model_dump()],
      }
      yield f"data: {json.dumps(done_ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(_iter_events_multi(), media_type="text/event-stream")

  # Agent やコード生成系など、その他複雑なモードは既存の ai_assist を利用した疑似ストリーミングを継続
  resp = ai_assist(wid, sess, payload)

  def _iter_events_fallback():
    text = resp.result or ""
    chunk_size = 80
    for i in range(0, len(text), chunk_size):
      chunk = text[i : i + chunk_size]
      if not chunk:
        continue
      ev = {"type": "token", "delta": chunk}
      yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    done_ev = {
      "type": "done",
      "result": resp.result,
      "command": resp.command,
      "needsApproval": resp.needsApproval,
      "truncated": resp.truncated,
      "autoContinued": resp.autoContinued,
      "logs": [l.model_dump() for l in resp.logs] if hasattr(resp, "logs") else [],
      "debates": [d.model_dump() for d in resp.debates] if hasattr(resp, "debates") else [],
    }
    yield f"data: {json.dumps(done_ev, ensure_ascii=False)}\n\n"

  return StreamingResponse(_iter_events_fallback(), media_type="text/event-stream")


@app.post("/watchers/{wid}/sessions/{sess}/ai-inline")
def ai_inline(wid: str, sess: str, payload: AiInlinePayload):
  session_root(wid, sess)
  prefix = payload.prefix[-3000:]
  suffix = payload.suffix[:800]
  if not prefix.strip():
    return {"completion": ""}

  prefix_last_line = prefix.split("\n")[-1] if prefix else ""
  base_indent = ""
  for c in prefix_last_line:
    if c in " \t":
      base_indent += c
    else:
      break

  system_prompt = (
    "You are an inline code completion engine. Output only the completion text. No markdown, no code fences, no explanations. "
    "The cursor is at the end of the last line of 'Text before cursor'. "
    "RULE 1: If the completion should start on a NEW line (e.g. after ':', after '{', function/block body), start your output with a newline and then indented lines. "
    "RULE 2: Do NOT put block bodies on the same line. Use newlines: after 'def foo():' or '{' output a newline then indentation then the body. "
    "RULE 3: First line of your output = continuation of the current line (no leading spaces). Any further lines must start with the same indentation as the last line of 'Text before cursor' (or deeper for nested blocks). "
    "Use spaces or tabs to match the file. Preserve indentation."
  )
  user_prompt = (
    f"Language: {payload.language or 'unknown'}\n"
    f"File: {payload.path}\n\n"
    "Complete the code at the cursor. Use newlines and indentation for blocks (do not put everything on one line).\n\n"
    "Text before cursor:\n"
    f"{prefix}\n\n"
    "Text after cursor:\n"
    f"{suffix}\n"
  )
  out = call_openai_chat_limited(system_prompt, user_prompt, max_tokens=256, model=payload.model)
  out = out.replace("\r\n", "\n").strip()
  lines = out.split("\n")
  if lines and lines[0].strip().startswith("```"):
    first = lines[0].strip().lstrip("`").strip()
    if first.startswith("python"):
      first = first[6:].strip()
      if first:
        lines[0] = first
      else:
        lines = lines[1:]
    elif first.startswith("py"):
      first = first[2:].strip()
      if first:
        lines[0] = first
      else:
        lines = lines[1:]
    else:
      lines = lines[1:]
    if lines and lines[-1].strip() == "```":
      lines = lines[:-1]
  completion = "\n".join(lines).strip()
  if completion:
    last_stripped = prefix_last_line.rstrip()
    if last_stripped and last_stripped[-1] in ")]}\";'":
      if not (completion.startswith("\n") or completion.startswith(" ")):
        first = completion.lstrip()
        if first and (first[0].isalpha() or first[0] in "."):
          completion = "\n" + completion
  if base_indent and completion:
    out_lines = completion.split("\n")
    normalized = [out_lines[0]]
    for line in out_lines[1:]:
      leading = ""
      for c in line:
        if c in " \t":
          leading += c
        else:
          break
      if len(leading) < len(base_indent):
        normalized.append(base_indent + line.lstrip(" \t"))
      else:
        normalized.append(line)
    completion = "\n".join(normalized)
  max_lines = 25
  if completion.count("\n") >= max_lines:
    completion = "\n".join(completion.split("\n")[:max_lines])
  if len(completion) > 1500:
    completion = completion[:1500].rsplit("\n", 1)[0] if "\n" in completion[:1500] else completion[:1500]
  return {"completion": completion}


@app.get("/watchers/{wid}/sessions/{sess}/runner-config", response_model=Optional[RunnerConfigModel])
def get_runner_config(wid: str, sess: str):
  root = session_root(wid, sess)
  conf_path = root / ".runner_config.json"
  if not conf_path.exists():
    return None
  try:
    data = json.loads(conf_path.read_text("utf-8"))
  except Exception:
    raise HTTPException(status_code=500, detail="runner config invalid")
  return RunnerConfigModel(
    mode=data.get("mode", "host"),
    containerName=data.get("container_name"),
    image=data.get("image"),
    mountPath=data.get("mount_path"),
    extraArgs=data.get("extra_args"),
  )


@app.put("/watchers/{wid}/sessions/{sess}/runner-config")
def update_runner_config(wid: str, sess: str, payload: RunnerConfigUpdatePayload):
  root = session_root(wid, sess)
  conf_path = root / ".runner_config.json"
  data = {
    "mode": payload.mode,
    "container_name": payload.containerName,
    "image": payload.image,
    "mount_path": payload.mountPath,
    "extra_args": payload.extraArgs,
  }
  conf_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
  return {"ok": True}


if __name__ == "__main__":
  import uvicorn

  uvicorn.run("backend.app.main:app", host="0.0.0.0", port=8000, reload=True)

