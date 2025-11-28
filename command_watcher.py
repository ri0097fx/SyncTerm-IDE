#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import time
import shlex
import json
import re
import getpass
import socket
import subprocess
import argparse
import shutil
from pathlib import Path
from typing import List, Tuple, Optional
from queue import Queue
import threading

# ===== Path Settings (shared dir via env) =====
# COMMANDS_DIRは起動元のwatcher_manager.shによって設定される
BASE_DIR = Path(os.environ.get("COMMANDS_DIR", Path(__file__).resolve().parent)).resolve()
COMMAND_FILE = (BASE_DIR / "commands.txt").resolve()
LOG_FILE     = (BASE_DIR / "commands.log").resolve()
OFFSET_FILE  = (BASE_DIR / ".commands.offset").resolve()
STATUS_FILE  = (BASE_DIR / ".watcher_status.json").resolve()
LS_RESULT_FILE = (BASE_DIR / ".ls_result.txt").resolve()

# ===== Registration Settings =====
REMOTE_SESSIONS_ROOT = os.environ.get("REMOTE_SESSIONS_ROOT")
REGISTRY_DIR_NAME = os.environ.get("REGISTRY_DIR_NAME", "_registry")

if not REMOTE_SESSIONS_ROOT:
    REGISTRY_DIR = BASE_DIR.parent.parent.parent / REGISTRY_DIR_NAME
else:
    REGISTRY_DIR = Path(REMOTE_SESSIONS_ROOT).parent / REGISTRY_DIR_NAME

HEARTBEAT_INTERVAL_SEC = 4.0

# ===== Configuration =====
EOC_MARKER_PREFIX = "__CMD_EXIT_CODE__::"
ALLOWED_CMDS: List[str] = []
MAX_OUTPUT_CHARS = 200_000
POLL_SEC = float(os.environ.get("WATCHER_POLL_SEC", "0.25"))
KEEP_ANSI = os.environ.get("KEEP_ANSI", "0") == "1"

# --- Static Docker Configuration (from env) ---
DOCKER_CONTAINER_NAME = os.environ.get("DOCKER_CONTAINER_NAME") # 常駐コンテナ (exec)
DOCKER_IMAGE_NAME = os.environ.get("DOCKER_IMAGE_NAME")         # 使い捨てコンテナ (run)
DOCKER_WORK_DIR = os.environ.get("DOCKER_WORK_DIR", "/workspace")
# ==========================

ANSI_ESCAPE = re.compile(r'\x1B\[[0-?]*[ -/]*[@-~]')

# --- Set CWD to BASE_DIR on startup ---
try:
    os.chdir(BASE_DIR)
except FileNotFoundError:
    print(f"[Watcher] ERROR: Session directory not found, cannot chdir to {BASE_DIR}")
    raise SystemExit(1)
CURRENT_CWD = BASE_DIR

# ===== Conda detection =====
CONDA_EXE = os.environ.get("CONDA_EXE") or shutil.which("conda")
HAS_CONDA = CONDA_EXE is not None
ACTIVE_CONDA_ENV: Optional[str] = "base" if HAS_CONDA else None

CMD_QUEUE: "Queue[str]" = Queue()
LOG_LOCK = threading.Lock()


def _validate_safe_relpath(rel: str) -> None:
    p = Path(rel)
    if p.is_absolute() or any(part == ".." for part in p.parts):
        raise ValueError(f"unsafe relpath: {rel!r}")


