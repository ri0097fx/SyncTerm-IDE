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
from pathlib import PurePosixPath
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

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


class WatcherModel(BaseModel):
  id: str
  displayName: str
  lastHeartbeat: float


class SessionModel(BaseModel):
  name: str
  watcherId: str


class CreateSessionModel(BaseModel):
  name: str


class WatcherStatusModel(BaseModel):
  user: str
  host: str
  cwd: str
  fullCwd: str
  condaEnv: Optional[str] = None
  dockerMode: Optional[str] = None


class FileEntryModel(BaseModel):
  id: str
  name: str
  path: str
  kind: str
  hasChildren: Optional[bool] = False
  isRemoteLink: Optional[bool] = False
  children: Optional[List["FileEntryModel"]] = None


FileEntryModel.model_rebuild()


class RunnerConfigModel(BaseModel):
  mode: str
  containerName: Optional[str] = None
  image: Optional[str] = None
  mountPath: Optional[str] = None
  extraArgs: Optional[str] = None


class LogChunk(BaseModel):
  lines: List[str]
  nextOffset: int
  hasMore: bool


class CommandPayload(BaseModel):
  command: str


class FileContentPayload(BaseModel):
  path: str
  content: str


class FileChunkModel(BaseModel):
  path: str
  offset: int
  length: int
  totalSize: int
  content: str
  hasMore: bool
  nextOffset: int


class RunnerConfigUpdatePayload(BaseModel):
  mode: str
  containerName: Optional[str] = None
  image: Optional[str] = None
  mountPath: Optional[str] = None
  extraArgs: Optional[str] = None


class CreateLinkPayload(BaseModel):
  sourcePath: str
  linkName: str


class CreatePathPayload(BaseModel):
  path: str
  kind: str  # "file" | "dir"


class DeletePathPayload(BaseModel):
  path: str


class CopyPathPayload(BaseModel):
  sourcePath: str
  destPath: str


class MovePathPayload(BaseModel):
  sourcePath: str
  destPath: str


class UploadFilePayload(BaseModel):
  path: str
  contentBase64: str


def _norm_rel(path: str) -> str:
  """Session-relative path to Watcher rel path (no leading /, no ..)."""
  p = path.strip().lstrip("/").replace("\\", "/")
  if ".." in p.split("/") or p.startswith(".."):
    raise ValueError("path must not contain ..")
  return p or "."


class ChatMessage(BaseModel):
  role: str  # "user" | "assistant"
  content: str


class AiAssistPayload(BaseModel):
  path: str
  action: str
  prompt: str
  selectedText: Optional[str] = None
  fileContent: str
  history: Optional[List[ChatMessage]] = None
  model: Optional[str] = None
  mode: Optional[str] = None  # agent | plan | debug | ask
  # Agent 用: エディタの現在のコンテキスト（コード直接変更・推論に利用）
  editorPath: Optional[str] = None
  editorSelectedText: Optional[str] = None
  editorContent: Optional[str] = None
  # 思考レベル: quick | balanced | deep
  thinking: Optional[str] = None


class AiInlinePayload(BaseModel):
  path: str
  prefix: str
  suffix: str
  language: Optional[str] = None
  model: Optional[str] = None


