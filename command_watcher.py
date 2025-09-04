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
from typing import List, Tuple

# ===== Path Settings (shared dir via env) =====
# COMMANDS_DIRは起動元のwatcher_manager.shによって設定される
BASE_DIR = Path(os.environ.get("COMMANDS_DIR", Path(__file__).resolve().parent)).resolve()
COMMAND_FILE = (BASE_DIR / "commands.txt").resolve()
LOG_FILE     = (BASE_DIR / "commands.log").resolve()
OFFSET_FILE  = (BASE_DIR / ".commands.offset").resolve()
STATUS_FILE  = (BASE_DIR / ".watcher_status.json").resolve()
LS_RESULT_FILE = (BASE_DIR / ".ls_result.txt").resolve() # New file for ls results

# ===== Registration Settings =====
REMOTE_SESSIONS_ROOT = os.environ.get("REMOTE_SESSIONS_ROOT")
REGISTRY_DIR_NAME = os.environ.get("REGISTRY_DIR_NAME", "_registry")

if not REMOTE_SESSIONS_ROOT:
    print(f"[Watcher] WARNING: REMOTE_SESSIONS_ROOT is not set. Using fallback path discovery.")
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
# ==========================

ANSI_ESCAPE = re.compile(r'\x1B\[[0-?]*[ -/]*[@-~]')

# --- Set CWD to BASE_DIR on startup ---
try:
    os.chdir(BASE_DIR)
except FileNotFoundError:
    print(f"[Watcher] ERROR: Session directory not found, cannot chdir to {BASE_DIR}")
    exit(1)
CURRENT_CWD = BASE_DIR
# ---

# +++ 修正1: Conda環境の初期値を "base" に設定 +++
ACTIVE_CONDA_ENV: str | None = "base"

def _validate_safe_relpath(rel: str) -> None:
    p = Path(rel)
    if p.is_absolute() or any(part == ".." for part in p.parts):
        raise ValueError(f"unsafe relpath: {rel!r}")

