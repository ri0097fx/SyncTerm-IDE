# sync_services/manager.py
import subprocess
import threading
import tkinter as tk
from sync_services.utils import (
    wsl_available as _wsl_available,
    should_use_wsl_rsync as _should_use_wsl_rsync,
    win_to_wsl_path as _win_to_wsl_path,
    unix as _unix,
    IS_WIN,
)
from config import REMOTE_SERVER


class SyncManager:
    def __init__(self, app):
        self.app = app 

    def _show_indicator(self):
        if hasattr(self.app, "sync_indicator_label") and self.app.sync_indicator_label:
            self.app.sync_indicator_label.config(text="Syncing...")
        self.app.update_idletasks()

    def _hide_indicator(self):
        if hasattr(self.app, "sync_indicator_label") and self.app.sync_indicator_label:
            self.app.sync_indicator_label.config(text="")

    def run_sync_command(self, cmd_list, *, lightweight=False, **kwargs):
        if not lightweight:
            self._show_indicator()
        try:
            if IS_WIN:
                if not _wsl_available():
                    raise FileNotFoundError("WSL (wsl.exe) not found.")
                if cmd_list and str(cmd_list[0]).lower() not in ("wsl", "wsl.exe"):
                    cmd_list = ["wsl", "-e"] + list(cmd_list)
            return subprocess.run(cmd_list, **kwargs)
        finally:
            if not lightweight:
                self._hide_indicator()

    def run_sync_command_async(self, cmd_list, *, lightweight=False, on_done=None, **kwargs):
        if not lightweight:
            self._show_indicator()
        
        base_cmd = list(cmd_list)
        def worker():
            local_cmd = base_cmd
            result = None
            error = None
            try:
                if IS_WIN:
                    if not _wsl_available():
                        raise FileNotFoundError("WSL not found.")
                    if local_cmd and str(local_cmd[0]).lower() not in ("wsl", "wsl.exe"):
                        local_cmd = ["wsl", "-e"] + list(local_cmd)
                result = subprocess.run(local_cmd, **kwargs)
            except Exception as e:
                error = e
            
            def finish():
                if not lightweight:
                    self._hide_indicator()
                if on_done:
                    on_done(result, error)
            
            try:
                self.app.after(0, finish)
            except tk.TclError:
                pass

        threading.Thread(target=worker, daemon=True).start()

    def pull_file(self, remote_file: str, local_file: str, timeout=30, lightweight=False):
        rsync_opt = '-rtlDz'
        if _should_use_wsl_rsync():
            dst = _win_to_wsl_path(local_file)
            cmd = ["rsync", rsync_opt, f"{REMOTE_SERVER}:{remote_file}", dst]
        else:
            cmd = ["rsync", rsync_opt, f"{REMOTE_SERVER}:{remote_file}", local_file]
        return self.run_sync_command(cmd, check=True, timeout=timeout, capture_output=True, lightweight=lightweight)

    def push_file(self, local_file: str, remote_file: str, timeout=30, lightweight=False):
        rsync_opt = '-rtlDz'
        if _should_use_wsl_rsync():
            src = _win_to_wsl_path(local_file)
            cmd = ["rsync", rsync_opt, src, f"{REMOTE_SERVER}:{remote_file}"]
        else:
            cmd = ["rsync", rsync_opt, local_file, f"{REMOTE_SERVER}:{remote_file}"]
        return self.run_sync_command(cmd, check=True, timeout=timeout, capture_output=True, lightweight=lightweight)

    def pull_dir(self, remote_dir: str, local_dir: str, delete=False, timeout=60):
        rsync_opt = '-rtlDz'
        remote_dir = _unix(remote_dir.rstrip("/") + "/")
        from pathlib import Path
        local_dir_path = Path(local_dir)
        local_dir_path.mkdir(parents=True, exist_ok=True)
        if _should_use_wsl_rsync():
            dst = _win_to_wsl_path(str(local_dir_path)) + "/"
            args = ["wsl", "-e", "rsync", rsync_opt]
            if delete: args.append("--delete")
            return self.run_sync_command(args + [f"{REMOTE_SERVER}:{remote_dir}", dst], check=True, timeout=timeout)
        else:
            args = ["rsync", rsync_opt]
            if delete: args.append("--delete")
            return self.run_sync_command(args + [f"{REMOTE_SERVER}:{remote_dir}", str(local_dir_path) + "/"], check=True, timeout=timeout)

    def push_dir(self, local_dir: str, remote_dir: str, delete=False, timeout=60):
        rsync_opt = '-rtlDz'
        local_dir = _unix(local_dir.rstrip("/") + "/")
        remote_dir = _unix(remote_dir.rstrip("/") + "/")
        if _should_use_wsl_rsync():
            src = _win_to_wsl_path(local_dir) + "/"
            args = ["wsl", "-e", "rsync", rsync_opt]
            if delete: args.append("--delete")
            return self.run_sync_command(args + [src, f"{REMOTE_SERVER}:{remote_dir}"], check=True, timeout=timeout)
        else:
            args = ["rsync", rsync_opt]
            if delete: args.append("--delete")
            return self.run_sync_command(args + [local_dir, f"{REMOTE_SERVER}:{remote_dir}"], check=True, timeout=timeout)