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
from pathlib import Path
from typing import List, Tuple

# ===== Path Settings (shared dir via env) =====
# COMMANDS_DIRは起動元のwatcher_manager.shによって設定される
BASE_DIR = Path(os.environ.get("COMMANDS_DIR", Path(__file__).resolve().parent)).resolve()
COMMAND_FILE = (BASE_DIR / "commands.txt").resolve()
LOG_FILE     = (BASE_DIR / "commands.log").resolve()
OFFSET_FILE  = (BASE_DIR / ".commands.offset").resolve()
STATUS_FILE  = (BASE_DIR / ".watcher_status.json").resolve()

# ===== Registration Settings =====
# `watcher_manager.sh`から渡される環境変数を使って、堅牢なパス解決を行う
REMOTE_SESSIONS_ROOT = os.environ.get("REMOTE_SESSIONS_ROOT")
# config.iniで定義されたregistry_dir_nameを取得。なければ_registryをデフォルト値とする
REGISTRY_DIR_NAME = os.environ.get("REGISTRY_DIR_NAME", "_registry")

if not REMOTE_SESSIONS_ROOT:
    # 環境変数が設定されていない場合のためのフォールバック（旧来の不安定な方法）
    # 本来はエラー終了が望ましい
    print(f"[Watcher] WARNING: REMOTE_SESSIONS_ROOT is not set. Using fallback path discovery.")
    REGISTRY_DIR = BASE_DIR.parent.parent.parent / REGISTRY_DIR_NAME
else:
    # 環境変数から取得したセッションのルートパス (`.../sessions`) の親ディレクトリを基準に、
    # レジストリディレクトリ (`.../_registry`) のパスを解決する
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
CURRENT_CWD = Path.cwd()

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
    """CWDやユーザー情報、Conda環境などプロンプト表示用の情報を更新する"""
    status_data = {
        "user": getpass.getuser(),
        "host": _host_short(),
        "cwd": str(CURRENT_CWD),
        "conda_env": os.environ.get("CONDA_DEFAULT_ENV") # Conda環境名を追加
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
    proc = subprocess.run(
        cmdline, shell=True, capture_output=True, text=True,
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

            if cmd == "_internal_clear_log":
                LOG_FILE.write_text("", encoding="utf-8")
                log_append_output("[Watcher] Log file cleared.", exit_code=0)
                update_status_file()
                write_offset(offset)
                continue

            if not allowed_to_run(cmd):
                log_append_output(f"[Watcher] Command not allowed: {cmd}", exit_code=126)
                continue
                
            if cmd.startswith("cd"):
                _handle_cd(cmd)
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
    print(f"[Watcher]  BASE_DIR    = {BASE_DIR}")
    print(f"[Watcher]  UNIQUE_ID   = {unique_id}")
    print(f"[Watcher]  DISPLAY_NAME= {args.name}")
    
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