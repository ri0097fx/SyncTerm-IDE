from __future__ import annotations

import base64
import configparser
import json
import mimetypes
import os
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
from fastapi.responses import Response
from pydantic import BaseModel


REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config.ini"


def load_paths():
  if not CONFIG_PATH.exists():
    raise RuntimeError(f"config.ini not found at {CONFIG_PATH}")
  parser = configparser.ConfigParser()
  parser.read(CONFIG_PATH)
  remote = parser["remote"]
  structure = parser["structure"]
  base_path = Path(remote.get("base_path"))
  sessions_dir_name = structure.get("sessions_dir_name", "sessions")
  registry_dir_name = structure.get("registry_dir_name", "_registry")
  sessions_root = base_path / sessions_dir_name
  registry_root = base_path / registry_dir_name
  return base_path, sessions_root, registry_root


BASE_PATH, SESSIONS_ROOT, REGISTRY_ROOT = load_paths()
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


class AiAssistPayload(BaseModel):
  path: str
  action: str
  prompt: str
  selectedText: Optional[str] = None
  fileContent: str


class AiInlinePayload(BaseModel):
  path: str
  prefix: str
  suffix: str
  language: Optional[str] = None


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


@app.get("/watchers", response_model=List[WatcherModel])
def list_watchers():
  return load_watchers()


@app.get("/watchers/{wid}/sessions", response_model=List[SessionModel])
def list_sessions(wid: str):
  root = SESSIONS_ROOT / wid
  if not root.exists():
    return []
  sessions: List[SessionModel] = []
  for d in sorted(root.iterdir()):
    if d.is_dir():
      sessions.append(SessionModel(name=d.name, watcherId=wid))
  return sessions


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
  """RT モードの接続テスト。HTTP で echo コマンドを送り、応答を返す"""
  port = _get_rt_port(wid)
  if port is None:
    return {"ok": False, "error": "rt_port not found", "port": None}
  cmd = "echo __RT_TEST__"
  resp = _post_command_via_rt_with_response(wid, sess, cmd)
  if resp is None:
    return {"ok": False, "error": "HTTP request failed (connection refused or timeout)", "port": port}
  return {"ok": True, "port": port, "response": resp}


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
  resp = _post_command_via_rt_with_response(wid, sess, cmd)
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
  root = session_root(wid, sess)
  log_path = root / "commands.log"
  if not log_path.exists():
    return LogChunk(lines=[], nextOffset=0, hasMore=False)

  total_size = log_path.stat().st_size
  if fromOffset < 0:
    fromOffset = 0
  if fromOffset > total_size:
    fromOffset = total_size

  # Initial fetch: return only tail chunk for responsiveness.
  start = fromOffset
  if fromOffset == 0 and total_size > MAX_LOG_CHUNK_BYTES:
    start = total_size - MAX_LOG_CHUNK_BYTES

  with log_path.open("rb") as f:
    f.seek(start)
    chunk = f.read(MAX_LOG_CHUNK_BYTES)

  try:
    text = chunk.decode("utf-8", errors="replace")
  except Exception:
    text = ""
  # Trim pathological long lines so frontend rendering remains responsive.
  lines = [ln[:4000] for ln in text.splitlines() if ln]
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


def _post_command_via_rt(wid: str, sess: str, command: str) -> bool:
  """RT 経由でコマンド送信。成功時 True"""
  port = _get_rt_port(wid)
  if port is None:
    return False
  url = f"http://127.0.0.1:{port}/command"
  body = json.dumps({"watcherId": wid, "session": sess, "command": command}, ensure_ascii=False).encode("utf-8")
  try:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
      return resp.status == 200
  except Exception:
    return False


def _post_command_via_rt_with_response(wid: str, sess: str, command: str) -> Optional[dict]:
  """RT 経由でコマンド送信し、レスポンス JSON を返す。失敗時 None"""
  port = _get_rt_port(wid)
  if port is None:
    return None
  url = f"http://127.0.0.1:{port}/command"
  body = json.dumps({"watcherId": wid, "session": sess, "command": command}, ensure_ascii=False).encode("utf-8")
  try:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
      return json.loads(resp.read().decode("utf-8", errors="replace"))
  except Exception:
    return None


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


@app.post("/watchers/{wid}/sessions/{sess}/commands")
def post_command(wid: str, sess: str, payload: CommandPayload):
  root = session_root(wid, sess)
  cmd = payload.command.rstrip()

  if _post_command_via_rt(wid, sess, cmd):
    return {"ok": True, "rt": True}

  cmd_file = root / "commands.txt"
  cmd_file.parent.mkdir(parents=True, exist_ok=True)
  with cmd_file.open("a", encoding="utf-8") as f:
    f.write(cmd + "\n")
  return {"ok": True}


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
  watcher_cleaned = _post_command_via_rt(wid, sess, "_internal_cleanup_staged")
  return {
    "ok": True,
    "deleted": deleted,
    "failed": failed,
    "watcher_cleaned": watcher_cleaned,
    "relay_session_exists": relay_session_exists,
  }


