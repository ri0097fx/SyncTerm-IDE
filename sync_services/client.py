# sync_services/client.py
import threading
import tkinter as tk
from config import REMOTE_SESSIONS_PATH, LOG_FETCH_INTERVAL_MS, EOC_MARKER_PREFIX

class WatcherClient:
    def __init__(self, app, sync_manager):
        self.app = app
        self.sync = sync_manager
        self.log_fetch_timer = None
        self.log_sync_running = False
        self.log_pos = 0
        
    def reset(self):
        if self.log_fetch_timer:
            self.app.after_cancel(self.log_fetch_timer)
            self.log_fetch_timer = None
        self.log_pos = 0
        self.log_sync_running = False

    def send_command(self, command: str | list[str], lightweight=True):
        if not self.app.command_file: return
        try:
            commands = command if isinstance(command, list) else [command]
            self.app.command_file.parent.mkdir(parents=True, exist_ok=True)
            with self.app.command_file.open("a", encoding="utf-8") as f:
                for cmd in commands:
                    f.write(cmd + "\n")
            
            remote_session_dir = f"{REMOTE_SESSIONS_PATH}/{self.app.current_watcher_id}/{self.app.current_session_name}/"
            self.sync.push_file(
                str(self.app.command_file),
                f"{remote_session_dir}commands.txt",
                timeout=30,
                lightweight=lightweight
            )
        except Exception as e:
            if hasattr(self.app, 'terminal'):
                self.app.terminal.append_log(f"[GUI] Failed to send command: {e}\n")

    def start_log_polling(self):
        self.fetch_log_updates()

    def fetch_log_updates(self):
        if self.log_fetch_timer:
            self.app.after_cancel(self.log_fetch_timer)
            self.log_fetch_timer = None

        if not self.app.current_watcher_id or not self.app.current_session_name:
            self.log_fetch_timer = self.app.after(LOG_FETCH_INTERVAL_MS, self.fetch_log_updates)
            return

        if self.log_sync_running:
            self.log_fetch_timer = self.app.after(LOG_FETCH_INTERVAL_MS, self.fetch_log_updates)
            return

        self.log_sync_running = True
        remote_base = f"{REMOTE_SESSIONS_PATH}/{self.app.current_watcher_id}/{self.app.current_session_name}"

        def worker():
            err = None
            try:
                self.sync.pull_file(f"{remote_base}/commands.log", str(self.app.log_file), timeout=30, lightweight=True)
                try:
                    self.sync.pull_file(f"{remote_base}/.watcher_status.json", str(self.app.status_file), timeout=10, lightweight=True)
                except Exception: pass
            except Exception as e:
                err = e

            def finish():
                self.log_sync_running = False
                self._process_log_updates(err)
                self.log_fetch_timer = self.app.after(LOG_FETCH_INTERVAL_MS, self.fetch_log_updates)

            try:
                self.app.after(0, finish)
            except tk.TclError: pass

        threading.Thread(target=worker, daemon=True).start()

    def _process_log_updates(self, error):
        if error:
            print(f"Log sync failed: {error}")
            return

        prompt_needs_update = False
        try:
            if self.app.log_file.exists():
                new_size = self.app.log_file.stat().st_size
                if new_size < self.log_pos:
                    self.app.terminal.view.config(state=tk.NORMAL)
                    self.app.terminal.view.delete("1.0", tk.END)
                    self.log_pos = 0

                if new_size > self.log_pos:
                    with self.app.log_file.open("r", encoding="utf-8", errors="replace") as f:
                        f.seek(self.log_pos)
                        new_text = f.read()
                        self.log_pos = f.tell()

                    lines_to_process = new_text.splitlines()
                    regular_output = []

                    for line in lines_to_process:
                        if line.startswith("__LS_DONE__::"):
                            if regular_output:
                                self.app.terminal.append_log("\n".join(regular_output))
                                regular_output = []
                            _, rel_path = line.split("::", 1)
                            self.app.handle_ls_done(rel_path)

                        elif EOC_MARKER_PREFIX in line:
                            if regular_output:
                                self.app.terminal.append_log("\n".join(regular_output))
                                regular_output = []
                            marker_found = self.app.terminal.process_and_append_log(line)
                            if marker_found:
                                if self.app.pending_download_info:
                                    prompt_needs_update = True
                                elif not self.app.terminal.last_eoc_internal:
                                    prompt_needs_update = True
                        else:
                            regular_output.append(line)

                    if regular_output:
                        self.app.terminal.append_log("\n".join(regular_output))

        except Exception as e2:
            print(f"Log read failed: {e2}")

        if prompt_needs_update:
            if self.app.pending_download_info:
                self.app.execute_pending_download()
            if not self.app.terminal.last_eoc_internal:
                self.app.terminal._show_remote_prompt()