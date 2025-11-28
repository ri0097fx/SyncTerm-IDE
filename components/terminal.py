# components/terminal.py
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
        self.parent = parent 
        self.app = app 
        
        self.last_eoc_internal = False
        self.input_locked = False
        self.auto_scroll = tk.BooleanVar(value=True)
        self.terminal_mode = tk.StringVar(value="Remote")
        self.local_cwd = Path.cwd()

        self._create_widgets()

    def _create_widgets(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        # Toolbar
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
        
        # Terminal View
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
        
        # ★ タグ定義: Host用(緑)と Docker用(水色)
        self.view.tag_configure("prompt_user_host", foreground="#67E02D") # Green
        self.view.tag_configure("prompt_docker", foreground="#33CCFF")    # Cyan

        yscroll = ttk.Scrollbar(text_frame, orient="vertical", command=self.view.yview)
        self.view.configure(yscrollcommand=yscroll.set)
        yscroll.pack(side=tk.RIGHT, fill=tk.Y)

        self.view.mark_set("input_start", tk.INSERT)
        self.view.mark_gravity("input_start", tk.LEFT)

        self.view.bind("<Return>", self._on_terminal_return)
        self.view.bind("<KeyPress>", self._on_terminal_keypress)
        self.view.bind("<Button-3><ButtonRelease-3>", self.app._show_context_menu)
        self.view.bind("<Button-2><ButtonRelease-2>", self.app._show_context_menu)
        
        if sys.platform == "darwin":
            self.view.bind("<Command-c>", self.app._copy_selection)
        else:
            self.view.bind("<Control-c>", self.app._copy_selection)

    def reset_to_disconnected_state(self):
        self.view.config(state=tk.NORMAL)
        self.view.delete("1.0", tk.END)
        self.view.insert("1.0", "[GUI] No active session selected.")
        self.view.config(state=tk.DISABLED)
        self.input_locked = False

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
        marker_found = False
        is_internal = False
        display_text = text
    
        if EOC_MARKER_PREFIX in text:
            marker_found = True
            before, after = text.split(EOC_MARKER_PREFIX, 1)
            display_text = before
            if after.strip().startswith("INTERNAL:"):
                is_internal = True
    
        if marker_found:
            self.last_eoc_internal = is_internal
    
        if display_text:
            self.append_log(display_text)
    
        if self.input_locked and marker_found:
            self.input_locked = False
            self.append_log("[GUI] Log cleared successfully. Input unlocked.\n")
            self.view.focus_set()
    
        return marker_found
    
    def _on_terminal_return(self, event=None):
        if self.input_locked: return "break"
        mode, current_line = self.terminal_mode.get(), self.view.get("input_start", "end-1c")
        cmd = current_line.strip()
        self.view.insert(tk.END, "\n")
        
        # History Logic
        if cmd:
            if hasattr(self.app, 'history'):
                self.app.history.append(cmd)
                self.app.history_idx = len(self.app.history)
    
        if mode == "Remote":
            if cmd: self.app.request_send_command(cmd)
        else:
            if cmd: self._execute_local_command(cmd)
            self._show_local_prompt()
            
        return "break"
    
    def _on_terminal_keypress(self, event):
        if self.input_locked: return "break"
        if self.view.compare(tk.INSERT, "<", "input_start"):
            if event.keysym not in ("Left", "Right", "Home", "End", "Up", "Down"):
                return "break"
        
        if event.keysym in ("Up", "Down"):
            if hasattr(self.app, 'history') and self.app.history:
                if event.keysym == "Up":
                    self.app.history_idx = max(0, self.app.history_idx - 1)
                else: 
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
                else: self.append_log(f"cd: no such file: {parts[1] if len(parts) > 1 else ''}")
            except Exception as e: self.append_log(f"Error during cd: {e}")
            return
        try:
            proc = subprocess.run(cmdline, shell=True, capture_output=True, text=True, cwd=self.local_cwd, encoding='utf-8', errors='replace', timeout=60)
            combined_output = (proc.stdout or "") + (proc.stderr or "")
            self.append_log(combined_output.strip())
        except subprocess.TimeoutExpired: self.append_log("\n[GUI] Command timed out.")
        except Exception as e: self.append_log(f"\n[GUI] Error: {e}")

    def _on_terminal_mode_changed(self, event=None):
        mode = self.terminal_mode.get()
        self.view.config(state=tk.NORMAL)
        self.view.delete("1.0", tk.END)
    
        if mode == "Local":
            self.append_log("[--- Local Terminal ---]\n")
            self._show_local_prompt()
        else:
            self.append_log("[--- Remote Terminal ---]\n")
            if self.app.current_watcher_id: self._show_remote_prompt()
            else: self.append_log("Select a watcher and session.")

    def _show_local_prompt(self):
        if self.input_locked: return
        self.view.insert(tk.END, "\n")
        try:
            user, host, cwd = getpass.getuser(), socket.gethostname().split('.')[0], str(self.local_cwd)
            home_dir = str(Path.home())
            if cwd.startswith(home_dir): cwd = "~" + cwd[len(home_dir):]
            
            self.view.insert(tk.END, "[Local] ")
            tag_start = self.view.index("end-1c")
            self.view.insert(tk.END, f"{user}@{host}")
            self.view.tag_add("prompt_user_host", tag_start, self.view.index("end-1c"))
            self.view.insert(tk.END, f":{cwd}$ ")
        except: self.view.insert(tk.END, "$ ")
        self.view.mark_set("input_start", self.view.index("end-1c"))
        self.view.mark_set(tk.INSERT, "end-1c"); self.view.see(tk.INSERT)
    
    def _show_remote_prompt(self):
        if not self.app.current_session_name or not self.app.status_file:
            try:
                if self.view.index("end-1c") != "1.0" and self.view.get("end-2c", "end-1c") != "\n":
                    self.view.insert(tk.END, "\n")
            except: pass
            self.view.insert(tk.END, "[GUI] Select a watcher.$ ")
            self.view.mark_set("input_start", self.view.index("end-1c"))
            return
        
        if self.input_locked: return

        try:
            if self.view.index("end-1c") != "1.0" and self.view.get("end-2c", "end-1c") != "\n":
                self.view.insert(tk.END, "\n")
        except: pass
    
        # 1. ステータスファイルをプル
        status_data = {}
        try:
            self.app._sync_pull_file(
                f"{REMOTE_SESSIONS_PATH}/{self.app.current_watcher_id}/{self.app.current_session_name}/.watcher_status.json",
                str(self.app.status_file), timeout=10
            )
            if self.app.status_file.exists():
                txt = self.app.status_file.read_text(encoding="utf-8", errors="replace")
                if txt.strip(): status_data = json.loads(txt)
        except: pass
        
        # 2. ローカル設定ファイル(.runner_config.json)を優先確認
        is_docker = False
        docker_label = ""
        runner_config_path = self.app.current_tree_root / ".runner_config.json"
        if runner_config_path.exists():
            try:
                conf = json.loads(runner_config_path.read_text("utf-8"))
                mode = conf.get("mode")
                if mode in ("docker_run", "docker_exec"):
                    is_docker = True
                    target = conf.get("container_name") or conf.get("image", "Container")
                    docker_label = target
            except: pass
        
        # ローカルで不明ならリモートステータス確認
        if not is_docker:
            remote_mode = status_data.get("docker_mode", "")
            if "Docker" in remote_mode:
                is_docker = True
                # "🐳 Exec: name" みたいな文字列から名前だけ抽出
                parts = remote_mode.split(":", 1)
                docker_label = parts[1].strip() if len(parts) > 1 else "Container"

        # --- Prompt Construction ---
        cwd = status_data.get("cwd") or "~"
        self.app.remote_cwd = status_data.get("full_cwd") or cwd 

        if is_docker:
            # Docker Mode (Cyan)
            prompt_prefix = "[🐳 Docker] "
            highlight_text = docker_label
            tag = "prompt_docker"
            path_part = f" in {cwd}" 
        else:
            # Host Mode (Green)
            user = status_data.get("user") or "u"
            host = status_data.get("host") or "h"
            env = status_data.get("conda_env")
            prefix = f"({env}) " if env and env != "base" else "[Remote] "
            
            prompt_prefix = prefix
            highlight_text = f"{user}@{host}"
            tag = "prompt_user_host"
            path_part = f":{cwd}"

        # --- 描画 (修正部分) ---
        
        # 1. Prefix ([Remote] or [🐳 Docker])
        prefix_start = self.view.index("end-1c")
        self.view.insert(tk.END, prompt_prefix)
        
        # ★ DockerモードならPrefixも水色にする
        if is_docker:
            self.view.tag_add(tag, prefix_start, "end-1c")
        
        # 2. Main Identity (user@host or container-name) -> 色付き
        hl_start = self.view.index("end-1c")
        self.view.insert(tk.END, highlight_text) 
        self.view.tag_add(tag, hl_start, "end-1c")
        
        # 3. Path & Suffix -> 白 (デフォルト)
        self.view.insert(tk.END, path_part)
        self.view.insert(tk.END, "$ ")
    
        self.view.mark_set("input_start", self.view.index("end-1c"))
        self.view.mark_set(tk.INSERT, "end-1c")
        self.view.see(tk.INSERT)