def list_dir_entries_via_watcher(wid: str, sess: str, root: Path, rel_path: str) -> List[FileEntryModel]:
  # RT モード: HTTP で即送信し、レスポンスの ls_result を直接使う（rsync 待ち不要）
  cmd = f"_internal_list_dir::{rel_path}"
  resp = _post_command_via_rt_with_response(wid, sess, cmd)
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
  resp = _post_command_via_rt_with_response(wid, sess, cmd)
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
  resp = _post_command_via_rt_with_response(wid, sess, cmd)
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
    "You are a concise coding assistant. Return only the edited code text (no markdown fences).\n"
    f"Action: {payload.action}\n"
    f"User instruction: {payload.prompt}\n"
    f"File path: {payload.path}\n"
    f"Scope: {scope_label}\n\n"
    "Input:\n"
    f"{scope_text}"
  )


def call_openai_chat(system_prompt: str, user_prompt: str) -> str:
  api_key = os.environ.get("OPENAI_API_KEY")
  if not api_key:
    raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set")
  model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
  body = json.dumps(
    {
      "model": model,
      "temperature": 0.2,
      "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
      ],
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
    raise HTTPException(status_code=502, detail=f"ai upstream error: {detail}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"ai request failed: {e}")
  try:
    return str(data["choices"][0]["message"]["content"]).strip()
  except Exception:
    raise HTTPException(status_code=500, detail="invalid ai response format")


def call_openai_chat_limited(system_prompt: str, user_prompt: str, max_tokens: int = 160) -> str:
  api_key = os.environ.get("OPENAI_API_KEY")
  if not api_key:
    raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set")
  model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
  body = json.dumps(
    {
      "model": model,
      "temperature": 0.2,
      "max_tokens": max_tokens,
      "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
      ],
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
    with urllib.request.urlopen(req, timeout=20) as resp:
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
  except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", errors="replace")
    raise HTTPException(status_code=502, detail=f"ai upstream error: {detail}")
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"ai request failed: {e}")
  try:
    return str(data["choices"][0]["message"]["content"]).strip()
  except Exception:
    raise HTTPException(status_code=500, detail="invalid ai response format")


@app.post("/watchers/{wid}/sessions/{sess}/links")
def create_link(wid: str, sess: str, payload: CreateLinkPayload):
  root = session_root(wid, sess)
  source = payload.sourcePath.strip()
  name = payload.linkName.strip()
  if not source or not name:
    raise HTTPException(status_code=400, detail="sourcePath and linkName are required")
  if "/" in name or "\\" in name or ".." in name or "'" in name:
    raise HTTPException(status_code=400, detail="invalid linkName")
  if "'" in source:
    raise HTTPException(status_code=400, detail="single quote is not supported in sourcePath")

  cmd_file = root / "commands.txt"
  cmd_file.parent.mkdir(parents=True, exist_ok=True)
  with cmd_file.open("a", encoding="utf-8") as f:
    f.write(f"_internal_create_link::{source}::{name}\n")
  return {"ok": True}


@app.post("/watchers/{wid}/sessions/{sess}/ai-assist")
def ai_assist(wid: str, sess: str, payload: AiAssistPayload):
  # Validate session access first
  session_root(wid, sess)
  if not payload.prompt.strip():
    raise HTTPException(status_code=400, detail="prompt is required")

  system_prompt = (
    "You are an expert software engineer. Keep responses concise and return only code text "
    "that can directly replace the target scope."
  )
  user_prompt = build_ai_prompt(payload)
  result = call_openai_chat(system_prompt, user_prompt)
  return {"result": result}


@app.post("/watchers/{wid}/sessions/{sess}/ai-inline")
def ai_inline(wid: str, sess: str, payload: AiInlinePayload):
  session_root(wid, sess)
  prefix = payload.prefix[-3000:]
  suffix = payload.suffix[:800]
  if not prefix.strip():
    return {"completion": ""}

  system_prompt = (
    "You are an inline code completion engine. "
    "Return only the immediate continuation text. "
    "Do not add markdown, code fences, or explanations."
  )
  user_prompt = (
    f"Language: {payload.language or 'unknown'}\n"
    f"File: {payload.path}\n\n"
    "Complete the code at the cursor.\n"
    "Text before cursor:\n"
    f"{prefix}\n\n"
    "Text after cursor:\n"
    f"{suffix}\n"
  )
  out = call_openai_chat_limited(system_prompt, user_prompt, max_tokens=120)
  # Safety trim: one suggestion block only
  out = out.replace("\r\n", "\n")
  return {"completion": out}


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

