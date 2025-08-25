import os
import sys
import json
import getpass
import socket
import subprocess
from pathlib import Path
import tkinter as tk
from tkinter import ttk, messagebox

from config import (
    REMOTE_SESSIONS_PATH, EOC_MARKER_PREFIX, MAX_TERMINAL_LINES,
    UI_COLORS, COMBO_BG, REMOTE_SERVER
)

class TerminalFrame(ttk.Frame):
    def __init__(self, parent, app):
        super().__init__(parent)
        self.parent = parent # PanedWindow
        self.app = app # Main IntegratedGUI instance

        # 状態変数を初期化
        self.input_locked = False
        self.auto_scroll = tk.BooleanVar(value=True)
        self.terminal_mode = tk.StringVar(value="Remote")
        self.local_cwd = Path.cwd()

        self._create_widgets()

    def _create_widgets(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        # ツールバー
        toolbar = ttk.Frame(self, style="Dark.TFrame", padding=(8, 6))
        toolbar.grid(row=0, column=0, sticky="ew")

        ttk.Label(toolbar, text="Mode:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        mode_combo = ttk.Combobox(toolbar, textvariable=self.terminal_mode, values=["Remote", "Local"], state="readonly", width=8, style="Dark.TCombobox")
        mode_combo.pack(side=tk.LEFT)
        mode_combo.bind("<<ComboboxSelected>>", self._on_terminal_mode_changed)

        ttk.Button(toolbar, text="Clear view", command=self.clear_output, style="Dark.TButton").pack(side=tk.LEFT, padx=(10, 0))
        ttk.Button(toolbar, text="Clear log file", command=self.clear_log_file, style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))
        ttk.Checkbutton(toolbar, text="Auto scroll", variable=self.auto_scroll, style="Dark.TCheckbutton").pack(side=tk.LEFT, padx=(12, 0))
        
        self.app.sync_indicator_label = ttk.Label(toolbar, text="", style="Dark.TLabel", font=self.app.mono_font)
        self.app.sync_indicator_label.pack(side=tk.RIGHT, padx=(10, 0))
        
        # ターミナルビュー
        text_frame = ttk.Frame(self)
        text_frame.grid(row=1, column=0, sticky="nsew")

        self.view = tk.Text(
            text_frame, wrap="word", bg=UI_COLORS["TEXT_BG"], fg=UI_COLORS["TEXT_FG"],
            insertbackground=UI_COLORS["INSERT_FG"],
            selectbackground=UI_COLORS["SELECT_BG"], selectforeground=UI_COLORS["SELECT_FG"],
            font=self.app.mono_font,
            highlightthickness=4, highlightbackground=COMBO_BG, highlightcolor="#3B729F",
            relief="flat", borderwidth=0
        )
        self.view.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.view.tag_configure("prompt_user_host", foreground="#67E02D")

        yscroll = ttk.Scrollbar(text_frame, orient="vertical", command=self.view.yview)
        self.view.configure(yscrollcommand=yscroll.set)
        yscroll.pack(side=tk.RIGHT, fill=tk.Y)

        self.view.mark_set("input_start", tk.INSERT)
        self.view.mark_gravity("input_start", tk.LEFT)

        # --- ▼▼▼ イベントバインド処理を追加 ▼▼▼ ---
        self.view.bind("<Return>", self._on_terminal_return)
        self.view.bind("<KeyPress>", self._on_terminal_keypress)
        self.view.bind("<Button-3><ButtonRelease-3>", self.app._show_context_menu)
        self.view.bind("<Button-2><ButtonRelease-2>", self.app._show_context_menu)
        
        # OS固有のコピーショートカットをバインド
        if sys.platform == "darwin":
            self.view.bind("<Command-c>", self.app._copy_selection)
        else:
            self.view.bind("<Control-c>", self.app._copy_selection)
        # --- ▲▲▲ ここまで追加 ▲▲▲ ---

    def reset_to_disconnected_state(self):
        """ターミナルを未接続状態の表示にリセットする"""
        self.view.config(state=tk.NORMAL)
        self.view.delete("1.0", tk.END)
        self.view.insert("1.0", "[GUI] No active session selected.")
        self.view.config(state=tk.DISABLED)
        self.input_locked = False

    # ... (以降のメソッドは変更なし) ...
    def append_log(self, text):
        self.view.config(state=tk.NORMAL)
        try:
            current_lines = int(self.view.index('end-1c').split('.')[0])
            if current_lines > MAX_TERMINAL_LINES:
                lines_to_delete = current_lines - MAX_TERMINAL_LINES
                self.view.delete('1.0', f'{lines_to_delete + 1}.0')
        except Exception: pass
        if text: self.view.insert(tk.END, text.rstrip() + '\n')
        self.view.mark_set(tk.INSERT, tk.END)
        if self.auto_scroll.get(): self.view.see(tk.END)
    
    def clear_output(self):
        self.view.config(state=tk.NORMAL); self.view.delete("1.0", tk.END)
        if self.terminal_mode.get() == "Remote": self._show_remote_prompt()
        else: self._show_local_prompt()

    def clear_log_file(self):
        if self.terminal_mode.get() == "Local":
            messagebox.showinfo("Info", "This function is only available in Remote mode."); return
        if not self.app.command_file: return
        try:
            self.input_locked = True
            self.view.config(state=tk.NORMAL); self.view.delete("1.0", tk.END)
            self.view.insert(tk.END, "[GUI] Sending clear log command... Input is locked until confirmation.\n")
            
            self.app.request_send_command("_internal_clear_log")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to send clear log command:\n{e}"); self.input_locked = False

    def process_and_append_log(self, text: str):
        marker_found, display_text = False, text
        if EOC_MARKER_PREFIX in text:
            marker_found, display_text = True, text.split(EOC_MARKER_PREFIX, 1)[0]
        if display_text: self.append_log(display_text)
        if self.input_locked and marker_found:
            self.input_locked = False
            self.append_log("[GUI] Log cleared successfully. Input unlocked.\n"); self.view.focus_set()
        return marker_found

    def _on_terminal_return(self, event=None):
        if self.input_locked: return "break"
        mode, current_line = self.terminal_mode.get(), self.view.get("input_start", "end-1c")
        cmd = current_line.strip()
        self.view.insert(tk.END, "\n")
        if cmd: self.app.history.append(cmd); self.app.history_idx = len(self.app.history)
    
        if mode == "Remote":
            if cmd:
                self.app.request_send_command(cmd)
        else: # Local mode
            if cmd: self._execute_local_command(cmd)
            self._show_local_prompt()
            
        return "break"
    
    def _on_terminal_keypress(self, event):
        if self.input_locked: return "break"
        if self.view.compare(tk.INSERT, "<", "input_start"):
            if event.keysym not in ("Left", "Right", "Home", "End", "Up", "Down"):
                return "break"
        
        if event.keysym in ("Up", "Down"):
            if self.app.history:
                if event.keysym == "Up":
                    self.app.history_idx = max(0, self.app.history_idx - 1)
                else: # Down
                    self.app.history_idx = min(len(self.app.history), self.app.history_idx + 1)
                
                self.view.delete("input_start", tk.END)
                if self.app.history_idx < len(self.app.history):
                    self.view.insert(tk.END, self.app.history[self.app.history_idx])
            return "break"

    def _execute_local_command(self, cmdline: str):
        if cmdline.strip().startswith("cd"):
            try:
                parts = cmdline.strip().split(maxsplit=1)
                if len(parts) == 1 or parts[1] in ("~", "~/", ""): target_dir = Path.home()
                else:
                    target_dir_str = os.path.expanduser(parts[1])
                    p = Path(target_dir_str)
                    if not p.is_absolute(): p = (self.local_cwd / p).resolve()
                    target_dir = p
                if target_dir.is_dir(): os.chdir(target_dir); self.local_cwd = Path.cwd()
                else: self.append_log(f"cd: no such file or directory: {parts[1] if len(parts) > 1 else ''}")
            except Exception as e: self.append_log(f"Error during cd: {e}")
            return
        try:
            proc = subprocess.run(cmdline, shell=True, capture_output=True, text=True, cwd=self.local_cwd, encoding='utf-8', errors='replace', timeout=60)
            combined_output = (proc.stdout or "") + (proc.stderr or "")
            self.append_log(combined_output.strip())
        except subprocess.TimeoutExpired: self.append_log("\n[GUI] Command timed out after 60 seconds.")
        except Exception as e: self.append_log(f"\n[GUI] Error executing local command: {e}")

    def _on_terminal_mode_changed(self, event=None):
        mode = self.terminal_mode.get()
        self.view.config(state=tk.NORMAL)
        self.view.delete("1.0", tk.END)
    
        if mode == "Local":
            self.append_log("[--- Switched to Local Terminal Mode ---]\n")
            self._show_local_prompt()
        else:
            self.append_log("[--- Switched to Remote Terminal Mode ---]\n")
            if self.app.current_watcher_id:
                self._show_remote_prompt()
            else:
                self.append_log("Please select a remote watcher and session.")

    def _show_local_prompt(self):
        if self.input_locked: return
        self.view.insert(tk.END, "\n")
        try:
            conda_env = os.environ.get("CONDA_DEFAULT_ENV"); conda_prefix = f"({conda_env}) " if conda_env else ""
            user, host, cwd = getpass.getuser(), socket.gethostname().split('.')[0], str(self.local_cwd)
            home_dir = str(Path.home())
            if cwd.startswith(home_dir):
                cwd = "~" + cwd[len(home_dir):]
            self.view.insert(tk.END, f"[Local] {conda_prefix}")
            tag_start = self.view.index("end-1c")
            self.view.insert(tk.END, f"{user}@{host}")
            tag_end = self.view.index("end-1c")
            self.view.tag_add("prompt_user_host", tag_start, tag_end)
            self.view.insert(tk.END, f":{cwd}$ ")
        except Exception: self.view.insert(tk.END, "$ ")
        self.view.mark_set("input_start", self.view.index("end-1c"))
        self.view.mark_set(tk.INSERT, "end-1c"); self.view.see(tk.INSERT)
    
    def _show_remote_prompt(self):
        if not self.app.current_session_name or not self.app.status_file:
            if self.view.get("end-2c", "end-1c") != '\n':
                 self.view.insert(tk.END, "\n")
            self.view.insert(tk.END, "[GUI] Please select a watcher and session.$ ")
            self.view.mark_set("input_start", self.view.index("end-1c"))
            return
        if self.input_locked:
            return
    
        if self.view.get("end-2c", "end-1c") != '\n':
            self.view.insert(tk.END, "\n")
    
        try:
            if not (self.app.current_watcher_id and self.app.current_session_name):
                raise RuntimeError("No remote session selected")
    
            remote_status = (
                f"{REMOTE_SESSIONS_PATH}/"
                f"{self.app.current_watcher_id}/"
                f"{self.app.current_session_name}/.watcher_status.json"
            )
    
            local_dir = str(self.app.status_file.parent)
            
            self.app._run_sync_command(
                ["rsync", "-az", f"{REMOTE_SERVER}:{remote_status}", f"{local_dir}/"],
                capture_output=True, timeout=5
            )
    
            status = json.loads(self.app.status_file.read_text(encoding="utf-8"))
            
            # +++ 変更点: conda_env を読み込み、プロンプトの接頭辞を作成 +++
            conda_env = status.get("conda_env")
            conda_prefix = f"({conda_env}) " if conda_env else ""
            
            user = status.get("user", "u")
            host = status.get("host", "h")
            cwd  = status.get("cwd", "~")
            
            self.app.remote_cwd = cwd
    
            # homeディレクトリのパスを短縮表示する処理
            # 注意: この処理はローカルのhomeパスに依存するため、リモートとユーザが違うと正しく機能しない可能性があります
            try:
                # 簡易的に、'~'で始まるか、フルパスかを判定
                if not cwd.startswith('/'):
                    pass # 相対パスなどはそのまま表示
                elif cwd.startswith(f"/home/{user}"):
                    cwd = "~" + cwd[len(f"/home/{user}"):]
                elif len(cwd) > 20: # 長すぎるパスは末尾を省略
                    cwd = "..." + cwd[-17:]
            except Exception:
                pass

            # +++ 変更点: プロンプトの先頭に conda_prefix を追加 +++
            self.view.insert(tk.END, f"[Remote] {conda_prefix}")
            
            tag_start = self.view.index("end-1c")
            self.view.insert(tk.END, f"{user}@{host}")
            tag_end = self.view.index("end-1c")
            self.view.tag_add("prompt_user_host", tag_start, tag_end)
            self.view.insert(tk.END, f":{cwd}$ ")
    
        except Exception as e:
            # エラーが発生した場合もプロンプトは表示する
            print(f"Error updating remote prompt: {e}")
            self.view.insert(tk.END, "[Remote] Error$ ")
    
        self.view.mark_set("input_start", self.view.index("end-1c"))
        self.view.mark_set(tk.INSERT, "end-1c")
        self.view.see(tk.INSERT)