class AiEnsureModelPayload(BaseModel):
  model: str


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
def get_file_tree(wid: str, sess: str, path: str = Query("/", description="root path, currently ignored")):
  root = session_root(wid, sess)
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
    out = rt_resp.get("output", "")
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
    is_dir = name.endswith("/")
    clean = name[:-1] if is_dir else name
    if not clean or clean.startswith("."):
      continue
    item_rel = f"{base_rel}/{clean}" if base_rel else clean
    out.append(
      FileEntryModel(
        id=item_rel,
        name=clean,
        path="/" + item_rel,
        kind="dir" if is_dir else "file",
        hasChildren=bool(is_dir),
        isRemoteLink=False,
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


def _call_ollama(messages: list, max_tokens: int = 512, temperature: float = 0.2, model: Optional[str] = None) -> str:
  """Ollama を呼ぶ（API キー不要。Relay 上で ollama serve を起動しておく）。"""
  base = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
  model = model or os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b")
  body = json.dumps(
    {
      "model": model,
      "messages": messages,
      "stream": False,
      "options": {"temperature": temperature, "num_predict": max_tokens},
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
    return str(data.get("message", {}).get("content", "")).strip()
  except Exception:
    raise HTTPException(status_code=500, detail="invalid Ollama response format")


def _call_openai(messages: list, max_tokens: int = 512, temperature: float = 0.2) -> str:
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
    return str(data["choices"][0]["message"]["content"]).strip()
  except Exception:
    raise HTTPException(status_code=500, detail="invalid OpenAI response format")


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


def _call_llm_messages(messages: List[dict], max_tokens: int = 900, temperature: float = 0.2, model: Optional[str] = None) -> str:
  """複数メッセージ（会話履歴含む）で LLM を呼ぶ。"""
  provider = (os.environ.get("AI_PROVIDER") or "").strip().lower()
  if not provider and os.environ.get("OPENAI_API_KEY"):
    provider = "openai"
  if not provider:
    provider = "ollama"
  if provider == "ollama":
    return _call_ollama(messages, max_tokens=max_tokens, temperature=temperature, model=model)
  if provider == "openai":
    return _call_openai(messages, max_tokens=max_tokens, temperature=temperature)
  raise HTTPException(status_code=400, detail=f"unsupported AI_PROVIDER: {provider}")


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
          "qwen2.5-coder:1.5b",
          "qwen2.5-coder:3b",
          "qwen2.5-coder:7b",
          "qwen2.5-coder:14b",
          "qwen2.5-coder:32b",
          "deepseek-coder:6.7b",
          "deepseek-coder:33b",
          "llama3.2",
          "mistral",
        ]
        merged: List[str] = []
        for name in user_models + base_defaults:
          if name and name not in merged:
            merged.append(name)
        return merged
  except Exception:
    pass
  # デフォルトの候補（すべて無料のオープンモデル）
  # - qwen2.5-coder 系: コード特化で高性能（サイズ違い）
  # - deepseek-coder 系: 強力なコード向けモデル
  # - llama3.2 / mistral: 汎用タスク向け
  return [
    "qwen2.5-coder:1.5b",
    "qwen2.5-coder:3b",
    "qwen2.5-coder:7b",
    "qwen2.5-coder:14b",
    "qwen2.5-coder:32b",
    "deepseek-coder:6.7b",
    "deepseek-coder:33b",
    "llama3.2",
    "mistral",
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
    data = _ollama_request("/api/tags", timeout=10)
    installed = [m.get("name", "").strip() for m in data.get("models", []) if m.get("name")]
    installed = list(dict.fromkeys(installed))
  except Exception:
    installed = []
  suggested = _ollama_suggested_models()
  default = (os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b").strip()
  if default and default not in suggested:
    suggested = [default] + [s for s in suggested if s != default]
  return {"installed": installed, "suggested": suggested, "provider": provider}


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


def _extract_command_from_response(text: str) -> Optional[str]:
  m = re.search(r"<command>\s*(.*?)\s*</command>", text, re.DOTALL | re.IGNORECASE)
  if not m:
    return None
  return m.group(1).strip()


def _strip_command_tags(text: str) -> str:
  return re.sub(r"<command>[\s\S]*?</command>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()


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
  for _ in range(max_iterations):
    response = _call_llm_messages(messages, max_tokens=max_tokens, temperature=temperature, model=model)
    cmd = _extract_command_from_response(response)
    if not cmd:
      return AiAssistResponse(result=response)
    if _is_potentially_destructive_command(cmd):
      cleaned = _strip_command_tags(response)
      if not cleaned:
        cleaned = f"危険な可能性があるコマンドのため自動実行できません。\n\n提案コマンド:\n{cmd}"
      return AiAssistResponse(result=cleaned, command=cmd, needsApproval=True)
    rt_resp, rt_error = _post_command_via_rt_with_response(wid, sess, cmd, timeout=120)
    if rt_resp is not None:
      out = rt_resp.get("output", "")
      exit_code = rt_resp.get("exitCode", 0)
      if len(out) > 8000:
        out = "... (truncated) ...\n" + out[-8000:]
      feedback = f"[Command executed]\n$ {cmd}\n\nExit code: {exit_code}\n\nOutput:\n{out}"
    else:
      feedback = f"[Command failed - terminal unavailable]\n$ {cmd}\n\nError: {rt_error}\n\nContinue without running more commands; provide your answer based on what you know."
    messages.append({"role": "assistant", "content": response})
    messages.append({"role": "user", "content": feedback})
  final = _call_llm_messages(messages, max_tokens=max_tokens, temperature=temperature, model=model)
  return AiAssistResponse(result=final)


class AiAssistResponse(BaseModel):
  result: str
  command: Optional[str] = None
  needsApproval: bool = False


@app.post("/watchers/{wid}/sessions/{sess}/ai-assist")
def ai_assist(wid: str, sess: str, payload: AiAssistPayload):
  session_root(wid, sess)
  if not payload.prompt.strip():
    raise HTTPException(status_code=400, detail="prompt is required")

  thinking = (payload.thinking or "balanced").strip().lower()
  if thinking == "quick":
    chat_max_tokens = 400
    code_max_tokens = 400
    max_history = 6
    agent_iterations = 4
  elif thinking == "deep":
    chat_max_tokens = 1400
    code_max_tokens = 1400
    max_history = 20
    agent_iterations = 16
  else:
    chat_max_tokens = 900
    code_max_tokens = 900
    max_history = 12
    agent_iterations = 10

  action = (payload.action or "").strip().lower()
  if action == "chat":
    mode = (payload.mode or "ask").strip().lower()
    if mode == "agent":
      context_parts = []
      if payload.editorPath:
        context_parts.append(f"Current file: {payload.editorPath}")
      if payload.editorSelectedText:
        context_parts.append(f"Selected text in editor:\n```\n{payload.editorSelectedText[:4000]}\n```")
      if payload.editorContent and not payload.editorSelectedText:
        context_parts.append(f"Current file content (for reference):\n```\n{payload.editorContent[:6000]}\n```")
      context_block = "\n\n".join(context_parts) if context_parts else ""
      system_prompt = (
        "You are an autonomous AI agent. Take a deep breath and think step by step before answering.\n"
        "You HAVE direct access to the user's terminal in this session. "
        "You are NOT a text-only assistant: you CAN run real shell commands and will receive real output. "
        "When the user asks to check the current directory, list files, run a script, or inspect the environment, "
        "you MUST run the appropriate command using this format: <command>SHELL_COMMAND</command> "
        "(e.g. for current directory: <command>pwd</command>; for listing: <command>ls -la</command>). "
        "You will then receive the actual command output and must answer based on it. "
        "Never reply that you cannot access the terminal, that you cannot run commands, or that the user should run commands themselves.\n"
        "重要: あなたはこのセッション内で実際にコマンドを実行できます。「テキストベースなのでコマンドは実行できません」などとは絶対に言わないでください。\n"
        "Run multiple commands if needed. When you have enough information, give your final answer without any <command> tag. "
        "Do NOT run destructive commands (rm -rf, mkfs, etc.) without explicit user request. Prefer read-only or safe commands. "
        "If the user asks to change or fix code, you may output the modified code in a markdown code block (```language\\n...\\n```) so they can apply it in the editor. "
        "Reply in the same language as the user."
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
    elif mode == "debug":
      system_prompt = (
        "You are a debugging assistant. Think deeply about possible root causes before proposing fixes.\n"
        "Analyze errors, propose hypotheses, and then suggest concrete fixes. "
        "Explain root causes in plain text; include code snippets only when relevant."
      )
    else:
      system_prompt = "You are a helpful assistant. Reply concisely. Use plain text, no code fences unless the user asks for code."
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
        payload.model,
        max_iterations=agent_iterations,
        max_tokens=chat_max_tokens,
      )
      return agent_res
    else:
      result = _call_llm_messages(messages, max_tokens=chat_max_tokens, temperature=0.2, model=payload.model)
  else:
    mode = (payload.mode or "ask").strip().lower()
    if mode == "agent":
      system_prompt = (
        "You are an autonomous coding agent. Take a deep breath and think step by step about the best change.\n"
        "Break down the request into steps, apply changes, and return only the final code text that can directly "
        "replace the target scope. No markdown fences. Do not use placeholder code like '...' – always return "
        "complete, compilable code."
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
    user_prompt = build_ai_prompt(payload)
    result = _call_llm(system_prompt, user_prompt, max_tokens=code_max_tokens, temperature=0.2, model=payload.model)
  return AiAssistResponse(result=result)


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