def update_registration(unique_id: str, display_name: str):
    try:
        REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
        registration_file = REGISTRY_DIR / unique_id
        reg_data = {"display_name": display_name, "last_heartbeat": time.time()}
        registration_file.write_text(json.dumps(reg_data, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[Watcher] Error updating registration: {e}")

def unregister(unique_id: str):
    try:
        registration_file = REGISTRY_DIR / unique_id
        if registration_file.exists():
            registration_file.unlink()
            print(f"\n[Watcher] Unregistered '{unique_id}'.")
    except Exception as e:
        print(f"[Watcher] Error unregistering: {e}")

def _host_short() -> str:
    return socket.gethostname().split('.')[0]

def update_status_file():
    status_data = {
        "user": getpass.getuser(),
        "host": _host_short(),
        "cwd": str(CURRENT_CWD),
        "conda_env": ACTIVE_CONDA_ENV
    }
    try:
        STATUS_FILE.write_text(json.dumps(status_data, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[Watcher] Error updating status file: {e}")

def ensure_files():
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

def log_append_output(out: str, exit_code: int | None = None):
    text = out
    if not KEEP_ANSI:
        text = ANSI_ESCAPE.sub('', text)
    if MAX_OUTPUT_CHARS and len(text) > MAX_OUTPUT_CHARS:
        text = text[:MAX_OUTPUT_CHARS] + "\n...[truncated]"
    
    if exit_code is not None:
        text += f"\n{EOC_MARKER_PREFIX}{exit_code}\n"
        
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(text.rstrip() + "\n")

def allowed_to_run(cmdline: str) -> bool:
    if not ALLOWED_CMDS: return True
    try:
        return shlex.split(cmdline, posix=True)[0] in ALLOWED_CMDS
    except Exception:
        return False

def run_command_local(cmdline: str):
    final_cmd = cmdline
    # base環境の場合は conda run を使わない (システムのPATHが優先されるように)
    if ACTIVE_CONDA_ENV and ACTIVE_CONDA_ENV != "base":
        final_cmd = f"conda run -n {ACTIVE_CONDA_ENV} {cmdline}"

    proc = subprocess.run(
        final_cmd, shell=True, capture_output=True, text=True,
        cwd=CURRENT_CWD, encoding='utf-8', errors='replace'
    )
    combined_output = (proc.stdout or "") + (proc.stderr or "")
    log_append_output(combined_output, exit_code=proc.returncode)
    update_status_file()

def _handle_cd(cmd: str):
    global CURRENT_CWD
    parts = cmd.strip().split(maxsplit=1)
    if len(parts) == 1 or parts[1] in ("~", "~/", ""):
        target_dir = Path.home()
    else:
        target_str = os.path.expanduser(parts[1])
        p = Path(target_str)
        if not p.is_absolute():
            p = (CURRENT_CWD / p).resolve()
        target_dir = p
    
    if target_dir.is_dir():
        os.chdir(target_dir)
        CURRENT_CWD = target_dir
        log_append_output("", exit_code=0)
    else:
        log_append_output(f"cd: no such file or directory: {parts[1] if len(parts)>1 else ''}", exit_code=1)
    
    update_status_file()

def _handle_conda_activate(cmd: str):
    global ACTIVE_CONDA_ENV
    try:
        parts = shlex.split(cmd)
        # parts は ["conda", "activate", "env_name"] のようになる
        if len(parts) > 2:
            env_name = parts[2]  # 3番目の要素が環境名
            ACTIVE_CONDA_ENV = env_name
            log_append_output(f"[Watcher] Switched to conda environment: {env_name}", exit_code=0)
        else:
            log_append_output("conda activate: Please specify an environment name.", exit_code=1)
    except Exception as e:
        log_append_output(f"conda activate: Failed to parse command. {e}", exit_code=1)
    update_status_file()

def _handle_conda_deactivate():
    global ACTIVE_CONDA_ENV
    if ACTIVE_CONDA_ENV and ACTIVE_CONDA_ENV != "base":
        log_append_output(f"[Watcher] Deactivated conda environment: {ACTIVE_CONDA_ENV}, returning to base.", exit_code=0)
        ACTIVE_CONDA_ENV = "base"
    else:
        log_append_output("[Watcher] Already in base conda environment.", exit_code=0)
    update_status_file()

def process_new_commands():
    offset = read_offset()
    lines, total = read_new_lines(offset)
    if not lines:
        return
        
    for line in lines:
        cmd = line.strip()
        offset += 1
        try:
            if not cmd or cmd.startswith("#"):
                continue

            # --- 全てのコマンド処理を一つの if/elif/else チェーンに統一 ---

            if cmd.startswith("_internal_delete_path::"):
                try:
                    _, rel_path_str = cmd.split("::", 1)
                    target_path = (BASE_DIR / rel_path_str).resolve()

                    if not str(target_path).startswith(str(BASE_DIR.resolve())):
                        log_append_output(f"[Watcher] ERROR: Invalid path. Deletion outside session directory is not allowed: {rel_path_str}", exit_code=1)
                    elif target_path.exists() or target_path.is_symlink():
                        if target_path.is_dir() and not target_path.is_symlink():
                             shutil.rmtree(target_path)
                        else:
                            target_path.unlink()
                        log_append_output(f"[Watcher] Deleted: {rel_path_str}", exit_code=0)
                    else:
                        log_append_output(f"[Watcher] INFO: Path not found, nothing to delete: {rel_path_str}", exit_code=0)
                except Exception as e:
                    log_append_output(f"[Watcher] ERROR: Failed to delete path '{rel_path_str}'. Reason: {e}", exit_code=1)
                finally:
                    write_offset(offset)
                    continue

            elif cmd.startswith("_internal_stage_file_for_download::"):
                try:
                    _, rel_path_str = cmd.split("::", 1)
                    source_file_path = (BASE_DIR / rel_path_str).resolve()
                    if not source_file_path.is_file():
                       raise ValueError(f"Resolved path is not a file: {source_file_path}")

                    staging_file_path = BASE_DIR / ".staged_for_download"
                    shutil.copy(source_file_path, staging_file_path)
                    log_append_output(f"[Watcher] Staged file '{rel_path_str}' for download.", exit_code=0)
                except Exception as e:
                    log_append_output(f"[Watcher] ERROR: Failed to stage file for download. Reason: {e}", exit_code=1)
                finally:
                    write_offset(offset)
                    continue
                
            elif cmd.startswith("_internal_move_staged_file::"):
                try:
                    # 受理するのは新形式のみ:
                    #   _internal_move_staged_file::<token>::<rel_dest_path>
                    payload = cmd.split("::", 1)[1]
                    if "::" not in payload:
                        raise ValueError("invalid syntax (missing token or relpath)")
            
                    token, rel_dest_path_str = payload.split("::", 1)
                    if not token or not rel_dest_path_str:
                        raise ValueError("invalid syntax (empty token or relpath)")
            
                    # パス検証（ベストプラクティス）
                    try:
                        _validate_safe_relpath(rel_dest_path_str)  # 実装していない場合は簡易チェックに置換してください
                    except NameError:
                        # 簡易ガード（_validate_safe_relpath 未実装時）
                        p = Path(rel_dest_path_str)
                        if p.is_absolute() or any(part == ".." for part in p.parts):
                            raise ValueError(f"unsafe relpath: {rel_dest_path_str!r}")
            
                    staged_file = BASE_DIR / ".staged_uploads" / token
                    if not staged_file.exists():
                        raise FileNotFoundError(f"staged file not found: {staged_file}")
            
                    # 最終書き込み先（symlink 配下であれば実体に反映）
                    final_dest_path = (BASE_DIR / rel_dest_path_str).resolve()
                    final_dest_path.parent.mkdir(parents=True, exist_ok=True)
            
                    # 原子的に置換
                    tmp_path = final_dest_path.with_suffix(final_dest_path.suffix + ".tmp~")
                    shutil.copy2(staged_file, tmp_path)
                    os.replace(tmp_path, final_dest_path)
            
                    # 後片付け（token 単位で削除）
                    try:
                        staged_file.unlink()
                    except Exception:
                        pass
            
                    log_append_output(f"[Watcher] Moved staged file to '{rel_dest_path_str}'.", exit_code=0)
            
                except Exception as e:
                    # 旧形式はここで弾かれます（例: invalid syntax）
                    log_append_output(f"[Watcher] ERROR: Failed to move staged file. Reason: {e}", exit_code=1)
                finally:
                    write_offset(offset)
                    continue

            elif cmd.startswith("_internal_create_link::"):
                try:
                    _, source_path, link_name = cmd.split('::', 2)
                    destination_path = BASE_DIR / link_name
                    final_cmd = f"ln -sfn '{source_path}' '{destination_path}'"
                    proc = subprocess.run(final_cmd, shell=True, capture_output=True, text=True, cwd=BASE_DIR, encoding='utf-8', errors='replace')
                    combined_output = (f"[Watcher] Executed: {final_cmd}\n" + (proc.stdout or "") + (proc.stderr or ""))
                    log_append_output(combined_output, exit_code=proc.returncode)
                except Exception as e:
                    log_append_output(f"[Watcher] Failed to process _internal_create_link: {e}", exit_code=1)
                finally:
                    write_offset(offset)
                    continue

            elif cmd.startswith("_internal_list_dir::"):
                try:
                    _, target_path_str = cmd.split('::', 1)
                    path_to_list = (BASE_DIR / target_path_str).resolve()
                    ls_cmd = f"ls -p '{path_to_list}'"
                    proc = subprocess.run(ls_cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
                    
                    if proc.returncode == 0:
                        LS_RESULT_FILE.write_text(proc.stdout, encoding="utf-8")
                        log_append_output(f"__LS_DONE__::{target_path_str}", exit_code=0)
                    else:
                        LS_RESULT_FILE.write_text(f"ERROR:\n{proc.stderr}", encoding="utf-8")
                        log_append_output(f"__LS_DONE__::{target_path_str}", exit_code=proc.returncode)
                except Exception as e:
                    log_append_output(f"[Watcher] Failed to process _internal_list_dir: {e}", exit_code=1)
                finally:
                    write_offset(offset)
                    continue
            
            elif cmd == "_internal_clear_log":
                LOG_FILE.write_text("", encoding="utf-8")
                log_append_output("[Watcher] Log file cleared.", exit_code=0)
                update_status_file()
                write_offset(offset)
                continue
            
            elif not allowed_to_run(cmd):
                log_append_output(f"[Watcher] Command not allowed: {cmd}", exit_code=126)
                continue
                
            elif cmd.startswith("cd"):
                _handle_cd(cmd)

            elif cmd.strip().startswith("conda activate"):
                _handle_conda_activate(cmd)
            
            elif cmd.strip() == "conda deactivate":
                _handle_conda_deactivate()
            else:
                run_command_local(cmd)
                
        except Exception as e:
            log_append_output(f"[ERROR] Failed to process command '{cmd}': {e}", exit_code=1)
        finally:
            write_offset(offset)

def main():
    parser = argparse.ArgumentParser(description="Command watcher with registration.")
    parser.add_argument("--name", type=str, required=True, help="Display name for this watcher to register.")
    args = parser.parse_args()

    unique_id = BASE_DIR.parent.name
    
    print(f"[Watcher] Starting up...")
    print(f"[Watcher]  BASE_DIR     = {BASE_DIR}")
    print(f"[Watcher]  UNIQUE_ID    = {unique_id}")
    print(f"[Watcher]  DISPLAY_NAME = {args.name}")
    
    ensure_files()
    process_new_commands()

    last_heartbeat_time = 0
    
    try:
        while True:
            now = time.time()
            if now - last_heartbeat_time > HEARTBEAT_INTERVAL_SEC:
                update_registration(unique_id, args.name)
                last_heartbeat_time = now
            process_new_commands()
            time.sleep(POLL_SEC)
    except KeyboardInterrupt:
        print("\n[Watcher] Stopping...")
    finally:
        unregister(unique_id)

if __name__ == "__main__":
    main()