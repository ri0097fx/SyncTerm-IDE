#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Reverse Tunnel Watcher (RT mode).
HTTP でコマンドを受信し即時実行。ログは relay の log-append に POST。
既存の command_watcher.py とは完全に別実装。
"""
from __future__ import annotations

import base64
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from pathlib import Path
from typing import List, Optional

# ===== Path Settings =====
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BASE_DIR = Path(os.environ.get("COMMANDS_DIR", SCRIPT_DIR)).resolve()

COMMAND_FILE = BASE_DIR / "commands.txt"
LOG_FILE = BASE_DIR / "commands.log"
OFFSET_FILE = BASE_DIR / ".commands.offset"
STATUS_FILE = BASE_DIR / ".watcher_status.json"
LS_RESULT_FILE = BASE_DIR / ".ls_result.txt"

REMOTE_SESSIONS_ROOT = os.environ.get("REMOTE_SESSIONS_ROOT")
REGISTRY_DIR_NAME = os.environ.get("REGISTRY_DIR_NAME", "_registry")
if REMOTE_SESSIONS_ROOT:
    REGISTRY_DIR = Path(REMOTE_SESSIONS_ROOT).parent / REGISTRY_DIR_NAME
else:
    REGISTRY_DIR = BASE_DIR.parent.parent.parent / REGISTRY_DIR_NAME

EOC_MARKER_PREFIX = "__CMD_EXIT_CODE__::"
MAX_OUTPUT_CHARS = 200_000
KEEP_ANSI = os.environ.get("KEEP_ANSI", "0") == "1"
DOCKER_CONTAINER_NAME = os.environ.get("DOCKER_CONTAINER_NAME")
DOCKER_IMAGE_NAME = os.environ.get("DOCKER_IMAGE_NAME")
DOCKER_WORK_DIR = os.environ.get("DOCKER_WORK_DIR", "/workspace")

ANSI_ESCAPE = re.compile(r'\x1B\[[0-?]*[ -/]*[@-~]')
CONDA_EXE = os.environ.get("CONDA_EXE") or shutil.which("conda")
HAS_CONDA = CONDA_EXE is not None

# RT 設定: relay へのログ送信
RELAY_LOG_URL = os.environ.get("RT_RELAY_LOG_URL")  # e.g. http://127.0.0.1:8000
RT_HTTP_PORT = int(os.environ.get("RT_HTTP_PORT", "9001"))
WATCHER_ID = os.environ.get("WATCHER_ID", "default")
DISPLAY_NAME = os.environ.get("DISPLAY_NAME", "RT Watcher")


def _validate_safe_relpath(rel: str) -> None:
    p = Path(rel)
    if p.is_absolute() or any(part == ".." for part in p.parts):
        raise ValueError(f"unsafe relpath: {rel!r}")


class SessionContext:
    """セッションごとの状態"""
    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir).resolve()
        self.cwd = self.base_dir
        self.conda_env: Optional[str] = "base" if HAS_CONDA else None
        # .runner_config.json で conda_env が指定されていれば採用
        cfg = self._get_runner_config()
        if cfg.get("conda_env"):
            self.conda_env = str(cfg["conda_env"]).strip() or self.conda_env

    def _get_runner_config(self) -> dict:
        p = self.base_dir / ".runner_config.json"
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _wrap_conda(self, cmdline: str) -> str:
        if not HAS_CONDA or not self.conda_env:
            return cmdline
        hook = f'$({shlex.quote(CONDA_EXE)} shell.bash hook)'
        inner = f'eval "{hook}"; conda activate {shlex.quote(self.conda_env)}; {cmdline}'
        return "bash -lc " + shlex.quote(inner)

    def _wrap_docker_exec(self, cmdline: str, config: dict) -> tuple:
        container = config.get("container_name") or config.get("image")
        if not container:
            return cmdline, ""
        try:
            rel = self.cwd.relative_to(self.base_dir)
        except ValueError:
            rel = Path(".")
        docker_work_dir = config.get("mount_path") or DOCKER_WORK_DIR
        target = Path(docker_work_dir) / rel
        mount = f"-v {shlex.quote(str(self.base_dir))}:{shlex.quote(docker_work_dir)}"
        user_opt = f"--user {os.getuid()}:{os.getgid()}"
        cmd = f"docker exec -i -w {shlex.quote(str(target))} {shlex.quote(container)} bash -c {shlex.quote(cmdline)}"
        return cmd, f"🐳 [Docker Exec] {container}"

    def _wrap_docker_run(self, cmdline: str, config: dict) -> tuple:
        image = config.get("image")
        if not image:
            return cmdline, ""
        try:
            rel = self.cwd.relative_to(self.base_dir)
        except ValueError:
            rel = Path(".")
        docker_work_dir = config.get("mount_path") or DOCKER_WORK_DIR
        target = Path(docker_work_dir) / rel
        mount = f"-v {shlex.quote(str(self.base_dir))}:{shlex.quote(docker_work_dir)}"
        user_opt = f"--user {os.getuid()}:{os.getgid()}"
        cmd = f"docker run --rm -i {mount} {user_opt} -w {shlex.quote(str(target))} {shlex.quote(image)} bash -c {shlex.quote(cmdline)}"
        return cmd, f"🐳 [Docker Run] {image}"

    def _wrap_command(self, cmdline: str) -> tuple:
        config = self._get_runner_config()
        mode = config.get("mode", "")
        if mode == "docker_exec":
            return self._wrap_docker_exec(cmdline, config)
        if mode == "docker_run":
            return self._wrap_docker_run(cmdline, config)
        return self._wrap_conda(cmdline), ""

    def run_command(self, cmdline: str, output_lines: List[str]) -> int:
        """コマンド実行し output_lines に出力を追加。exit_code を返す"""
        def append(text: str, exit_code: Optional[int] = None):
            t = text
            if not KEEP_ANSI:
                t = ANSI_ESCAPE.sub("", t)
            if MAX_OUTPUT_CHARS and len(t) > MAX_OUTPUT_CHARS:
                t = t[:MAX_OUTPUT_CHARS] + "\n...[truncated]"
            output_lines.append(t)
            if exit_code is not None:
                output_lines.append(f"{EOC_MARKER_PREFIX}{exit_code}")

        stripped = cmdline.lstrip()
        is_python = stripped.startswith("python ") or stripped.startswith("python3 ")

        if is_python:
            try:
                parts = shlex.split(stripped)
            except Exception:
                parts = stripped.split()
            if not parts:
                return 0
            if "-u" not in parts[1:]:
                parts.insert(1, "-u")
            py_log = (self.cwd / "python.log").resolve()
            try:
                py_log.write_text("", encoding="utf-8")
            except Exception:
                pass
            py_cmd = " ".join(shlex.quote(p) for p in parts)
            final_cmd, info = self._wrap_command(py_cmd)
            full = f"{final_cmd} > {shlex.quote(str(py_log))} 2>&1"
            if info:
                append(f"\n{info}")
            proc = subprocess.Popen(full, shell=True, cwd=self.cwd)
            last_pos = 0
            while True:
                if py_log.exists():
                    with py_log.open("r", encoding="utf-8", errors="replace") as f:
                        f.seek(last_pos)
                        chunk = f.read()
                        last_pos = f.tell()
                    if chunk:
                        append(chunk.rstrip("\n"))
                if proc.poll() is not None:
                    if py_log.exists():
                        with py_log.open("r", encoding="utf-8", errors="replace") as f:
                            f.seek(last_pos)
                            chunk = f.read()
                        if chunk:
                            append(chunk.rstrip("\n"))
                    break
                time.sleep(0.1)
            return proc.returncode if proc.returncode is not None else -1

        final_cmd, info = self._wrap_command(cmdline)
        if info:
            append(f"\n{info}")
        proc = subprocess.Popen(
            final_cmd,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=self.cwd,
            encoding="utf-8",
            errors="replace",
        )
        try:
            if proc.stdout:
                for line in proc.stdout:
                    if line:
                        append(line.rstrip("\n"))
            proc.wait()
        except Exception as e:
            append(f"[Watcher] ERROR: {e}")
        return proc.returncode if proc.returncode is not None else -1

    def handle_cd(self, cmd: str, output_lines: List[str]) -> bool:
        parts = cmd.strip().split(maxsplit=1)
        if len(parts) == 1 or parts[1] in ("~", "~/", ""):
            target = Path.home()
        else:
            target_str = os.path.expanduser(parts[1])
            p = Path(target_str)
            if not p.is_absolute():
                p = Path(os.path.normpath(os.path.join(str(self.cwd), target_str)))
            target = p
        if target.is_dir():
            self.cwd = target
            try:
                rel = self.cwd.relative_to(self.base_dir)
                disp = f"./{rel}"
            except ValueError:
                disp = str(self.cwd)
            output_lines.append(f"📂 [CD] -> {disp}")
            output_lines.append(f"{EOC_MARKER_PREFIX}0")
            return True
        output_lines.append(f"cd: no such file: {parts[1] if len(parts) > 1 else ''}")
        output_lines.append(f"{EOC_MARKER_PREFIX}1")
        return False

    def handle_internal(self, cmd: str, output_lines: List[str]) -> Optional[dict]:
        """内部コマンド処理。ls 結果などがあれば dict で返す"""
        if cmd.startswith("_internal_list_dir::"):
            _, rel = cmd.split("::", 1)
            p = (self.base_dir / rel).resolve()
            proc = subprocess.run(
                f"ls -p '{p}'",
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
            )
            ls_file = self.base_dir / ".ls_result.txt"
            if proc.returncode == 0:
                ls_file.write_text(proc.stdout, encoding="utf-8")
            else:
                ls_file.write_text(f"ERROR:\n{proc.stderr}", encoding="utf-8")
            output_lines.append(f"__LS_DONE__::{rel}")
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:{proc.returncode}")
            return {"ls_result": ls_file.read_text(encoding="utf-8") if proc.returncode == 0 else ""}

        if cmd.startswith("_internal_stage_file_for_download::"):
            parts = cmd.split("::", 2)
            rel_path = parts[1] if len(parts) >= 2 else ""
            token = parts[2].strip() if len(parts) >= 3 else ""
            if token and not re.match(r"^[A-Za-z0-9._-]+$", token):
                raise ValueError("Invalid stage token")
            src = (self.base_dir / rel_path).resolve()
            if not src.is_file():
                raise ValueError("Not a file")
            stage_name = f".staged_for_download.{token}" if token else ".staged_for_download"
            dest = self.base_dir / stage_name
            shutil.copy(src, dest)
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            # RT 用: HTTP 応答で内容を返す（テキスト 2MB 以下 / バイナリ 5MB 以下）
            out_extra: dict = {}
            try:
                size = src.stat().st_size
                if 0 < size <= 2_000_000:
                    try:
                        text = src.read_text(encoding="utf-8", errors="strict")
                        out_extra["file_content"] = text
                    except Exception:
                        # バイナリ（画像等）は base64 で返す
                        if size <= 5_000_000:
                            out_extra["file_content_base64"] = base64.b64encode(src.read_bytes()).decode("ascii")
                elif 0 < size <= 5_000_000:
                    out_extra["file_content_base64"] = base64.b64encode(src.read_bytes()).decode("ascii")
            except Exception:
                pass
            # 60 秒後に staged ファイルを削除（relay の rsync 取得後を想定）
            def _cleanup_staged(p: Path) -> None:
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass
            threading.Timer(60.0, _cleanup_staged, args=[dest]).start()
            return out_extra

        if cmd.startswith("_internal_move_staged_file::"):
            _, token, rel_path = cmd.split("::", 2)
            rel_path = rel_path.strip()
            _validate_safe_relpath(rel_path)
            staged = self.base_dir / ".staged_uploads" / token
            # RT: staged_content が渡されていれば直接書き込む（rsync 待ち不要）
            if getattr(self, "_staged_content", None) is not None:
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_text(self._staged_content, encoding="utf-8")
                delattr(self, "_staged_content")
            else:
                for _ in range(40):
                    if staged.exists():
                        break
                    time.sleep(0.5)
                if not staged.exists():
                    raise FileNotFoundError("Staged file missing")
            dest = (self.base_dir / rel_path).resolve()
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".tmp~")
            shutil.copy2(staged, tmp)
            os.replace(tmp, dest)
            try:
                staged.unlink()
            except Exception:
                pass
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            return {}

        if cmd.startswith("_internal_create_file::"):
            _, rel = cmd.split("::", 1)
            _validate_safe_relpath(rel)
            p = self.base_dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch(exist_ok=True)
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            return {}

        if cmd.startswith("_internal_create_dir::"):
            _, rel = cmd.split("::", 1)
            _validate_safe_relpath(rel)
            p = self.base_dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.mkdir(exist_ok=True)
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            return {}

        if cmd.startswith("_internal_delete_path::"):
            _, rel = cmd.split("::", 1)
            _validate_safe_relpath(rel)
            p = self.base_dir / rel
            if p == self.base_dir:
                raise ValueError("Root delete")
            if p.exists() or p.is_symlink():
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p)
                else:
                    p.unlink()
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            return {}

        if cmd.startswith("_internal_create_link::"):
            _, source_path, link_name = cmd.split("::", 2)
            dest = self.base_dir / link_name
            proc = subprocess.run(
                f"ln -sfn '{source_path}' '{dest}'",
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=self.base_dir,
                encoding="utf-8",
                errors="replace",
            )
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:{proc.returncode}")
            return {}

        if cmd == "_internal_clear_log":
            log_file = self.base_dir / "commands.log"
            log_file.write_text("", encoding="utf-8")
            output_lines.append("Log cleared.")
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            return {}

        if cmd == "_internal_reset_cwd":
            self.cwd = self.base_dir
            output_lines.append("📂 [Reset] CWD reset to session root.")
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            return {}

        if cmd == "_internal_cleanup_staged":
            deleted = 0
            failed = 0
            for p in self.base_dir.glob(".staged_for_download*"):
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
            uploads = self.base_dir / ".staged_uploads"
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
            msg = f"Staged キャッシュを削除しました ({deleted} 件)。" + (f" 削除できず: {failed} 件" if failed else "")
            output_lines.append(msg)
            output_lines.append(f"{EOC_MARKER_PREFIX}INTERNAL:0")
            return {}

        return None

    def execute(self, cmd: str) -> tuple:
        """コマンドを実行し (output_text, exit_code, extra) を返す"""
        output_lines: List[str] = []
        cmd = cmd.strip()
        if not cmd or cmd.startswith("#"):
            return "\n".join(output_lines), 0, {}

        if cmd.startswith("cd "):
            self.handle_cd(cmd, output_lines)
            return "\n".join(output_lines), 0, {}

        extra = self.handle_internal(cmd, output_lines)
        if extra is not None:
            return "\n".join(output_lines), 0, extra

        if cmd.strip().startswith("conda activate"):
            parts = cmd.strip().split(maxsplit=2)
            rest = (parts[2].strip() if len(parts) > 2 else "") or ""
            env_name = rest.split()[0] if rest else ""
            if env_name:
                self.conda_env = env_name
                output_lines.append(f"[Watcher] conda activate {env_name!r} (以降のコマンドはこの環境で実行)")
            else:
                output_lines.append("[Watcher] conda activate: 環境名を指定してください (例: conda activate myenv)")
            output_lines.append(f"{EOC_MARKER_PREFIX}0")
            return "\n".join(output_lines), 0, {}
        if cmd.strip() == "conda deactivate":
            self.conda_env = "base" if HAS_CONDA else None
            output_lines.append("[Watcher] conda deactivate (base に戻しました)")
            output_lines.append(f"{EOC_MARKER_PREFIX}0")
            return "\n".join(output_lines), 0, {}

        exit_code = self.run_command(cmd, output_lines)
        return "\n".join(output_lines), exit_code, {}


# セッションコンテキストのキャッシュ
_sessions: dict = {}
_sessions_lock = threading.Lock()


def get_session(base_dir: Path) -> SessionContext:
    with _sessions_lock:
        key = str(base_dir)
        if key not in _sessions:
            _sessions[key] = SessionContext(base_dir)
        return _sessions[key]


def post_log_to_relay(watcher_id: str, session: str, log_text: str) -> bool:
    """relay の log-append にログを POST"""
    url = RELAY_LOG_URL
    if not url:
        return False
    path = f"{url.rstrip('/')}/watchers/{watcher_id}/sessions/{session}/log-append"
    try:
        req = urllib.request.Request(
            path,
            data=log_text.encode("utf-8"),
            headers={"Content-Type": "text/plain; charset=utf-8"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 200
    except Exception as e:
        print(f"[RT] Failed to post log: {e}", flush=True)
        return False


class RTRequestHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/command" or self.path.startswith("/command?"):
            self._handle_command()
        else:
            self.send_error(404)

    def _handle_command(self):
        try:
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len).decode("utf-8", errors="replace")
            data = json.loads(body)
        except Exception as e:
            self._send_json(400, {"error": str(e)})
            return

        watcher_id = data.get("watcherId", WATCHER_ID)
        session = data.get("session", "")
        command = data.get("command", "")

        cmd_preview = (command[:50] + "..") if len(command) > 50 else command
        print(f"[RT /command] received watcher={watcher_id} session={session!r} cmd={cmd_preview!r}", flush=True)

        if not session:
            self._send_json(400, {"error": "session required"})
            return

        # LOCAL_WATCHER_DIR = sessions_root/watcher_id (session の親ディレクトリ)
        local_watcher_dir = Path(os.environ.get("LOCAL_WATCHER_DIR", str(BASE_DIR.parent)))
        base_dir = local_watcher_dir / session
        if not base_dir.is_dir():
            self._send_json(404, {"error": f"session not found: {session}"})
            return

        ctx = get_session(base_dir)
        if command.strip().startswith("_internal_move_staged_file::") and "stagedContent" in data:
            ctx._staged_content = data.get("stagedContent") or ""
        try:
            output, exit_code, extra = ctx.execute(command)
        except Exception as e:
            output = str(e)
            exit_code = 1
            extra = {}
        finally:
            if getattr(ctx, "_staged_content", None) is not None:
                delattr(ctx, "_staged_content")

        log_text = output
        if not log_text.endswith("\n"):
            log_text += "\n"

        if RELAY_LOG_URL:
            post_log_to_relay(watcher_id, session, log_text)

        resp = {"ok": True, "output": output, "exitCode": exit_code, **extra}
        out_len = len(output)
        print(f"[RT /command] responding session={session!r} output_len={out_len} exitCode={exit_code}", flush=True)
        self._send_json(200, resp)

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


POLL_SEC = float(os.environ.get("WATCHER_POLL_SEC", "0.5"))
STAGED_CLEANUP_INTERVAL = 300.0   # 5 分ごと
STAGED_MAX_AGE = 3600.0           # 1 時間以上経過した staged を削除


def _cleanup_staged_files_loop():
    """古い .staged_for_download* と .staged_uploads/* を定期的に削除"""
    while True:
        try:
            time.sleep(STAGED_CLEANUP_INTERVAL)
            local_watcher_dir = Path(os.environ.get("LOCAL_WATCHER_DIR", str(BASE_DIR.parent)))
            if not local_watcher_dir.is_dir():
                continue
            cutoff = time.time() - STAGED_MAX_AGE
            for session_dir in local_watcher_dir.iterdir():
                if not session_dir.is_dir():
                    continue
                try:
                    for p in session_dir.glob(".staged_for_download*"):
                        if p.is_file() and p.stat().st_mtime < cutoff:
                            p.unlink(missing_ok=True)
                    uploads = session_dir / ".staged_uploads"
                    if uploads.is_dir():
                        for p in uploads.iterdir():
                            if p.is_file() and p.stat().st_mtime < cutoff:
                                p.unlink(missing_ok=True)
                except Exception as e:
                    print(f"[RT] Staged cleanup error in {session_dir}: {e}", flush=True)
        except Exception as e:
            print(f"[RT] Staged cleanup loop error: {e}", flush=True)


def _poll_commands_loop():
    """内部コマンド用: commands.txt をポーリング（rsync で取り込まれた分を処理）"""
    local_watcher_dir = Path(os.environ.get("LOCAL_WATCHER_DIR", str(BASE_DIR.parent)))
    watcher_id = os.environ.get("WATCHER_ID", "default")
    offsets: dict[str, int] = {}

    while True:
        try:
            if not local_watcher_dir.is_dir():
                time.sleep(POLL_SEC)
                continue
            for session_dir in local_watcher_dir.iterdir():
                if not session_dir.is_dir():
                    continue
                session = session_dir.name
                cmd_file = session_dir / "commands.txt"
                offset_file = session_dir / ".commands.offset"
                if not cmd_file.exists():
                    continue
                try:
                    lines = cmd_file.read_text("utf-8", errors="replace").splitlines()
                except Exception:
                    continue
                start = offsets.get(session, 0)
                for i, line in enumerate(lines[start:], start=start):
                    cmd = line.strip()
                    if not cmd or cmd.startswith("#"):
                        offsets[session] = i + 1
                        continue
                    base_dir = session_dir
                    ctx = get_session(base_dir)
                    try:
                        output, _, _ = ctx.execute(cmd)
                    except Exception as e:
                        output = str(e)
                    log_text = output if output.endswith("\n") else output + "\n"
                    if RELAY_LOG_URL:
                        post_log_to_relay(watcher_id, session, log_text)
                    try:
                        offset_file.write_text(str(i + 1), encoding="utf-8")
                    except Exception:
                        pass
                    offsets[session] = i + 1
        except Exception as e:
            print(f"[RT] Poll error: {e}", flush=True)
        time.sleep(POLL_SEC)


def main():
    port = RT_HTTP_PORT
    print(f"[RT Watcher] HTTP server on 0.0.0.0:{port}", flush=True)
    print(f"[RT Watcher] RELAY_LOG_URL={RELAY_LOG_URL or '(not set)'}", flush=True)

    poll_thread = threading.Thread(target=_poll_commands_loop, daemon=True)
    poll_thread.start()
    cleanup_thread = threading.Thread(target=_cleanup_staged_files_loop, daemon=True)
    cleanup_thread.start()

    server = ThreadedHTTPServer(("0.0.0.0", port), RTRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[RT Watcher] Stopping...", flush=True)
    server.shutdown()


if __name__ == "__main__":
    main()