def update_registration(unique_id: str, display_name: str) -> None:
    try:
        REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
        registration_file = REGISTRY_DIR / unique_id
        reg_data = {"display_name": display_name, "last_heartbeat": time.time()}
        registration_file.write_text(json.dumps(reg_data, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[Watcher] Error updating registration: {e}")


def unregister(unique_id: str) -> None:
    try:
        registration_file = REGISTRY_DIR / unique_id
        if registration_file.exists():
            registration_file.unlink()
            print(f"\n[Watcher] Unregistered '{unique_id}'.")
    except Exception as e:
        print(f"[Watcher] Error unregistering: {e}")


def _host_short() -> str:
    return socket.gethostname().split('.')[0]


def _get_runner_config() -> dict:
    """セッションディレクトリ内の .runner_config.json を読み込む"""
    config_path = BASE_DIR / ".runner_config.json"
    if config_path.exists():
        try:
            return json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def update_status_file() -> None:
    # 実行モードの判定（ステータス表示用）
    config = _get_runner_config()
    conf_mode = config.get("mode")
    
    mode_str = "Host"
    if conf_mode == "docker_run":
        mode_str = f"🐳 Run: {config.get('image', '?')}"
    elif conf_mode == "docker_exec":
        target = config.get("container_name") or config.get("image", "?")
        mode_str = f"🐳 Exec: {target}"
    elif conf_mode == "host":
        mode_str = "💻 Host"
    elif DOCKER_CONTAINER_NAME:
        mode_str = f"🐳 Exec(Env): {DOCKER_CONTAINER_NAME}"
    elif DOCKER_IMAGE_NAME:
        mode_str = f"🐳 Run(Env): {DOCKER_IMAGE_NAME}"

    # CWDを相対パスで見やすくする
    try:
        pretty_cwd = f"./{CURRENT_CWD.relative_to(BASE_DIR)}"
    except ValueError:
        pretty_cwd = str(CURRENT_CWD)

    status_data = {
        "user": getpass.getuser(),
        "host": _host_short(),
        "cwd": pretty_cwd,
        "full_cwd": str(CURRENT_CWD),
        "conda_env": ACTIVE_CONDA_ENV,
        "has_conda": HAS_CONDA,
        "conda_exe": CONDA_EXE,
        "docker_mode": mode_str,
    }
    try:
        STATUS_FILE.write_text(json.dumps(status_data, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[Watcher] Error updating status file: {e}")


def ensure_files() -> None:
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    COMMAND_FILE.touch(exist_ok=True)
    LOG_FILE.touch(exist_ok=True)
    if not OFFSET_FILE.exists():
        OFFSET_FILE.write_text("0", encoding="utf-8")
    update_status_file()


def read_offset() -> int:
    try:
        return int(OFFSET_FILE.read_text(encoding="utf-8").strip())
    except Exception:
        OFFSET_FILE.write_text("0", encoding="utf-8")
        return 0


def write_offset(n: int) -> None:
    OFFSET_FILE.write_text(str(n), encoding="utf-8")


def read_new_lines(start_line: int) -> Tuple[list, int]:
    if not COMMAND_FILE.exists():
        return [], start_line
    lines = COMMAND_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    return lines[start_line:], len(lines)


def log_append_output(out: str, exit_code: Optional[int] = None, kind: str = "user") -> None:
    text = out
    if not KEEP_ANSI:
        text = ANSI_ESCAPE.sub("", text)
    if MAX_OUTPUT_CHARS and len(text) > MAX_OUTPUT_CHARS:
        text = text[:MAX_OUTPUT_CHARS] + "\n...[truncated]"

    if exit_code is not None:
        if kind == "internal":
            text += f"\n{EOC_MARKER_PREFIX}INTERNAL:{exit_code}\n"
        else:
            text += f"\n{EOC_MARKER_PREFIX}{exit_code}\n"

    with LOG_LOCK:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            if text.endswith("\n"):
                f.write(text)
            else:
                f.write(text + "\n")


def allowed_to_run(cmdline: str) -> bool:
    if not ALLOWED_CMDS:
        return True
    try:
        return shlex.split(cmdline, posix=True)[0] in ALLOWED_CMDS
    except Exception:
        return False


def _wrap_with_conda_if_needed(cmdline: str) -> str:
    if not HAS_CONDA:
        return cmdline
    if not ACTIVE_CONDA_ENV or ACTIVE_CONDA_ENV == "base":
        return cmdline

    hook_cmd = f'$({shlex.quote(CONDA_EXE)} shell.bash hook)'
    inner = (
        f'eval "{hook_cmd}"; '
        f'conda activate {shlex.quote(ACTIVE_CONDA_ENV)}; '
        f'{cmdline}'
    )
    return "bash -lc " + shlex.quote(inner)


def _ensure_container_exists(container: str, image: str, mount_opt: str, user_opt: str, extra: str) -> None:
    """指定されたコンテナが存在しない場合、作成して起動する"""
    if not container or not image: return

    # Check if container exists
    check = subprocess.run(
        f"docker container inspect {shlex.quote(container)}", 
        shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    
    if check.returncode != 0:
        # Not found -> Create & Start (Daemon mode)
        log_append_output(f"🐳 Creating new container: {container} from {image} ...", exit_code=0)
        
        create_cmd = (
            f"docker run -dt --name {shlex.quote(container)} "
            f"{mount_opt} {user_opt} {extra} "
            f"{shlex.quote(image)} bash"
        )
        
        proc = subprocess.run(create_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if proc.returncode == 0:
            log_append_output(f"✅ Container '{container}' started.", exit_code=0)
        else:
            log_append_output(f"❌ Failed to create container: {proc.stderr}", exit_code=1)
    else:
        # Exists -> Ensure it's running (start if stopped)
        state_check = subprocess.run(
            f"docker inspect -f '{{{{.State.Running}}}}' {shlex.quote(container)}",
            shell=True, stdout=subprocess.PIPE, text=True
        )
        if state_check.returncode == 0 and "true" not in state_check.stdout.lower():
             log_append_output(f"🔄 Starting stopped container: {container} ...", exit_code=0)
             subprocess.run(f"docker start {shlex.quote(container)}", shell=True)


def _wrap_with_docker_exec_dynamic(cmdline: str, config: dict) -> Tuple[str, str]:
    """GUI設定ファイルに基づくDocker Exec（自動作成機能付き）"""
    container = config.get("container_name")
    if not container:
        container = config.get("image") # 互換性
    image = config.get("image")
    
    if not container:
        return cmdline, ""

    try:
        rel_path = CURRENT_CWD.relative_to(BASE_DIR)
    except ValueError:
        rel_path = Path(".")
    
    docker_work_dir = config.get("mount_path") or DOCKER_WORK_DIR
    target_workdir = Path(docker_work_dir) / rel_path
    
    # 自動作成ロジック: コンテナがない場合に備えてチェック
    mount_opt = f"-v {shlex.quote(str(BASE_DIR))}:{shlex.quote(docker_work_dir)}"
    user_opt = f"--user {os.getuid()}:{os.getgid()}"
    extra_args = config.get("extra_args", "")
    
    if image:
        _ensure_container_exists(container, image, mount_opt, user_opt, extra_args)

    quoted_cmd = shlex.quote(cmdline)
    
    cmd = (
        f"docker exec -i "
        f"-w {shlex.quote(str(target_workdir))} "
        f"{shlex.quote(container)} "
        f"bash -c {quoted_cmd}"
    )
    return cmd, f"🐳 [Docker Exec] {container} 📂 {target_workdir}"


def _wrap_with_docker_run_dynamic(cmdline: str, config: dict) -> Tuple[str, str]:
    """GUI設定ファイルに基づくDocker実行（動的設定）"""
    image = config.get("image")
    if not image: return cmdline, ""

    extra_args = config.get("extra_args", "")
    
    try:
        rel_path = CURRENT_CWD.relative_to(BASE_DIR)
    except ValueError:
        rel_path = Path(".")
    
    docker_work_dir = config.get("mount_path") or DOCKER_WORK_DIR
    target_workdir = Path(docker_work_dir) / rel_path
    quoted_cmd = shlex.quote(cmdline)
    
    mount_opt = f"-v {shlex.quote(str(BASE_DIR))}:{shlex.quote(docker_work_dir)}"
    user_opt = f"--user {os.getuid()}:{os.getgid()}"
    
    cmd = (
        f"docker run --rm -i "
        f"{mount_opt} "
        f"{user_opt} "
        f"{extra_args} "
        f"-w {shlex.quote(str(target_workdir))} "
        f"{shlex.quote(image)} "
        f"bash -c {quoted_cmd}"
    )
    return cmd, f"🐳 [Docker Run] {image} 📂 {target_workdir}"


def _wrap_with_docker_if_needed(cmdline: str) -> str:
    """環境変数設定に基づくDocker実行（静的設定・レガシー）"""
    try:
        rel_path = CURRENT_CWD.relative_to(BASE_DIR)
    except ValueError:
        rel_path = Path(".")
    target_workdir = Path(DOCKER_WORK_DIR) / rel_path
    quoted_cmd = shlex.quote(cmdline)

    if DOCKER_CONTAINER_NAME:
        return (
            f"docker exec -i "
            f"-w {shlex.quote(str(target_workdir))} "
            f"{shlex.quote(DOCKER_CONTAINER_NAME)} "
            f"bash -c {quoted_cmd}"
        )
    elif DOCKER_IMAGE_NAME:
        mount_opt = f"-v {shlex.quote(str(BASE_DIR))}:{shlex.quote(DOCKER_WORK_DIR)}"
        user_opt = f"--user {os.getuid()}:{os.getgid()}"
        return (
            f"docker run --rm -i "
            f"{mount_opt} "
            f"{user_opt} "
            f"-w {shlex.quote(str(target_workdir))} "
            f"{shlex.quote(DOCKER_IMAGE_NAME)} "
            f"bash -c {quoted_cmd}"
        )
    return cmdline


def _wrap_command_final(cmdline: str) -> Tuple[str, str]:
    config = _get_runner_config()
    mode = config.get("mode", "")
    
    if mode == "docker_exec":
        return _wrap_with_docker_exec_dynamic(cmdline, config)

    if mode == "docker_run":
        return _wrap_with_docker_run_dynamic(cmdline, config)
    
    if mode == "host":
        return _wrap_with_conda_if_needed(cmdline), ""

    # Fallback to Env vars
    if DOCKER_CONTAINER_NAME:
        return _wrap_with_docker_if_needed(cmdline), f"🐳 [Docker Exec (Env)] {DOCKER_CONTAINER_NAME}"
    elif DOCKER_IMAGE_NAME:
        return _wrap_with_docker_if_needed(cmdline), f"🐳 [Docker Run (Env)] {DOCKER_IMAGE_NAME}"
    
    return _wrap_with_conda_if_needed(cmdline), ""


def run_command_local(cmdline: str) -> None:
    global CURRENT_CWD
    stripped = cmdline.lstrip()
    is_python = stripped.startswith("python ") or stripped.startswith("python3 ")

    if is_python:
        try: parts = shlex.split(stripped)
        except: parts = stripped.split()
        if not parts: return
        if "-u" not in parts[1:]: parts.insert(1, "-u")

        python_log_path = (CURRENT_CWD / "python.log").resolve()
        try: python_log_path.write_text("", encoding="utf-8")
        except: pass

        py_cmd_no_redir = " ".join(shlex.quote(p) for p in parts)
        base_cmd, info = _wrap_command_final(py_cmd_no_redir)
        final_cmd = f"{base_cmd} > {shlex.quote(str(python_log_path))} 2>&1"
        
        if info: log_append_output(f"\n{info}")

        proc = subprocess.Popen(final_cmd, shell=True, cwd=CURRENT_CWD)

        last_pos = 0
        try:
            while True:
                if python_log_path.exists():
                    with python_log_path.open("r", encoding="utf-8", errors="replace") as f:
                        f.seek(last_pos)
                        chunk = f.read()
                        last_pos = f.tell()
                    if chunk: log_append_output(chunk.rstrip("\n"))
                
                if proc.poll() is not None:
                    if python_log_path.exists():
                        with python_log_path.open("r", encoding="utf-8", errors="replace") as f:
                            f.seek(last_pos)
                            chunk = f.read()
                        if chunk: log_append_output(chunk.rstrip("\n"))
                    break
                time.sleep(0.1)
        except Exception as e:
            log_append_output(f"[Watcher] ERROR streaming python.log: {e}")

        log_append_output("", exit_code=proc.returncode if proc.returncode is not None else -1)
        update_status_file()
        return

    final_cmd, info = _wrap_command_final(cmdline)
    if info: log_append_output(f"\n{info}")

    proc = subprocess.Popen(
        final_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, cwd=CURRENT_CWD, encoding="utf-8", errors="replace",
    )
    try:
        if proc.stdout is not None:
            for line in proc.stdout:
                if line: log_append_output(line.rstrip("\n"))
        proc.wait()
    except Exception as e:
        log_append_output(f"[Watcher] ERROR streaming output: {e}")

    log_append_output("", exit_code=proc.returncode if proc.returncode is not None else -1)
    update_status_file()


def _handle_cd(cmd: str) -> None:
    global CURRENT_CWD
    parts = cmd.strip().split(maxsplit=1)
    if len(parts) == 1 or parts[1] in ("~", "~/", ""): target_dir = Path.home()
    else:
        target_str = os.path.expanduser(parts[1])
        p = Path(target_str)
        # ★ 重要: 相対パスの場合はリンク解決(resolve)せず、論理パス結合を行う
        # これにより "session_dir/link_name" というパス構造を維持し、Docker側のマウントと一致させる
        if not p.is_absolute():
            new_path_str = os.path.normpath(os.path.join(str(CURRENT_CWD), target_str))
            p = Path(new_path_str)
        target_dir = p

    if target_dir.is_dir():
        os.chdir(target_dir)
        CURRENT_CWD = target_dir
        
        # ログ表示の工夫
        try:
            rel = CURRENT_CWD.relative_to(BASE_DIR)
            disp = f"./{rel}"
        except ValueError:
            disp = str(CURRENT_CWD)
        log_append_output(f"📂 [CD] -> {disp}", exit_code=0)
    else:
        log_append_output(f"cd: no such file: {parts[1] if len(parts)>1 else ''}", exit_code=1)
    update_status_file()


def _handle_conda_activate(cmd: str) -> None:
    global ACTIVE_CONDA_ENV
    config = _get_runner_config()
    is_docker = bool(config.get("mode") in ("docker_run", "docker_exec") or DOCKER_CONTAINER_NAME or DOCKER_IMAGE_NAME)
    
    if is_docker:
        log_append_output("[Watcher] Ignored 'conda activate' in Docker mode.", exit_code=0)
        return
    if not HAS_CONDA:
        log_append_output("conda: not available.", exit_code=1)
        return
    try:
        parts = shlex.split(cmd)
        if len(parts) > 2:
            ACTIVE_CONDA_ENV = parts[2]
            log_append_output(f"[Watcher] Switched env: {ACTIVE_CONDA_ENV}", exit_code=0)
        else:
            log_append_output("conda activate: missing env name", exit_code=1)
    except Exception as e:
        log_append_output(str(e), exit_code=1)
    update_status_file()


def _handle_conda_deactivate() -> None:
    global ACTIVE_CONDA_ENV
    config = _get_runner_config()
    is_docker = bool(config.get("mode") in ("docker_run", "docker_exec") or DOCKER_CONTAINER_NAME or DOCKER_IMAGE_NAME)

    if is_docker:
        log_append_output("[Watcher] Ignored 'conda deactivate' in Docker mode.", exit_code=0)
        return
    if not HAS_CONDA:
        log_append_output("conda: not available.", exit_code=1)
        return
    ACTIVE_CONDA_ENV = "base"
    log_append_output("[Watcher] Deactivated env.", exit_code=0)
    update_status_file()


def _cleanup_staged_files() -> None:
    staged_dir = BASE_DIR / ".staged_uploads"
    if not staged_dir.exists(): return
    threshold = time.time() - 3600
    try:
        for p in staged_dir.iterdir():
            if p.is_file():
                try:
                    if p.stat().st_mtime < threshold: p.unlink()
                except: pass
    except: pass


def process_new_commands() -> None:
    offset = read_offset()
    lines, total = read_new_lines(offset)
    if not lines: return

    for line in lines:
        cmd = line.strip()
        offset += 1
        try:
            if not cmd or cmd.startswith("#"): continue

            # Internal commands
            elif cmd.startswith("_internal_stage_file_for_download::"):
                try:
                    _, rel_path = cmd.split("::", 1)
                    src = (BASE_DIR / rel_path).resolve()
                    if not src.is_file(): raise ValueError("Not a file")
                    shutil.copy(src, BASE_DIR / ".staged_for_download")
                    log_append_output("", exit_code=0, kind="internal")
                except Exception as e:
                    log_append_output(f"Stage failed: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd.startswith("_internal_move_staged_file::"):
                try:
                    _, token, rel_path = cmd.split("::", 2)
                    _validate_safe_relpath(rel_path)
                    staged = BASE_DIR / ".staged_uploads" / token
                    
                    retry, max_r = 0, 40
                    while not staged.exists() and retry < max_r:
                        time.sleep(0.5); retry += 1
                    if not staged.exists(): raise FileNotFoundError("Staged file missing after wait")

                    dest = (BASE_DIR / rel_path).resolve()
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    tmp = dest.with_suffix(dest.suffix + ".tmp~")
                    shutil.copy2(staged, tmp)
                    os.replace(tmp, dest)
                    try: staged.unlink()
                    except: pass
                    log_append_output("", exit_code=0, kind="internal")
                except Exception as e:
                    log_append_output(f"Move failed: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd.startswith("_internal_create_file::"):
                try:
                    _, rel = cmd.split("::", 1)
                    _validate_safe_relpath(rel)
                    p = BASE_DIR / rel
                    p.parent.mkdir(parents=True, exist_ok=True); p.touch(exist_ok=True)
                    log_append_output("", exit_code=0, kind="internal")
                except Exception as e:
                    log_append_output(f"Create file error: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd.startswith("_internal_create_dir::"):
                try:
                    _, rel = cmd.split("::", 1)
                    _validate_safe_relpath(rel)
                    p = BASE_DIR / rel
                    p.parent.mkdir(parents=True, exist_ok=True); p.mkdir(exist_ok=True)
                    log_append_output("", exit_code=0, kind="internal")
                except Exception as e:
                    log_append_output(f"Create dir error: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd.startswith("_internal_delete_path::"):
                try:
                    _, rel = cmd.split("::", 1)
                    _validate_safe_relpath(rel)
                    p = BASE_DIR / rel
                    if p == BASE_DIR: raise ValueError("Root delete")
                    if p.exists() or p.is_symlink():
                        if p.is_dir() and not p.is_symlink(): shutil.rmtree(p)
                        else: p.unlink()
                    log_append_output("", exit_code=0, kind="internal")
                except Exception as e:
                    log_append_output(f"Delete error: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd.startswith("_internal_create_link::"):
                try:
                    _, source_path, link_name = cmd.split("::", 2)
                    destination_path = BASE_DIR / link_name
                    final_cmd = f"ln -sfn '{source_path}' '{destination_path}'"
                    proc = subprocess.run(
                        final_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, cwd=BASE_DIR, encoding="utf-8", errors="replace",
                    )
                    log_append_output(f"Link: {final_cmd}", exit_code=proc.returncode, kind="internal")
                except Exception as e:
                    log_append_output(f"Link error: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd.startswith("_internal_list_dir::"):
                try:
                    _, rel = cmd.split("::", 1)
                    p = (BASE_DIR / rel).resolve()
                    ls_cmd = f"ls -p '{p}'"
                    proc = subprocess.run(ls_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace")
                    if proc.returncode == 0:
                        LS_RESULT_FILE.write_text(proc.stdout, encoding="utf-8")
                        log_append_output(f"__LS_DONE__::{rel}", exit_code=0, kind="internal")
                    else:
                        LS_RESULT_FILE.write_text(f"ERROR:\n{proc.stderr}", encoding="utf-8")
                        log_append_output(f"__LS_DONE__::{rel}", exit_code=proc.returncode, kind="internal")
                except Exception as e:
                    log_append_output(f"LS error: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd == "_internal_get_docker_images":
                try:
                    proc = subprocess.run(
                        "docker images --format '{{.Repository}}:{{.Tag}}'",
                        shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, encoding="utf-8", errors="replace"
                    )
                    if proc.returncode == 0:
                        (BASE_DIR / ".docker_images.txt").write_text(proc.stdout, encoding="utf-8")
                        log_append_output("[Watcher] Images list updated.", exit_code=0, kind="internal")
                    else:
                        log_append_output(f"[Watcher] Failed to get images: {proc.stderr}", exit_code=proc.returncode, kind="internal")
                except Exception as e:
                    log_append_output(f"[Watcher] Error getting images: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue
                    
            elif cmd == "_internal_get_docker_containers":
                try:
                    # 全コンテナの名前を取得 (停止中も含む)
                    proc = subprocess.run(
                        "docker ps -a --format '{{.Names}}'",
                        shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, encoding="utf-8", errors="replace"
                    )
                    if proc.returncode == 0:
                        (BASE_DIR / ".docker_containers.txt").write_text(proc.stdout, encoding="utf-8")
                        log_append_output("[Watcher] Container list updated.", exit_code=0, kind="internal")
                    else:
                        log_append_output(f"[Watcher] Failed to get containers: {proc.stderr}", exit_code=proc.returncode, kind="internal")
                except Exception as e:
                    log_append_output(f"[Watcher] Error getting containers: {e}", exit_code=1, kind="internal")
                finally:
                    write_offset(offset); continue

            elif cmd == "_internal_clear_log":
                LOG_FILE.write_text("", encoding="utf-8")
                log_append_output("Log cleared.", exit_code=0, kind="internal")
                update_status_file()
                write_offset(offset); continue

            # ★ 追加: 設定変更時のCWDリセット
            elif cmd == "_internal_reset_cwd":
                global CURRENT_CWD
                CURRENT_CWD = BASE_DIR
                log_append_output("📂 [Reset] CWD reset to session root.", exit_code=0)
                update_status_file()
                write_offset(offset); continue

            elif cmd.startswith("cd"):
                _handle_cd(cmd); write_offset(offset); continue
            elif cmd.strip().startswith("conda activate"):
                _handle_conda_activate(cmd); write_offset(offset); continue
            elif cmd.strip() == "conda deactivate":
                _handle_conda_deactivate(); write_offset(offset); continue

            elif not allowed_to_run(cmd):
                log_append_output(f"Not allowed: {cmd}", exit_code=126)
                write_offset(offset); continue
            else:
                CMD_QUEUE.put(cmd)
                write_offset(offset); continue

        except Exception as e:
            log_append_output(f"Process error: {e}", exit_code=1)
        finally:
            write_offset(offset)


def _start_worker_thread() -> None:
    def _worker_loop() -> None:
        while True:
            cmd = CMD_QUEUE.get()
            try:
                if cmd is None: break
                run_command_local(cmd)
            finally:
                CMD_QUEUE.task_done()

    t = threading.Thread(target=_worker_loop, daemon=True)
    t.start()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", type=str, required=True)
    args = parser.parse_args()

    unique_id = BASE_DIR.parent.name
    print(f"[Watcher] Started: {unique_id} ({args.name})")
    
    config = _get_runner_config()
    if config.get("mode") == "docker_run":
        print(f"[Watcher]  Mode: GUI-Config Docker Run ({config.get('image')})")
    elif DOCKER_CONTAINER_NAME:
        print(f"[Watcher]  Mode: Env Docker Exec ({DOCKER_CONTAINER_NAME})")
    elif DOCKER_IMAGE_NAME:
        print(f"[Watcher]  Mode: Env Docker Run ({DOCKER_IMAGE_NAME})")
    else:
        print(f"[Watcher]  Mode: Host Native")

    ensure_files()
    _start_worker_thread()
    process_new_commands()

    last_heartbeat = 0.0
    loop = 0
    try:
        while True:
            now = time.time()
            if now - last_heartbeat > HEARTBEAT_INTERVAL_SEC:
                update_registration(unique_id, args.name)
                last_heartbeat = now
            
            process_new_commands()
            
            loop += 1
            if loop % 100 == 0: _cleanup_staged_files()
            
            time.sleep(POLL_SEC)
    except KeyboardInterrupt:
        print("\n[Watcher] Stopping...")
    finally:
        unregister(unique_id)


if __name__ == "__main__":
    main()
