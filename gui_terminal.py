#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Integrated Terminal & Editor (Spyder-like) with Session Support (Multi-Watcher Edition)
- Final Version with all features and fixes + Search/Highlight/Markers.
- MODIFIED: Embedded search bar, line movement (Alt+Up/Down), selection highlighting, 
            smart indentation, and code completion with popup list.
- MODIFIED: Tabbed editor support for multiple files.
- MODIFIED: Implemented closable tabs with an 'x' button on each tab.
- MODIFIED: Close icon is thicker, moved to the left, and defined via Base64 data.
- MODIFIED: On-demand file editing via symlink expansion in file tree.
- ADDED  : Right-side image preview pane with header ellipsis and fixed close button.
"""
from __future__ import annotations
import os
import sys
import time
import json
import getpass
import re
import subprocess
import socket
from pathlib import Path
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import tkinter.font as tkfont

# --- Optional Pillow for image preview ---
try:
    from PIL import Image, ImageTk
    PIL_AVAILABLE = True
except Exception:
    PIL_AVAILABLE = False

from pygments import lex
from pygments.lexers import guess_lexer_for_filename, get_lexer_by_name
from pygments.token import Token

# --- 外部の設定ファイルをインポート ---
from config import (
    LOCAL_BASE_DIR, LOCAL_SESSIONS_ROOT, LOCAL_REGISTRY_DIR,
    LOCAL_EDITING_CACHE, REMOTE_SERVER, REMOTE_SESSIONS_PATH,
    REMOTE_REGISTRY_PATH, STATE_JSON_PATH, UI_COLORS, HL,
    LOG_FETCH_INTERVAL_MS, EOC_MARKER_PREFIX, INIT_TAIL_LINES,
    MAX_TERMINAL_LINES, REHIGHLIGHT_DELAY_MS, LINE_NUMBER_UPDATE_DELAY_MS,
    WATCHER_HEARTBEAT_TIMEOUT_SEC, COMBO_BG, COMBO_FG,
    COMBO_SEL_BG, COMBO_SEL_FG, SCROLLBAR_THUMB_COLOR, REMOTE_BASE_PATH, INDENT_STRING, INDENT_WIDTH,
)

from components.terminal import TerminalFrame
from components.editor import EditorView 

class IntegratedGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.is_loading = True
        self.title("Integrated Terminal & Editor (Multi-Watcher Control Panel)")
        self.geometry("1400x820")

        # config.pyからインポートしたUI_COLORSとHLを直接使用
        self.UI_COLORS = UI_COLORS
        self.HL = HL
        
        self.BG_COLOR = self.UI_COLORS["BG_COLOR"]; self.PANEL_BG = self.UI_COLORS["PANEL_BG"]
        self.TEXT_BG = self.UI_COLORS["TEXT_BG"]; self.TEXT_FG = self.UI_COLORS["TEXT_FG"]
        self.BORDER_CLR = self.UI_COLORS["BORDER_CLR"]; 
        self.INSERT_FG = self.UI_COLORS["INSERT_FG"]
        self.SELECT_BG = self.UI_COLORS["SELECT_BG"]; self.SELECT_FG = self.UI_COLORS["SELECT_FG"]
        self.configure(bg=self.BG_COLOR)
        style = ttk.Style(self)
        try: style.theme_use("clam")
        except tk.TclError: pass
        style.configure(".", background=self.BG_COLOR, foreground=self.TEXT_FG)
        style.configure("Dark.TFrame", background=self.BG_COLOR)
        style.configure("Dark.TLabel", background=self.BG_COLOR, foreground=self.TEXT_FG)
        style.configure("Dark.TButton", background=self.BG_COLOR, foreground=self.TEXT_FG, bordercolor=self.BORDER_CLR)
        style.map("Dark.TButton", background=[('active', COMBO_BG)])
        # コンパクトボタン（横パディング最小）
        try:
            style.layout("DarkCompact.TButton", [
                ("Button.border", {"sticky": "nswe", "children": [
                    ("Button.focus", {"sticky": "nswe", "children": [
                        ("Button.padding", {"sticky": "nswe", "padx": 2, "pady": 1,
                                            "children": [("Button.label", {"sticky": "nswe"})]})
                    ]})
                ]})
            ])
        except tk.TclError:
            style.configure("DarkCompact.TButton", padding=(2, 1, 2, 1))
        style.configure("DarkCompact.TButton", background=self.BG_COLOR, foreground=self.TEXT_FG, bordercolor=self.BORDER_CLR)
        style.map("DarkCompact.TButton", background=[('active', COMBO_BG)])

        style.configure("Dark.TEntry", fieldbackground=COMBO_BG, foreground=COMBO_FG)
        style.configure("Dark.TSpinbox", fieldbackground=COMBO_BG, foreground=COMBO_FG, bordercolor=self.BORDER_CLR)
        # （必要に応じて active 時の色も合わせたい場合）
        try:
            style.map("Dark.TSpinbox",
                      fieldbackground=[('!disabled', COMBO_BG), ('readonly', COMBO_BG)],
                      foreground=[('!disabled', COMBO_FG)])
        except tk.TclError:
            pass
        style.configure("TScrollbar", troughcolor=self.TEXT_BG, background=SCROLLBAR_THUMB_COLOR, relief='flat', borderwidth=0, bordercolor=self.BORDER_CLR, arrowcolor=self.BORDER_CLR)
        style.map("TScrollbar", background=[('disabled', SCROLLBAR_THUMB_COLOR), ('active', '#8A98A8')], troughcolor=[('disabled', self.BORDER_CLR)], arrowcolor=[('disabled', self.BORDER_CLR)])
        style.configure("TPanedWindow", background=self.BG_COLOR)
        style.configure("Dark.TCombobox", fieldbackground=COMBO_BG, background=COMBO_BG, foreground=COMBO_FG, arrowcolor=COMBO_FG, bordercolor=self.BORDER_CLR)
        style.map("Dark.TCombobox", fieldbackground=[("readonly", COMBO_BG), ("!disabled", COMBO_BG)], foreground=[("readonly", COMBO_FG), ("!disabled", COMBO_FG)], background=[("readonly", COMBO_BG), ("!disabled", COMBO_BG)])
        self.option_add("*TCombobox*Listbox*Background", COMBO_BG)
        self.option_add("*TCombobox*Listbox*Foreground", COMBO_FG)
        self.option_add("*TCombobox*Listbox*selectBackground", COMBO_SEL_BG)
        self.option_add("*TCombobox*Listbox*selectForeground", COMBO_SEL_FG)
        self.mono_font = ("Menlo", 12) if sys.platform == "darwin" else ("Consolas", 12)
        style.configure("Treeview", borderwidth=1, relief="solid", background=self.TEXT_BG, fieldbackground=self.TEXT_BG, foreground=self.TEXT_FG, rowheight=22)
        style.map("Treeview", background=[('selected', self.SELECT_BG)], foreground=[('selected', self.SELECT_FG)])
        
        # タブの✕印
        def _make_cross_img(px=10, thickness=2, color="#D9DEE7"):
            img = tk.PhotoImage(master=self, width=px, height=px)
            half = thickness // 2
            def put(x, y):
                if 0 <= x < px and 0 <= y < px: img.put(color, (x, y))
            for i in range(px):
                for o in range(-half, half + 1):
                    put(i, i + o); put(i, (px - 1 - i) + o)
            return img
        
        CLOSE_COLOR_DEFAULT, CLOSE_COLOR_HOVER, CLOSE_COLOR_PRESSED = "#D9DEE7", "#66A8FF", "#3D8CFF"
        ICON_SIZE, ICON_THICK = 9, 2
        
        self.close_btn_images = {
            "default": _make_cross_img(ICON_SIZE, ICON_THICK, CLOSE_COLOR_DEFAULT),
            "hover":   _make_cross_img(ICON_SIZE, ICON_THICK, CLOSE_COLOR_HOVER),
            "pressed": _make_cross_img(ICON_SIZE, ICON_THICK, CLOSE_COLOR_PRESSED),
        }
        
        try:
            style.element_create("close", "image", self.close_btn_images["default"],
                ("active", self.close_btn_images["hover"]), ("pressed", self.close_btn_images["pressed"]),
                border=5, sticky="")
        except tk.TclError: pass

        style.layout("Closable.TNotebook", [("Notebook.client", {"sticky": "nswe"})])
        style.layout("Closable.TNotebook.Tab", [("Notebook.tab", {"sticky": "nswe", "children": [
            ("Notebook.padding", {"side": "top", "sticky": "nswe", "children": [
                ("Notebook.focus", {"side": "top", "sticky": "nswe", "children": [
                    ("close", {"side": "left", "sticky": ''}),
                    ("Notebook.label", {"side": "left", "sticky": ''}),
                ]})
            ]})
        ]})])

        style.configure("TNotebook", background=self.BG_COLOR, borderwidth=0)
        style.configure("TNotebook.Tab", background=self.BG_COLOR, foreground=self.TEXT_FG, borderwidth=1, padding=[10, 4])
        style.map("TNotebook.Tab", background=[("selected", COMBO_BG)], foreground=[("selected", COMBO_SEL_FG)])
        
        # リモートタブ用のスタイル
        REMOTE_TAB_COLOR = "#00406A"
        style.configure("Remote.TNotebook", background=self.BG_COLOR, borderwidth=0)
        style.layout("Remote.TNotebook.Tab", style.layout("Closable.TNotebook.Tab"))
        style.configure("Remote.TNotebook.Tab", background=self.BG_COLOR, foreground=self.TEXT_FG, borderwidth=1, padding=[10, 4])
        style.map("Remote.TNotebook.Tab", background=[("selected", REMOTE_TAB_COLOR)], foreground=[("selected", COMBO_SEL_FG)])
        
        # --- 状態 ---
        self.watchers = {}; self.current_watcher_id = None; self.current_session_name = None
        self.command_file = None; self.log_file = None; self.status_file = None
        self.history = []; self.history_idx = -1
        self._log_fetch_timer = None
        self._log_pos = 0
        self.sync_indicator_label = None
        self.file_tree = None
        self.path_to_iid = {}
        self.current_tree_root = None
        self.editor_notebook = None
        self.tabs = {}
        self.search_frame = None
        self.search_bar_visible = False
        self.search_var = tk.StringVar()
        self.completion_popup = None
        self.terminal_context_menu = tk.Menu(self, tearoff=0)
        self.terminal_context_menu.add_command(label="Copy", command=self._copy_selection)
        self.pending_download_info = None
        
        self.remote_cwd = None
        self.symlink_icon = tk.PhotoImage(master=self, width=16, height=16)
        arrow_color = "#66A8FF"
        for i in range(5):
            self.symlink_icon.put(arrow_color, (7+i, 10+i))
        for i in range(4):
            self.symlink_icon.put(arrow_color, (8+i, 14))
            self.symlink_icon.put(arrow_color, (11, 11+i))

        # --- 画像プレビュー用 ---
        self.editor_right_pane = None
        self.preview_frame = None
        self.preview_canvas = None
        self._preview_label_var = None
        self.image_preview_label = None
        self._preview_label_full = ""
        self._preview_original_image = None
        self._preview_photo = None
        
        self.prefs = {
            "editor_family": (self.mono_font[0] if isinstance(self.mono_font, tuple) else "Menlo"),
            "editor_size":   (self.mono_font[1] if isinstance(self.mono_font, tuple) else 12),
            "term_family":   (self.mono_font[0] if isinstance(self.mono_font, tuple) else "Menlo"),
            "term_size":     (self.mono_font[1] if isinstance(self.mono_font, tuple) else 12),
        }
        self._create_widgets()
        self._bind_global_keys()

        LOCAL_SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
        LOCAL_EDITING_CACHE.mkdir(parents=True, exist_ok=True)
        
        self._load_state()
        self._update_watcher_list()
        self.protocol("WM_DELETE_WINDOW", self._on_closing)
        self.is_loading = False

    # ---------------------------
    # 保存/復元
    # ---------------------------
    def _save_state(self):
        open_files = []
        for tab_data in self.tabs.values():
            if tab_data.get("remote_path"):
                open_files.append(f"remote::{tab_data['remote_path']}")
            elif tab_data.get("filepath"):
                open_files.append(str(tab_data['filepath']))

        active_file = None
        current_tab_data = self._get_current_tab_data()
        if current_tab_data:
            if current_tab_data.get("remote_path"):
                active_file = f"remote::{current_tab_data['remote_path']}"
            elif current_tab_data.get("filepath"):
                active_file = str(current_tab_data['filepath'])

        state_data = {
            "open_files": open_files, "active_file": active_file,
            "last_tree_root": str(self.current_tree_root) if self.current_tree_root else None
        }
        state_data["prefs"] = self.prefs
        try:
            state_data["main_sash_pos"] = self.main_pane.sashpos(0)
            state_data["editor_sash_pos"] = self.editor_pane.sashpos(0)
        except tk.TclError: pass
        try:
            with open(STATE_JSON_PATH, "w", encoding="utf-8") as f:
                json.dump(state_data, f, indent=2)
        except Exception as e:
            print(f"Failed to save session state: {e}")

    def _load_state(self):
        if not STATE_JSON_PATH.exists():
            self.after(100, self._set_initial_sash_position); self._create_new_tab()
            return
        
        sash_loaded = False
        try:
            state = json.load(STATE_JSON_PATH.open("r", encoding="utf-8"))
            # 大規模なツリー読み込みによるフリーズ回避
            # last_root = state.get("last_tree_root")
            # if last_root and Path(last_root).is_dir():
            #     self._populate_file_tree(Path(last_root))
            # --- load prefs ---
            
            prefs = state.get("prefs")
            if isinstance(prefs, dict):
                self.prefs.update({
                    "editor_family": prefs.get("editor_family", self.prefs["editor_family"]),
                    "editor_size":   int(prefs.get("editor_size",   self.prefs["editor_size"])),
                    "term_family":   prefs.get("term_family",   self.prefs["term_family"]),
                    "term_size":     int(prefs.get("term_size",     self.prefs["term_size"])),
                })

            open_files = state.get("open_files", [])
            if not open_files: self._create_new_tab()
            else:
                for fpath_str in open_files:
                    if fpath_str.startswith("remote::"):
                        pass
                    else:
                        if Path(fpath_str).is_file(): self.editor_open_file(filepath=Path(fpath_str))
            
            main_sash, editor_sash = state.get("main_sash_pos"), state.get("editor_sash_pos")
            if main_sash is not None and editor_sash is not None:
                def apply_sashes(e):
                    self.unbind("<Configure>")
                    self.after(10, lambda: (
                        self.main_pane.sashpos(0, main_sash), self.editor_pane.sashpos(0, editor_sash)
                    ))
                self.bind("<Configure>", apply_sashes, "+"); sash_loaded = True
        except Exception as e:
            print(f"Failed to load session state: {e}"); self._create_new_tab()
        
        if not sash_loaded: self.after(100, self._set_initial_sash_position)
        self._apply_font_prefs()


    def _on_closing(self):
        dirty_files = [data["filepath"].name for data in self.tabs.values() if data["is_dirty"]]
        if dirty_files:
            file_list = "\n - ".join(dirty_files)
            msg = f"変更が保存されていないファイルがあります:\n - {file_list}\n\n保存せずに終了しますか？"
            if not messagebox.askyesno("確認", msg):
                return

        if self._log_fetch_timer: self.after_cancel(self._log_fetch_timer)
        self._save_state()
        self.destroy()

    # ---------------------------
    # 同期／Watcher一覧
    # ---------------------------
    def _show_sync_indicator(self): self.sync_indicator_label.config(text="Syncing...")
    def _hide_sync_indicator(self): self.sync_indicator_label.config(text="")
    def _run_sync_command(self, cmd_list, **kwargs):
        self._show_sync_indicator(); self.update_idletasks()
        try: return subprocess.run(cmd_list, **kwargs)
        finally: self._hide_sync_indicator()

    def _update_watcher_list(self):
        # サーバー → ローカルに _registry を取得（ローカルのみ --delete はOK）
        try:
            LOCAL_REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
            self._run_sync_command(
                ["rsync", "-az", "--delete",
                 f"{REMOTE_SERVER}:{REMOTE_REGISTRY_PATH}",
                 f"{str(LOCAL_REGISTRY_DIR)}/"],
                check=True, capture_output=True, timeout=5
            )
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            return
    
        now = time.time()
        HB_KEYS = ("last_heartbeat", "last_seen", "heartbeat_ts")
    
        # 重要: *.json のみ、かつ名前順で安定化
        files = sorted(LOCAL_REGISTRY_DIR.glob("*.json"), key=lambda p: p.name.lower())
    
        watchers_by_label = {}
        labels_seen = set()
        choices = []
    
        for reg_file in files:
            try:
                data = json.loads(reg_file.read_text("utf-8"))
            except Exception:
                continue
    
            # ハートビート時刻（欠損時は mtime を使用）
            ts = None
            for k in HB_KEYS:
                if k in data:
                    ts = data.get(k)
                    break
            if ts is None:
                ts = reg_file.stat().st_mtime
            try:
                ts = float(ts)
            except Exception:
                continue
            if now - ts > WATCHER_HEARTBEAT_TIMEOUT_SEC:
                continue  # タイムアウト
    
            # ★ ここが肝: 拡張子を外して watcher_id にする
            watcher_id = Path(reg_file).stem
            display_name = data.get("display_name") or watcher_id
    
            # 表示ラベルのユニーク化（同名がいれば "(id)" を付与）
            label = display_name if display_name not in labels_seen else f"{display_name} ({watcher_id})"
            labels_seen.add(label)
    
            watchers_by_label[label] = {"id": watcher_id, "display_name": display_name}
            choices.append(label)
    
        # UI 反映（選択は id ベースで復元）
        prev_id = getattr(self, "current_watcher_id", None)
        self.watchers = watchers_by_label
        self.watcher_combo["values"] = choices
    
        if prev_id:
            for lab, info in watchers_by_label.items():
                if info["id"] == prev_id:
                    self.watcher_combo.set(lab)
                    break
            else:
                # 既存 id が見つからなければ初期選択
                if choices:
                    self.watcher_combo.set(choices[0])
                    self._on_watcher_selected()
                else:
                    self.watcher_combo.set("")
                    self.session_combo.set("")
                    self.session_combo["values"] = []
        else:
            if choices and not self.watcher_combo.get():
                self.watcher_combo.set(choices[0])
                self._on_watcher_selected()
    
    def _on_watcher_selected(self, event=None):
        watcher_name = self.watcher_combo.get()
        if not watcher_name:
            self.session_combo["values"] = []; self.session_combo.set("")
            return
        
        watcher_id = self.watchers[watcher_name]["id"]
        local_watcher_dir = LOCAL_SESSIONS_ROOT / watcher_id
        remote_watcher_dir = f"{REMOTE_SESSIONS_PATH}/{watcher_id}/"
        sessions = []
        try:
            self._run_sync_command(["rsync", "-az", "--delete", f"{REMOTE_SERVER}:{remote_watcher_dir}", f"{str(local_watcher_dir)}/"], check=True, timeout=5)
            if local_watcher_dir.is_dir():
                sessions = sorted([p.name for p in local_watcher_dir.iterdir() if p.is_dir()])
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
            messagebox.showwarning("Error", f"Failed to sync/list sessions for {watcher_name}:\n{e}")
    
        self.session_combo["values"] = sessions
        if sessions:
            self.session_combo.set(sessions[0])
        else:
            self.session_combo.set("")
        self._on_session_selected()

    def _on_session_selected(self, event=None):
        watcher_name = self.watcher_combo.get()
        session_name = self.session_combo.get()
        if not watcher_name or not session_name:
            self._clear_connection()
            return
        watcher_id = self.watchers[watcher_name]["id"]
        self._switch_to_session(watcher_id, session_name)
    
    def _create_session(self):
        watcher_name = self.watcher_combo.get()
        if not watcher_name:
            messagebox.showwarning("Session", "Please select a Watcher first.")
            return
        watcher_id = self.watchers[watcher_name]["id"]
        new_name = self.new_session_var.get().strip()
        if not new_name or any(c in new_name for c in r'\/:*?"<>|'):
            messagebox.showwarning("Session", "Invalid session name.")
            return
        try:
            remote_watcher_dir = f"{REMOTE_SESSIONS_PATH}/{watcher_id}"
            self._run_sync_command(["ssh", REMOTE_SERVER, f"mkdir -p '{remote_watcher_dir}'"], check=True, timeout=5, capture_output=True)
            local_session_path = LOCAL_SESSIONS_ROOT / watcher_id / new_name
            local_session_path.mkdir(parents=True, exist_ok=True)
            self._run_sync_command(["rsync", "-az", str(local_session_path) + "/", f"{REMOTE_SERVER}:{remote_watcher_dir}/{new_name}/"], check=True, timeout=5)
        except subprocess.CalledProcessError as e:
            error_details = e.stderr.decode('utf-8', errors='ignore').strip()
            messagebox.showerror("Error", f"サーバーでのセッション作成に失敗しました: {e}\n\n詳細: {error_details}")
            return
        except Exception as e:
            messagebox.showerror("Error", f"Failed to create session directory: {e}")
            return
        
        self.new_session_var.set("")
        self._on_watcher_selected()
        self.after(200, lambda: self.session_combo.set(new_name))
        self.after(250, self._on_session_selected)
    
    def _clear_connection(self):
        self.current_watcher_id = None
        self.current_session_name = None
        
        if self._log_fetch_timer:
            self.after_cancel(self._log_fetch_timer)
            self._log_fetch_timer = None
            
        if self.terminal:
            self.terminal.reset_to_disconnected_state()
            
        self.command_file = None
        self.log_file = None
        self.status_file = None
        
        if self.file_tree:
            for i in self.file_tree.get_children():
                self.file_tree.delete(i)
        
        self._update_editor_title()
    
    def request_send_command(self, command):
        """Terminalコンポーネントからの依頼でコマンドを送信し、ポーリングを開始する"""
        self._send_command_to_watcher(command)
        if self._log_fetch_timer:
            self.after_cancel(self._log_fetch_timer)
        self._fetch_log_updates()

    def _switch_to_session(self, watcher_id: str, session_name: str):
        if self.current_watcher_id == watcher_id and self.current_session_name == session_name:
            return
        self.current_watcher_id = watcher_id; self.current_session_name = session_name
        session_dir = LOCAL_SESSIONS_ROOT / watcher_id / session_name
        session_dir.mkdir(parents=True, exist_ok=True)
        self.command_file = session_dir / "commands.txt"; self.log_file = session_dir / "commands.log"; self.status_file = session_dir / ".watcher_status.json"
        
        self._populate_file_tree(session_dir)

        # Terminalの初期メッセージ
        self.terminal.view.config(state=tk.NORMAL)
        self.terminal.view.delete("1.0", tk.END)
        display_name = self.watcher_combo.get()
        self.terminal.append_log(f"[--- Switched to Watcher: '{display_name}', Session: '{session_name}' ---]\n")

        try:
            remote_session_dir = f"{REMOTE_SESSIONS_PATH}/{watcher_id}/{session_name}/"
            self._run_sync_command(["rsync", "-az", f"{REMOTE_SERVER}:{remote_session_dir}commands.log", f"{str(self.log_file.parent)}/"], timeout=5)
            if self.log_file.exists():
                content = self.log_file.read_text(encoding="utf-8", errors="replace")
                initial_log = "\n".join(content.splitlines()[-INIT_TAIL_LINES:])
                self.terminal.process_and_append_log(initial_log + "\n")
                self._log_pos = self.log_file.stat().st_size
            else:
                self._log_pos = 0
        except Exception as e:
            self.terminal.append_log(f"[GUI] Failed to process initial log: {e}\n")
            self._log_pos = 0

        self.terminal._show_remote_prompt()
    
    def _set_initial_sash_position(self):
        try:
            height = self.main_pane.winfo_height()
            self.main_pane.sash_place(0, 0, int(height * 0.80))
            width = self.editor_pane.winfo_width()
            self.editor_pane.sash_place(0, int(width * 0.25), 0)
        except tk.TclError:
            pass

    # ---------------------------
    # Tooltip（チラつき最小化版）
    # ---------------------------
    def _ensure_tooltip(self, widget):
        if not hasattr(self, "_tooltips"):
            self._tooltips = {}  # widget -> {"tip": Toplevel, "label": ttk.Label, "after_id": int|None}
        obj = self._tooltips.get(widget)
        if obj:
            return obj
    
        tip = tk.Toplevel(self)
        tip.withdraw()
        tip.overrideredirect(True)
        lbl = ttk.Label(tip, style="Dark.TLabel", padding=(6, 3))
        lbl.pack()
        obj = {"tip": tip, "label": lbl, "after_id": None}
        self._tooltips[widget] = obj
    
        def _show():
            try:
                tip.deiconify()
                x = widget.winfo_rootx() + 10
                y = widget.winfo_rooty() + widget.winfo_height() + 6
                tip.geometry(f"+{x}+{y}")
            except tk.TclError:
                pass
    
        def enter(_):
            # 少し遅延して表示（チラつき防止）
            if obj["after_id"]:
                self.after_cancel(obj["after_id"])
            obj["after_id"] = self.after(220, _show)
    
        def leave(_):
            if obj["after_id"]:
                self.after_cancel(obj["after_id"])
                obj["after_id"] = None
            tip.withdraw()
    
        widget.bind("<Enter>", enter, "+")
        widget.bind("<Leave>", leave, "+")
        return obj
    
    def _set_tooltip_text(self, widget, text):
        obj = self._ensure_tooltip(widget)
        obj["label"].config(text=text or "")
        if not text:
            obj["tip"].withdraw()
    
    def _hide_all_tooltips(self):
        if hasattr(self, "_tooltips"):
            for obj in self._tooltips.values():
                try:
                    obj["tip"].withdraw()
                except tk.TclError:
                    pass

    def _tooltip(self, widget, text):
        self._set_tooltip_text(widget, text)

    # ---------------------------
    # UI構築
    # ---------------------------
    def _create_widgets(self):
        # --- (修正) OS判定によるボタンテキストの定義 ---
        is_linux = sys.platform.startswith("linux")
        refresh_text = "Sync" if is_linux else "🔄"
        open_folder_text = "Open" if is_linux else "📁"
        create_link_text = "Link" if is_linux else "🔗"
        jump_home_text = "Home" if is_linux else "🏠"
        prefs_text = "Prefs" if is_linux else "\u2699\ufe0f"
        
        # --- Session bar ---
        session_bar = ttk.Frame(self, style="Dark.TFrame", padding=(10, 8))
        session_bar.pack(side=tk.TOP, fill=tk.X)
        # --- Preferences button (右端) ---
        # 右端にアイコンボタンを追加（他のアイコン系と同じスタイル/幅）
        gear_btn = ttk.Button(session_bar, text=prefs_text, width=3,  # ほかの 📁/🔗/🏠 と同等の幅
                              command=self.open_preferences, style="Dark.TButton")
        gear_btn.pack(side=tk.RIGHT, padx=(6, 0))
        self._tooltip(gear_btn, "Preferences")

        ttk.Label(session_bar, text="Watcher:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        self.watcher_combo = ttk.Combobox(session_bar, state="readonly", width=24, style="Dark.TCombobox")
        self.watcher_combo.pack(side=tk.LEFT)
        self.watcher_combo.bind("<<ComboboxSelected>>", self._on_watcher_selected)
        # --- (修正) textに変数を使用 ---
        ttk.Button(session_bar, text=refresh_text, width=4, command=self._update_watcher_list).pack(side=tk.LEFT, padx=(4, 0))
        ttk.Label(session_bar, text="Session:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(10, 4))
        self.session_combo = ttk.Combobox(session_bar, state="readonly", width=20, style="Dark.TCombobox")
        self.session_combo.pack(side=tk.LEFT)
        self.session_combo.bind("<<ComboboxSelected>>", self._on_session_selected)
        self.new_session_var = tk.StringVar()
        ttk.Label(session_bar, text="New:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(10, 4))
        ttk.Entry(session_bar, textvariable=self.new_session_var, width=16, style="Dark.TEntry").pack(side=tk.LEFT)
        ttk.Button(session_bar, text="Create", command=self._create_session, style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))
    
        # --- Main split (vertical) ---
        self.main_pane = ttk.PanedWindow(self, orient=tk.VERTICAL)
        self.main_pane.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
    
        # --- Upper split for File Explorer + (Editor + Preview) ---
        self.editor_pane = ttk.PanedWindow(self.main_pane, orient=tk.HORIZONTAL)

        # 左：File Explorer
        file_tree_frame = ttk.Frame(self.editor_pane, style="Dark.TFrame")
        file_tree_toolbar = ttk.Frame(file_tree_frame, style="Dark.TFrame", padding=(8, 6))
        file_tree_toolbar.pack(side=tk.TOP, fill=tk.X)
        
        # --- (修正) textに変数を使用 ---
        b1 = ttk.Button(file_tree_toolbar, text=open_folder_text, width=4,
                        command=self._browse_file_tree_root, style="Dark.TButton")
        b1.pack(side=tk.LEFT, padx=(6,0))
        b2 = ttk.Button(file_tree_toolbar, text=create_link_text, width=4,
                        command=self._prompt_create_symlink, style="Dark.TButton")
        b2.pack(side=tk.LEFT, padx=(6,0))
        b3 = ttk.Button(file_tree_toolbar, text=jump_home_text, width=4,
                        command=self._jump_to_mirror, style="Dark.TButton")
        b3.pack(side=tk.LEFT, padx=(6,0))
        self._tooltip(b1, "Open Folder")
        self._tooltip(b2, "Remote Link Folder")
        self._tooltip(b3, "Jump Mirror Home")

        tree_scroll_frame = ttk.Frame(file_tree_frame)
        tree_scroll_frame.pack(fill=tk.BOTH, expand=True)
        self.file_tree = ttk.Treeview(tree_scroll_frame, show="tree", selectmode="browse")
        tree_ysb = ttk.Scrollbar(tree_scroll_frame, orient="vertical", command=self.file_tree.yview)
        tree_xsb = ttk.Scrollbar(tree_scroll_frame, orient="horizontal", command=self.file_tree.xview)
        self.file_tree.configure(yscrollcommand=tree_ysb.set, xscrollcommand=tree_xsb.set)
        tree_ysb.pack(side=tk.RIGHT, fill=tk.Y)
        tree_xsb.pack(side=tk.BOTTOM, fill=tk.X)
        self.file_tree.pack(fill=tk.BOTH, expand=True)
        self.file_tree.bind("<Double-1>", self._on_file_tree_double_click)
        self.file_tree.bind("<Button-1>", self._on_tree_click)

        # 右：（Editor + Preview）を入れる右ペイン
        self.editor_right_pane = ttk.PanedWindow(self.editor_pane, orient=tk.HORIZONTAL)

        # Editor（EditorView に委譲）
        editor_frame = ttk.Frame(self.editor_right_pane, style="Dark.TFrame")
        self.editor_view = EditorView(editor_frame, app=self)
        self.editor_view.pack(fill=tk.BOTH, expand=True)
        self.tabs              = self.editor_view.tabs
        self.editor_notebook   = self.editor_view.editor_notebook
        self.editor_file_label = self.editor_view.file_label
        self.search_frame      = self.editor_view.search_frame
        # 既存互換のためのエイリアス
        for _name in (
            "editor_open_file", "editor_save_file", "editor_save_file_as",
            "_create_new_tab", "_get_current_tab_data",
            "apply_syntax_highlight", "_resolve_color", "_advance_index",
            "_on_editor_modified", "_schedule_rehighlight", "_rehighlight",
            "_update_line_numbers", "_schedule_update_line_numbers",
            "_on_tab_changed", "_on_close_press", "_on_close_release",
            "_close_tab_by_id", "_on_text_scroll", "_on_scrollbar_move",
        ):
            setattr(self, _name, getattr(self.editor_view, _name))

        # ペインに追加
        self.editor_right_pane.add(editor_frame, weight=8)
        self.editor_pane.add(file_tree_frame, weight=2)
        self.editor_pane.add(self.editor_right_pane, weight=8)
        
        # サッシュをドラッグしている間はツールチップを隠し、プレビューを都度描き直す
        for pane in (self.editor_pane, self.editor_right_pane):
            pane.bind("<B1-Motion>", lambda e: (self._hide_all_tooltips(), self._on_pane_drag()), "+")
            pane.bind("<ButtonRelease-1>", lambda e: self._on_pane_drag_end(), "+")
        
        # 下段：Terminal
        self.terminal = TerminalFrame(self.main_pane, self)
        self.main_pane.add(self.editor_pane, weight=8)
        self.main_pane.add(self.terminal,    weight=2)

    # ---------------------------
    # 画像プレビュー
    # ---------------------------
    def _is_image_file(self, path: Path) -> bool:
        ext = path.suffix.lower()
        return ext in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}

    def _on_pane_drag(self):
        # ドラッグ中の軽量リフレッシュ
        try:
            if self.preview_canvas:
                self.preview_canvas.update_idletasks()
                self._render_preview_fit()
            if self.image_preview_label:
                self._update_preview_label_text()
        except Exception:
            pass
    
    def _on_pane_drag_end(self):
        # ドラッグ終了時に最終リフレッシュ
        self._hide_all_tooltips()
        self._on_pane_drag()

    def _ensure_image_preview_area(self):
        """右側にプレビュー用ペインを作成（なければ）"""
        if self.preview_frame and self.preview_frame.winfo_exists():
            return
        
        # --- (修正) OS判定による閉じるボタンのテキスト定義 ---
        is_linux = sys.platform.startswith("linux")
        close_btn_text = "X" if is_linux else "✕"

        # プレビューフレーム作成
        self.preview_frame = ttk.Frame(self.editor_right_pane, style="Dark.TFrame")
        # ヘッダ（ラベル＋✕）を grid で
        top = ttk.Frame(self.preview_frame, style="Dark.TFrame", padding=(8,6))
        top.pack(side=tk.TOP, fill=tk.X)
        top.grid_columnconfigure(0, weight=1)

        self._preview_label_var = tk.StringVar(value="(no image)")
        self.image_preview_label = ttk.Label(top, textvariable=self._preview_label_var, style="Dark.TLabel", anchor="w")
        self.image_preview_label.grid(row=0, column=0, sticky="ew", padx=(0, 8))

        # --- (修正) textに変数を使用 ---
        close_btn = ttk.Button(
            top, text=close_btn_text, width=3, style="Dark.TButton",
            command=self._hide_image_preview, takefocus=False
        )
        close_btn.grid(row=0, column=1, sticky="e")
        self._set_tooltip_text(close_btn, "Close preview")

        # キャンバス本体
        self.preview_canvas = tk.Canvas(self.preview_frame, bg=self.TEXT_BG, highlightthickness=0)
        self.preview_canvas.pack(fill=tk.BOTH, expand=True)
        self.preview_canvas.bind("<Configure>", lambda e: self._render_preview_fit())

        # 右ペインに追加（初回のみ）
        try:
            self.editor_right_pane.add(self.preview_frame, weight=4)
        except tk.TclError:
            pass

        # サイズ変化時に省略再計算
        top.bind("<Configure>", lambda e: self._update_preview_label_text())

    def _hide_image_preview(self):
        if not self.preview_frame:
            return
        try:
            self.editor_right_pane.forget(self.preview_frame)
        except tk.TclError:
            pass
        try:
            self.preview_frame.destroy()
        except Exception:
            pass
        self.preview_frame = None
        self.preview_canvas = None
        self.image_preview_label = None
        self._preview_label_var = None
        self._preview_label_full = ""
        self._preview_original_image = None
        self._preview_photo = None
        
    def _font_for(self, widget):
        """widgetの実フォントを安全にtkfont.Fontとして取得"""
        try:
            f = widget.cget("font")
        except tk.TclError:
            return tkfont.nametofont("TkDefaultFont")
        try:
            if isinstance(f, str) and f:
                return tkfont.nametofont(f)
            return tkfont.Font(font=f)
        except Exception:
            return tkfont.nametofont("TkDefaultFont")

    def _update_preview_label_text(self):
        """ヘッダー文字列を右端✕が隠れない幅に省略（末尾優先）"""
        if not self.image_preview_label:
            return
        top = self.image_preview_label.nametowidget(self.image_preview_label.winfo_parent())
        total_w = top.winfo_width()
        if total_w <= 1:
            self.after(1, self._update_preview_label_text)
            return
        # ✕ボタンの幅を取得
        close_w = 40
        for child in top.winfo_children():
            if isinstance(child, ttk.Button):
                w = child.winfo_width()
                if w > 0:
                    close_w = w
                    break
        padding = 24
        avail = max(10, total_w - close_w - padding)
        full = self._preview_label_full or ""
        font = self._font_for(self.image_preview_label)
        if font.measure(full) <= avail:
            self._preview_label_var.set(full or "(no image)")
            self._set_tooltip_text(self.image_preview_label, full)
            return
        # 末尾優先省略
        ell = "…"
        lo, hi = 0, len(full)
        best = ell
        while lo <= hi:
            mid = (lo + hi) // 2
            cand = ell + full[-mid:]
            if font.measure(cand) <= avail:
                best = cand
                lo = mid + 1
            else:
                hi = mid - 1
        self._preview_label_var.set(best)
        self._set_tooltip_text(self.image_preview_label, full)

    def _show_image_in_preview(self, file_path: Path, remote_path: str | None = None):
        """ローカル画像を右ペインでプレビュー"""
        self._ensure_image_preview_area()

        # ヘッダテキスト（ピクセル数は表示しない）
        label_text = str(file_path) if not remote_path else f"[REMOTE] {remote_path}"
        self._preview_label_full = label_text
        self._update_preview_label_text()

        # 画像読み込み
        self._preview_original_image = None
        self._preview_photo = None
        if PIL_AVAILABLE:
            try:
                self._preview_original_image = Image.open(file_path)
            except Exception as e:
                # 読めなければキャンバスにメッセージ
                self.preview_canvas.delete("all")
                self.preview_canvas.create_text(
                    10, 10, anchor="nw", fill=self.TEXT_FG,
                    text=f"Failed to open image:\n{e}"
                )
                return
        # レンダリング
        self._render_preview_fit()

    def _render_preview_fit(self):
        """キャンバスに合わせて画像をフィット表示（ヘッダーにはサイズを書かない）"""
        if not self.preview_canvas:
            return
        self.preview_canvas.delete("all")
        w = self.preview_canvas.winfo_width()
        h = self.preview_canvas.winfo_height()
        if w <= 2 or h <= 2:
            return

        if PIL_AVAILABLE and self._preview_original_image is not None:
            img = self._preview_original_image
            iw, ih = img.width, img.height
            if iw <= 0 or ih <= 0:
                return
            scale = min(w / iw, h / ih)
            new_w = max(1, int(iw * scale))
            new_h = max(1, int(ih * scale))
            try:
                resized = img.resize((new_w, new_h), Image.LANCZOS)
            except Exception:
                resized = img.resize((new_w, new_h))
            self._preview_photo = ImageTk.PhotoImage(resized)
            # 背景
            self.preview_canvas.create_rectangle(0, 0, w, h, fill=self.TEXT_BG, width=0)
            # 画像を中央に
            self.preview_canvas.create_image(w // 2, h // 2, image=self._preview_photo, anchor="center")
        else:
            # Pillowが無い場合：プレースホルダ
            self.preview_canvas.create_rectangle(0, 0, w, h, fill=self.TEXT_BG, width=0)
            msg = "(Pillow is not available)\nInstall pillow to preview images."
            self.preview_canvas.create_text(w//2, h//2, text=msg, fill=self.TEXT_FG, anchor="center")

    # ---------------------------
    # Tree / Explorer
    # ---------------------------
    def _jump_to_mirror(self):
        if not self.current_watcher_id or not self.current_session_name:
            messagebox.showinfo("Mirror", "先に Watcher と Session を選択してください。")
            return
        mirror_root = LOCAL_SESSIONS_ROOT / self.current_watcher_id / self.current_session_name
        try:
            mirror_root.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            messagebox.showerror("Mirror", f"ミラー用フォルダの作成に失敗しました:\n{e}")
            return
        self._populate_file_tree(mirror_root)

    def _prompt_create_symlink(self):
        """シンボリックリンク作成ダイアログ"""
        if not self.current_session_name:
            messagebox.showwarning("エラー", "リンクを作成するには、まずセッションを選択してください。")
            return
        dialog = tk.Toplevel(self)
        dialog.title("Create Symbolic Link in Session")
        dialog.geometry("500x200")
        dialog.configure(bg=self.BG_COLOR)
        dialog.transient(self)
        dialog.grab_set()
        main_frame = ttk.Frame(dialog, style="Dark.TFrame", padding=15)
        main_frame.pack(fill=tk.BOTH, expand=True)
        ttk.Label(main_frame, text="Source Path (on Watcher):", style="Dark.TLabel").pack(anchor="w")
        initial_path = self.remote_cwd if self.remote_cwd else REMOTE_BASE_PATH
        source_var = tk.StringVar(main_frame, value=initial_path)
        ttk.Entry(main_frame, textvariable=source_var, style="Dark.TEntry", width=50).pack(fill=tk.X, pady=(2, 10))
        ttk.Label(main_frame, text="Link Name (to create in session):", style="Dark.TLabel").pack(anchor="w")
        link_name_var = tk.StringVar(main_frame, value="project_link")
        ttk.Entry(main_frame, textvariable=link_name_var, style="Dark.TEntry", width=50).pack(fill=tk.X, pady=(2, 10))
        btn_frame = ttk.Frame(main_frame, style="Dark.TFrame")
        btn_frame.pack(fill=tk.X, side=tk.BOTTOM, pady=(10, 0))
        def on_ok():
            source_path = source_var.get().strip()
            link_name = link_name_var.get().strip()
            if not source_path or not link_name:
                messagebox.showwarning("入力エラー", "パスとリンク名の両方を入力してください。", parent=dialog)
                return
            if '/' in link_name or '\\' in link_name:
                messagebox.showwarning("入力エラー", "リンク名にスラッシュを含めることはできません。", parent=dialog)
                return
            self._execute_create_symlink(source_path, link_name)
            dialog.destroy()
        ttk.Button(btn_frame, text="Create Link", command=on_ok, style="Dark.TButton").pack(side=tk.RIGHT)
        ttk.Button(btn_frame, text="Cancel", command=dialog.destroy, style="Dark.TButton").pack(side=tk.RIGHT, padx=6)
        dialog.wait_window()

    def _execute_create_symlink(self, source_path: str, link_name: str):
        local_link_path = self.command_file.parent / link_name
        if local_link_path.is_symlink() or local_link_path.exists():
            msg = f"リンク '{link_name}' は既に存在します。新しいリンク先で置き換えますか？"
            if not messagebox.askyesno("確認", msg):
                return
        command = f"_internal_create_link::{source_path}::{link_name}"
        try:
            self._send_command_to_watcher(command)
            if self._log_fetch_timer:
                self.after_cancel(self._log_fetch_timer)
            self._fetch_log_updates()
            messagebox.showinfo("コマンド送信完了", "リンク作成（置換）コマンドを送信しました。")
            self.after(2000, self._refresh_file_tree)
        except Exception as e:
            messagebox.showerror("エラー", f"コマンドの送信に失敗しました:\n{e}")

    def _on_tree_click(self, event):
        """展開アイコンで symlink を仮想展開"""
        region = self.file_tree.identify_region(event.x, event.y)
        if region != "tree":
            return
        item_id = self.file_tree.identify_row(event.y)
        if not item_id:
            return
        tags = self.file_tree.item(item_id, "tags")
        children = self.file_tree.get_children(item_id)
        if "symlink" not in tags or len(children) != 1 or self.file_tree.item(children[0], "text") != "Loading...":
            return
        full_local_path = Path(self.file_tree.item(item_id, "values")[0])
        relative_path = full_local_path.relative_to(self.current_tree_root)
        command = f"_internal_list_dir::{str(relative_path)}"
        self._send_command_to_watcher(command)
        if self._log_fetch_timer:
            self.after_cancel(self._log_fetch_timer)
        self._fetch_log_updates()

    def _browse_file_tree_root(self):
        initial_dir = str(LOCAL_SESSIONS_ROOT / self.current_watcher_id
                          if self.current_watcher_id else LOCAL_BASE_DIR)
    
        # ★ 独自ダイアログを使用（レイアウトを自由に）
        shortcuts = [
            ("Home", Path.home()),
            ("Sessions", LOCAL_SESSIONS_ROOT),
            ("Base", LOCAL_BASE_DIR),
        ]
        dlg = DirectoryPicker(self,
                              title="Select a directory to display",
                              initialdir=initial_dir,
                              show_hidden=False,
                              shortcuts=shortcuts,
                              geometry="720x520")
        selected_path = dlg.show()
    
        if selected_path:
            self._populate_file_tree(Path(selected_path))


    def _refresh_file_tree(self):
        if self.current_tree_root and Path(self.current_tree_root).is_dir():
            self.path_to_iid.clear() 
            self._populate_file_tree(self.current_tree_root)

    def _populate_file_tree(self, root_path: Path):
        self.current_tree_root = root_path
        for i in self.file_tree.get_children(): self.file_tree.delete(i)
        if not root_path or not root_path.is_dir(): return
        root_iid = self.file_tree.insert("", "end", text=str(root_path), open=True)
        self._insert_tree_items(root_path, root_iid)

    def _insert_tree_items(self, path: Path, parent_iid: str):
        try:
            if parent_iid not in self.path_to_iid.values():
                 self.path_to_iid[str(path)] = parent_iid
            items = sorted(list(path.iterdir()), key=lambda p: (not p.is_dir(), p.name.lower()))
            for item in items:
                tags = []
                item_icon = "" 
                if item.is_symlink():
                    tags.append("symlink")
                    item_icon = self.symlink_icon
                iid = self.file_tree.insert(parent_iid, "end", text=item.name, 
                                            image=item_icon,
                                            open=False, values=[str(item)], tags=tags)
                self.path_to_iid[str(item)] = iid
                if item.is_dir() and not item.is_symlink():
                    self._insert_tree_items(item, iid)
                if "symlink" in tags:
                    self.file_tree.insert(iid, "end", text="Loading...")
        except (PermissionError, FileNotFoundError):
            pass

    def _populate_virtual_tree(self, parent_iid: str, ls_result: str):
        """仮想展開結果をツリーに挿入"""
        for child in self.file_tree.get_children(parent_iid):
            self.file_tree.delete(child)
        parent_path_str = self.file_tree.item(parent_iid, "values")[0]
        parent_rel_path = Path(parent_path_str).relative_to(self.current_tree_root)
        lines = sorted(ls_result.strip().splitlines())
        if not lines: return
        for line in lines:
            is_dir = line.endswith('/')
            name = line.strip('/')
            remote_rel_path = parent_rel_path / name
            local_path_val = self.current_tree_root / remote_rel_path
            tags = ["virtual"]
            if is_dir: tags.append("virtual_dir")
            else: tags.append("virtual_file")
            iid = self.file_tree.insert(parent_iid, "end", text=name, 
                                  open=False, values=[str(local_path_val)], tags=tags)
            self.path_to_iid[str(local_path_val)] = iid

    def _on_file_tree_double_click(self, event=None):
        try:
            item_id = self.file_tree.focus()
            if not item_id: return
            item_values = self.file_tree.item(item_id, "values")
            tags = self.file_tree.item(item_id, "tags")
            filepath = Path(item_values[0])
            # virtual（リモート）とローカルで分岐、画像ならプレビュー
            if "virtual_file" in tags:
                relative_path = filepath.relative_to(self.current_tree_root)
                if self._is_image_file(Path(relative_path)):
                    self._open_remote_image_for_preview(str(relative_path))
                else:
                    self._open_remote_file_for_editing(str(relative_path))
            elif filepath.is_file() and "virtual" not in tags:
                if self._is_image_file(filepath):
                    self._show_image_in_preview(filepath)
                else:
                    self.editor_open_file(filepath=filepath)
        except Exception as e:
            print(f"Error opening from tree: {e}")

    # ---------------------------
    # リモート画像プレビューのためのDL
    # ---------------------------
    def _open_remote_image_for_preview(self, remote_relative_path: str):
        if not self.current_session_name:
            messagebox.showerror("Error", "No active session selected.")
            return
        local_cache_dir = LOCAL_EDITING_CACHE / self.current_watcher_id / self.current_session_name / Path(remote_relative_path).parent
        local_cache_dir.mkdir(parents=True, exist_ok=True)
        local_cache_path = local_cache_dir / Path(remote_relative_path).name
        self.pending_download_info = {
            "remote_relative_path": remote_relative_path,
            "local_cache_path": local_cache_path,
            "mode": "preview",
        }
        command = f"_internal_stage_file_for_download::{remote_relative_path}"
        self._send_command_to_watcher(command)
        if self._log_fetch_timer:
            self.after_cancel(self._log_fetch_timer)
        self._fetch_log_updates()

    def _open_remote_file_for_editing(self, remote_relative_path: str):
        if not self.current_session_name:
            messagebox.showerror("Error", "No active session selected.")
            return
        for tab_data in self.tabs.values():
            if tab_data.get("remote_path") == remote_relative_path:
                self.editor_notebook.select(self.editor_notebook.tabs()[list(self.tabs.values()).index(tab_data)])
                return
        local_cache_dir = LOCAL_EDITING_CACHE / self.current_watcher_id / self.current_session_name / Path(remote_relative_path).parent
        local_cache_dir.mkdir(parents=True, exist_ok=True)
        local_cache_path = local_cache_dir / Path(remote_relative_path).name
        self.pending_download_info = {
            "remote_relative_path": remote_relative_path,
            "local_cache_path": local_cache_path,
            "mode": "edit",
        }
        command = f"_internal_stage_file_for_download::{remote_relative_path}"
        self._send_command_to_watcher(command)
        if self._log_fetch_timer:
            self.after_cancel(self._log_fetch_timer)
        self._fetch_log_updates()

    def _execute_pending_download(self):
        """ステージングされたファイルをrsyncでダウンロードし、モードに応じて処理"""
        if not self.pending_download_info:
            return
        info = self.pending_download_info
        self.pending_download_info = None
        remote_session_root = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}"
        remote_staged_file = f"{remote_session_root}/.staged_for_download"
        local_cache_path = info["local_cache_path"]
        try:
            self._run_sync_command(
                ["rsync", "-az", f"{REMOTE_SERVER}:{remote_staged_file}", str(local_cache_path)],
                check=True, timeout=10, capture_output=True
            )
        except subprocess.CalledProcessError as e:
            messagebox.showerror("Download Error", f"Failed to download staged file:\n{e.stderr.decode()}")
            return
        # 分岐：プレビュー or 編集
        if info.get("mode") == "preview":
            self._show_image_in_preview(local_cache_path, remote_path=info["remote_relative_path"])
        else:
            self.editor_open_file(filepath=local_cache_path, remote_path=info["remote_relative_path"])

    # ---------------------------
    # Watcher連携（log/poll）
    # ---------------------------
    def _send_command_to_watcher(self, command: str):
        """Watcherにコマンドを送信"""
        if not self.command_file:
            return
        try:
            commands = command if isinstance(command, list) else [command]
            self.command_file.parent.mkdir(parents=True, exist_ok=True)
            with self.command_file.open("a", encoding="utf-8") as f:
                for cmd in commands:
                    f.write(cmd + "\n")
            remote_session_dir = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}/"
            self._run_sync_command(["rsync", "-az", str(self.command_file), f"{REMOTE_SERVER}:{remote_session_dir}"], check=True, timeout=5)
        except Exception as e:
            self.terminal.append_log(f"[GUI] Failed to send command to watcher: {e}\n")

    def _fetch_log_updates(self):
        if self._log_fetch_timer:
            self.after_cancel(self._log_fetch_timer)
        if not self.current_watcher_id or not self.current_session_name:
            self._log_fetch_timer = self.after(LOG_FETCH_INTERVAL_MS, self._fetch_log_updates)
            return
        try:
            local_dir = LOCAL_SESSIONS_ROOT / self.current_watcher_id / self.current_session_name
            remote_log_path = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}/commands.log"
            self._run_sync_command(["rsync", "-az", f"{REMOTE_SERVER}:{remote_log_path}", str(local_dir)], timeout=5)
        except Exception as e: 
            print(f"Log sync failed: {e}")
            self._log_fetch_timer = self.after(LOG_FETCH_INTERVAL_MS, self._fetch_log_updates)
            return
        
        prompt_needs_update = False
        try:
            if self.log_file.exists():
                new_size = self.log_file.stat().st_size
                if new_size < self._log_pos:
                    self.terminal.view.config(state=tk.NORMAL)
                    self.terminal.view.delete("1.0", tk.END)
                    self._log_pos = 0
                if new_size > self._log_pos:
                    with self.log_file.open("r", encoding="utf-8", errors="replace") as f:
                        f.seek(self._log_pos)
                        new_text = f.read()
                        self._log_pos = f.tell()
                        lines_to_process = new_text.splitlines()
                        regular_output = []
                        for line in lines_to_process:
                            if line.startswith("__LS_DONE__::"):
                                if regular_output: self.terminal.append_log("\n".join(regular_output)); regular_output = []
                                _, rel_path = line.split("::", 1)
                                self._handle_ls_done(rel_path)
                            elif EOC_MARKER_PREFIX in line:
                                if regular_output: self.terminal.append_log("\n".join(regular_output)); regular_output = []
                                self._process_and_append_log(line)
                                prompt_needs_update = True
                            else:
                                regular_output.append(line)
                        if regular_output:
                            self.terminal.append_log("\n".join(regular_output))
        except Exception as e: 
            print(f"Log read failed: {e}")
    
        if prompt_needs_update:
            if self.pending_download_info:
                self._execute_pending_download()
            self.terminal._show_remote_prompt()
        else:
            self._log_fetch_timer = self.after(LOG_FETCH_INTERVAL_MS, self._fetch_log_updates)

    def _process_and_append_log(self, text: str):
        marker_found, display_text = False, text
        if EOC_MARKER_PREFIX in text:
            marker_found, display_text = True, text.split(EOC_MARKER_PREFIX, 1)[0]
        if display_text:
            self.terminal.append_log(display_text)
        if self.terminal.input_locked and marker_found:
            self.terminal.input_locked = False
            self.terminal.append_log("[GUI] Log cleared successfully. Input unlocked.\n")
            self.terminal.view.focus_set()
        return marker_found

    def _handle_ls_done(self, relative_path: str):
        """Watcher が出力した .ls_result.txt を取り込んで仮想展開"""
        try:
            session_root = LOCAL_SESSIONS_ROOT / self.current_watcher_id / self.current_session_name
            remote_ls_result_path = (
                f"{REMOTE_SESSIONS_PATH}/"
                f"{self.current_watcher_id}/"
                f"{self.current_session_name}/.ls_result.txt"
            )
            self._run_sync_command(
                ["rsync", "-az", f"{REMOTE_SERVER}:{remote_ls_result_path}", str(session_root)],
                check=True, timeout=5, capture_output=True
            )
            local_ls_result_file = session_root / ".ls_result.txt"
            if not local_ls_result_file.exists():
                return
            ls_content = local_ls_result_file.read_text(encoding="utf-8", errors="replace")
            if ls_content.startswith("ERROR:"):
                self.terminal.append_log(f"\n[GUI] Failed to list directory '{relative_path}':\n{ls_content}")
                return
            parent_abs = str(self.current_tree_root / relative_path)
            parent_iid = self.path_to_iid.get(parent_abs)
            if parent_iid:
                self._populate_virtual_tree(parent_iid, ls_content)
        except Exception as e:
            self.terminal.append_log(f"\n[GUI] Error processing directory listing for '{relative_path}': {e}")

    # ---------------------------
    # ターミナル／その他
    # ---------------------------
    def _copy_selection(self, event=None):
        try:
            selected_text = self.terminal.view.selection_get()
            self.clipboard_clear()
            self.clipboard_append(selected_text)
        except tk.TclError:
            pass
        return "break"

    def _show_context_menu(self, event):
        try:
            self.terminal.view.selection_get()
            self.terminal_context_menu.entryconfigure("Copy", state="normal")
        except tk.TclError:
            self.terminal_context_menu.entryconfigure("Copy", state="disabled")
        self.terminal_context_menu.tk_popup(event.x_root, event.y_root)

    # ---------------------------
    # エディタ（EditorView エイリアスの補助）
    # ---------------------------
    def _on_save_shortcut(self, event=None):
        self.editor_save_file(); return "break"
    
    def _toggle_comment(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try:
            start_index, end_index = editor_text.index("sel.first"), editor_text.index("sel.last")
            start_line, end_line = int(start_index.split('.')[0]), int(end_index.split('.')[0])
            if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
        except tk.TclError:
            start_line = end_line = int(editor_text.index("insert").split('.')[0])
        lines = range(start_line, end_line + 1)
        all_commented = all(
            editor_text.get(f"{l}.0", f"{l}.end").lstrip().startswith("#")
            for l in lines if editor_text.get(f"{l}.0", f"{l}.end").strip()
        )
        for l in lines:
            line_text = editor_text.get(f"{l}.0", f"{l}.end")
            if all_commented:
                if line_text.lstrip().startswith("# "):
                    editor_text.delete(f"{l}.{line_text.find('# ')}", f"{l}.{line_text.find('# ')+2}")
                elif line_text.lstrip().startswith("#"):
                    editor_text.delete(f"{l}.{line_text.find('#')}", f"{l}.{line_text.find('#')+1}")
            elif line_text.strip():
                editor_text.insert(f"{l}.{len(line_text) - len(line_text.lstrip())}", "# ")
        editor_text.tag_remove("sel", "1.0", "end"); editor_text.tag_add("sel", f"{start_line}.0", f"{end_line+1}.0")
        return "break"

    def _update_editor_title(self):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            self.editor_file_label.config(text="No file opened"); return
        filepath = tab_data.get("filepath"); remote_path = tab_data.get("remote_path")
        if remote_path:
            display_path = f"[REMOTE] {remote_path}"; filename = Path(remote_path).name
        else:
            display_path = str(filepath) if filepath else "Untitled"; filename = filepath.name if filepath else "Untitled"
        dirty_marker = "*" if tab_data["is_dirty"] else ""
        full_title = f"{filename}{dirty_marker}"
        self.editor_file_label.config(text=display_path)
        try:
            tab_id = self.editor_notebook.select()
            self.editor_notebook.tab(tab_id, text=full_title)
        except tk.TclError: pass

    # --- 検索バー（元コードと同等） ---
    def _show_search_bar(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        if not self.search_bar_visible:
            self.search_frame.pack(side=tk.RIGHT, padx=10, pady=0, fill=tk.Y)
            self.search_bar_visible = True
        entry = self.search_frame.winfo_children()[0]
        entry.focus_set()
        try:
            selected_text = editor_text.selection_get()
            if selected_text:
                self.search_var.set(selected_text); entry.icursor(tk.END); entry.xview_moveto(1.0)
        except tk.TclError: pass
        return "break"

    def _hide_search_bar(self, event=None):
        if self.search_bar_visible:
            self.search_frame.pack_forget()
            self.search_bar_visible = False
            self._clear_search_highlight()
            tab_data = self._get_current_tab_data()
            if tab_data: tab_data["text"].focus_set()
        return "break"

    def _perform_search(self):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        editor_text, marker_bar = tab_data["text"], tab_data["marker_bar"]
        self._clear_search_highlight()
        keyword = self.search_var.get()
        if not keyword: return
        count, start_index = tk.IntVar(), "1.0"
        total_lines = int(editor_text.index("end-1c").split('.')[0])
        canvas_height = marker_bar.winfo_height() if marker_bar else 0
        all_matches = []
        while True:
            pos = editor_text.search(keyword, start_index, stopindex=tk.END, count=count, nocase=True)
            if not pos: break
            end_pos = f"{pos}+{count.get()}c"
            all_matches.append(pos)
            editor_text.tag_add("search_highlight", pos, end_pos)
            start_index = end_pos
        if marker_bar and total_lines > 0 and canvas_height > 0:
            for pos in all_matches:
                line_num = int(pos.split('.')[0])
                y_pos = (line_num / total_lines) * canvas_height
                marker_bar.create_rectangle(0, y_pos, 10, y_pos + 2, fill="#D8A01D", outline="")

    def _clear_search_highlight(self):
        for tab_data in self.tabs.values():
            try:
                tab_data["text"].tag_remove("search_highlight", "1.0", tk.END)
                if tab_data["marker_bar"]: tab_data["marker_bar"].delete("all")
            except Exception: pass

    def _find_next(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        keyword = self.search_var.get()
        if not keyword: return "break"
        start_pos = editor_text.index(f"{tk.INSERT}+1c")
        pos = editor_text.search(keyword, start_pos, stopindex=tk.END, nocase=True)
        if not pos: pos = editor_text.search(keyword, "1.0", stopindex=tk.END, nocase=True)
        if pos:
            end_pos = f"{pos}+{len(keyword)}c"
            editor_text.tag_remove(tk.SEL, "1.0", tk.END)
            editor_text.tag_add(tk.SEL, pos, end_pos)
            editor_text.mark_set(tk.INSERT, pos)
            editor_text.see(pos); editor_text.focus_set()
        return "break"

    def _find_prev(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        keyword = self.search_var.get()
        if not keyword: return "break"
        start_pos = editor_text.index(tk.INSERT)
        pos = editor_text.search(keyword, start_pos, stopindex="1.0", backwards=True, nocase=True)
        if not pos: pos = editor_text.search(keyword, tk.END, stopindex="1.0", backwards=True, nocase=True)
        if pos:
            end_pos = f"{pos}+{len(keyword)}c"
            editor_text.tag_remove(tk.SEL, "1.0", tk.END)
            editor_text.tag_add(tk.SEL, pos, end_pos)
            editor_text.mark_set(tk.INSERT, pos)
            editor_text.see(pos); editor_text.focus_set()
        return "break"

    # --- インデント/行操作/補完（元コード同等） ---
    def _bind_global_keys(self):
        self.bind_all("<Escape>", self._hide_search_bar)
        if sys.platform == "darwin":
            self.bind_all("<Command-f>", self._show_search_bar)
            self.bind_all("<Command-s>", self._on_save_shortcut)
            self.bind_all("<Command-Shift-s>", self.editor_save_file_as)
        else:
            self.bind_all("<Control-f>", self._show_search_bar)
            self.bind_all("<Control-s>", self._on_save_shortcut)
            self.bind_all("<Control-Shift-S>", self.editor_save_file_as)

    def _handle_editor_focus_in(self, event=None):
        if self.completion_popup:
            self._destroy_completion_popup()

    def _bind_editor_keys(self, editor_text):
        editor_text.bind("<FocusIn>", self._handle_editor_focus_in)
        editor_text.bind("<<Modified>>", self._on_editor_modified)
        editor_text.bind("<KeyRelease>", self._on_selection_changed)
        editor_text.bind("<ButtonRelease-1>", self._on_selection_changed)
        editor_text.bind("<Tab>", self._on_tab_key)
        editor_text.bind("<Shift-Tab>", self._on_shift_tab_key)
        editor_text.bind("<Return>", self._on_editor_return)
        if sys.platform == "darwin":
            editor_text.bind("<Command-slash>", self._toggle_comment)
            editor_text.bind("<Command-d>", self._editor_delete_line)
            editor_text.bind("<Option-Up>", self._editor_move_line_up)
            editor_text.bind("<Option-Down>", self._editor_move_line_down)
        else:
            editor_text.bind("<Control-slash>", self._toggle_comment)
            editor_text.bind("<Control-d>", self._editor_delete_line)
            editor_text.bind("<Alt-Up>", self._editor_move_line_up)
            editor_text.bind("<Alt-Down>", self._editor_move_line_down)

    def _editor_delete_line(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        if not editor_text.get("1.0", "end-1c"): return "break"
        editor_text.delete("insert linestart", "insert +1l linestart")
        return "break"

    def _editor_move_line_up(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try:
            start_index = editor_text.index("sel.first"); end_index = editor_text.index("sel.last")
            start_line = int(start_index.split('.')[0]); end_line = int(end_index.split('.')[0])
            if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
        except tk.TclError:
            start_index = editor_text.index("insert"); start_line = end_line = int(start_index.split('.')[0])
        if start_line <= 1: return "break"
        move_block_start, move_block_end = f"{start_line}.0", f"{end_line + 1}.0"
        move_content = editor_text.get(move_block_start, move_block_end)
        if not move_content.endswith('\n'): move_content += '\n'
        prev_line_start, prev_line_end = f"{start_line - 1}.0", f"{start_line}.0"
        prev_content = editor_text.get(prev_line_start, prev_line_end)
        editor_text.delete(prev_line_start, move_block_end)
        editor_text.insert(prev_line_start, move_content + prev_content)
        new_start, new_end = prev_line_start, f"{end_line}.0"
        editor_text.tag_add("sel", new_start, new_end); editor_text.mark_set("insert", new_start)
        return "break"

    def _editor_move_line_down(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try:
            start_index = editor_text.index("sel.first"); end_index = editor_text.index("sel.last")
            start_line = int(start_index.split('.')[0]); end_line = int(end_index.split('.')[0])
            if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
        except tk.TclError:
            start_index = editor_text.index("insert"); start_line = end_line = int(start_index.split('.')[0])
        last_line = int(editor_text.index("end-1c").split('.')[0])
        if end_line >= last_line: return "break"
        move_block_start, move_block_end = f"{start_line}.0", f"{end_line + 1}.0"
        move_content = editor_text.get(move_block_start, move_block_end)
        if not move_content.endswith('\n'): move_content += '\n'
        next_line_start, next_line_end = f"{end_line + 1}.0", f"{end_line + 2}.0"
        next_content = editor_text.get(next_line_start, next_line_end)
        editor_text.delete(move_block_start, next_line_end)
        editor_text.insert(move_block_start, next_content + move_content)
        new_start, new_end = f"{start_line + 1}.0", f"{end_line + 2}.0"
        editor_text.tag_add("sel", new_start, new_end); editor_text.mark_set("insert", new_start)
        return "break"

    def _on_selection_changed(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        if tab_data["selection_timer"]: self.after_cancel(tab_data["selection_timer"])
        tab_data["selection_timer"] = self.after(200, self._update_selection_highlights)

    def _update_selection_highlights(self):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        editor_text, marker_bar = tab_data["text"], tab_data["marker_bar"]
        marker_bar.delete("selection_marker")
        editor_text.tag_remove("selection_match_highlight", "1.0", tk.END)
        editor_text.tag_configure("sel", background=self.SELECT_BG, foreground=self.SELECT_FG)
        try:
            selected_text = editor_text.selection_get()
        except tk.TclError: return
        if not selected_text or selected_text.isspace() or len(selected_text) < 2: return
        editor_text.tag_configure("sel", background="#4A4A4A", foreground=self.SELECT_FG)
        total_lines = int(editor_text.index("end-1c").split('.')[0])
        canvas_height = marker_bar.winfo_height()
        if total_lines == 0: return
        start_index = "1.0"
        while True:
            pos = editor_text.search(selected_text, start_index, stopindex=tk.END, exact=True)
            if not pos: break
            end_pos = f"{pos}+{len(selected_text)}c"
            if canvas_height > 0:
                y_pos = (int(pos.split('.')[0]) / total_lines) * canvas_height
                marker_bar.create_rectangle(0, y_pos, 10, y_pos + 2, fill="#6A9ECF", outline="", tags="selection_marker")
            if not editor_text.compare(pos, "==", "sel.first"):
                editor_text.tag_add("selection_match_highlight", pos, end_pos)
            start_index = end_pos

    def _on_marker_bar_click(self, event):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        editor_text, marker_bar = tab_data["text"], tab_data["marker_bar"]
        try:
            canvas_height = marker_bar.winfo_height()
            total_lines = int(editor_text.index("end-1c").split('.')[0])
            if canvas_height == 0 or total_lines == 0: return
            click_fraction = event.y / canvas_height
            target_line = max(1, int(total_lines * click_fraction))
            target_index = f"{target_line}.0"
            editor_text.see(target_index)
            editor_text.mark_set(tk.INSERT, target_index); editor_text.focus_set()
        except (tk.TclError, ValueError): pass

    def _on_tab_key(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        if self.completion_popup: return "break"
        try:
            start_index = editor_text.index("sel.first"); end_index = editor_text.index("sel.last")
            start_line = int(start_index.split('.')[0]); end_line = int(end_index.split('.')[0])
            if start_line != end_line:
                if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
                for line in range(start_line, end_line + 1): editor_text.insert(f"{line}.0", INDENT_STRING)
                return "break"
        except tk.TclError: pass
        text_before_cursor = editor_text.get("insert linestart", "insert")
        if not text_before_cursor.strip(): editor_text.insert(tk.INSERT, INDENT_STRING)
        else: self._perform_completion()
        return "break"

    def _on_shift_tab_key(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try:
            start_index = editor_text.index("sel.first"); end_index = editor_text.index("sel.last")
            start_line = int(start_index.split('.')[0]); end_line = int(end_index.split('.')[0])
            if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
        except tk.TclError:
            start_line = end_line = int(editor_text.index(tk.INSERT).split('.')[0])
        for line in range(start_line, end_line + 1):
            line_start, line_end = f"{line}.0", f"{line}.end"
            line_text = editor_text.get(line_start, line_end)
            if line_text.startswith(INDENT_STRING): editor_text.delete(line_start, f"{line_start}+{INDENT_WIDTH}c")
            elif line_text.startswith("\t"): editor_text.delete(line_start, f"{line_start}+1c")
            elif line_text and line_text[0].isspace():
                space_count = len(line_text) - len(line_text.lstrip(' '))
                to_delete = min(INDENT_WIDTH, space_count)
                if to_delete > 0: editor_text.delete(line_start, f"{line_start}+{to_delete}c")
        return "break"

    def _on_editor_return(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try: editor_text.delete("sel.first", "sel.last")
        except tk.TclError: pass
        cursor_pos = editor_text.index(tk.INSERT)
        line_start = f"{cursor_pos} linestart"
        prev_line_full_text = editor_text.get(line_start, f"{line_start} lineend")
        match = re.match(r'^(\s*)', prev_line_full_text)
        current_indent = match.group(1) if match else ""
        next_indent = current_indent
        if prev_line_full_text.strip().endswith(':'): next_indent += INDENT_STRING
        editor_text.insert(tk.INSERT, f"\n{next_indent}")
        editor_text.see(tk.INSERT)
        return "break"

    def _perform_completion(self):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        editor_text = tab_data["text"]
        try:
            text_before_cursor = editor_text.get("1.0", "insert")
            prefix_match = re.search(r'[\w\.]*$', text_before_cursor)
            prefix = prefix_match.group(0) if prefix_match else ""
            if not prefix: return
            words = re.findall(r'[\w\.]+', editor_text.get("1.0", "end-1c"))
            seen, unique_candidates = set(), []
            for word in words:
                if word.startswith(prefix) and word != prefix and word not in seen:
                    seen.add(word); unique_candidates.append(word)
            if not unique_candidates: return
            if len(unique_candidates) == 1:
                suffix = unique_candidates[0][len(prefix):]
                editor_text.insert("insert", suffix)
            else: self._create_completion_popup(unique_candidates, len(prefix))
        except Exception as e: print(f"Completion error: {e}")

    def _create_completion_popup(self, candidates, prefix_len):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        editor_text = tab_data["text"]
        self._destroy_completion_popup()
        x, y, _, height = editor_text.bbox(tk.INSERT)
        screen_x, screen_y = editor_text.winfo_rootx() + x, editor_text.winfo_rooty() + y + height
        self.completion_popup = tk.Toplevel(self)
        self.completion_popup.overrideredirect(True)
        self.completion_popup.geometry(f"+{screen_x}+{screen_y}")
        listbox = tk.Listbox(
            self.completion_popup, bg=self.TEXT_BG, fg=self.TEXT_FG, selectbackground=self.SELECT_BG,
            selectforeground=self.SELECT_FG, highlightthickness=1, highlightbackground=self.BORDER_CLR, exportselection=False
        )
        listbox.pack(fill=tk.BOTH, expand=True)
        for item in candidates: listbox.insert(tk.END, item)
        listbox.selection_set(0); listbox.see(0)
        listbox.bind("<Return>", lambda e: self._on_completion_select(e, prefix_len))
        listbox.bind("<Tab>", lambda e: self._on_completion_select(e, prefix_len))
        listbox.bind("<Double-Button-1>", lambda e: self._on_completion_select(e, prefix_len))
        listbox.bind("<Escape>", lambda e: self._destroy_completion_popup())
        listbox.focus_set()

    def _on_completion_select(self, event, prefix_len):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        widget = event.widget
        if not widget.curselection():
            self._destroy_completion_popup(); return "break"
        selection = widget.get(widget.curselection()); suffix = selection[prefix_len:]
        editor_text.insert("insert", suffix)
        editor_text.focus_set() 
        self._destroy_completion_popup()
        return "break"

    def _destroy_completion_popup(self):
        tab_data = self._get_current_tab_data()
        if self.completion_popup:
            self.completion_popup.destroy(); self.completion_popup = None
        if tab_data: self.after_idle(tab_data["text"].focus_set)
    
    # ---------------------------
    # Preferences（フォント設定）
    # ---------------------------
    def _apply_font_prefs(self):
        """prefs に基づき、エディタ／行番号／ターミナルのフォントを即時適用。
        行番号はエディタと同じ Font オブジェクトを共有させて連動させる。
        """
        ed_family = self.prefs["editor_family"]; ed_size = int(self.prefs["editor_size"])
        tm_family = self.prefs["term_family"];   tm_size = int(self.prefs["term_size"])
    
        # 新規タブの既定（既存実装を尊重）
        self.mono_font = (ed_family, ed_size)
    
        try:
            for tab_data in getattr(self, "tabs", {}).values():
                text = tab_data.get("text")
                ln   = tab_data.get("line_numbers")
                if not text:
                    continue
    
                f = tab_data.get("shared_font")
                if not isinstance(f, tkfont.Font):
                    try:
                        f = tkfont.Font(font=text.cget("font"))
                    except Exception:
                        f = tkfont.Font(family=ed_family, size=ed_size)
                    tab_data["shared_font"] = f  # 以後はこれを共有して使う
    
                # 家族とサイズを更新（同じ f を行番号にも適用して連動）
                f.configure(family=ed_family, size=ed_size)
                text.configure(font=f)
                if ln:
                    ln.configure(font=f)
    
        except Exception:
            pass
    
        # ターミナルに反映
        try:
            if self.terminal and getattr(self.terminal, "view", None):
                tv = self.terminal.view
                tf = tkfont.Font(font=tv.cget("font"))
                tf.configure(family=tm_family, size=tm_size)
                tv.configure(font=tf)
        except Exception:
            pass

    def open_preferences(self):
        """設定ダイアログを開く"""
        dlg = tk.Toplevel(self)
        dlg.title("Preferences")
        dlg.configure(bg=self.BG_COLOR)
        dlg.transient(self); dlg.grab_set()
        frm = ttk.Frame(dlg, style="Dark.TFrame", padding=14)
        frm.pack(fill=tk.BOTH, expand=True)

        fams = sorted(set(tkfont.families()))
        # よく使う等幅の候補を前に
        prefer = ["Menlo", "Consolas", "Courier New", "Monaco"]
        fams = prefer + [f for f in fams if f not in prefer]

        ed_family = tk.StringVar(value=self.prefs["editor_family"])
        ed_size   = tk.IntVar(value=int(self.prefs["editor_size"]))
        tm_family = tk.StringVar(value=self.prefs["term_family"])
        tm_size   = tk.IntVar(value=int(self.prefs["term_size"]))

        # Editor
        ttk.Label(frm, text="Editor Font", style="Dark.TLabel").grid(row=0, column=0, sticky="w")
        ed_cb = ttk.Combobox(frm, values=fams, textvariable=ed_family, width=30, state="readonly", style="Dark.TCombobox")
        ed_cb.grid(row=0, column=1, sticky="ew", padx=(8,0))
        ed_sp = ttk.Spinbox(frm, from_=8, to=48, textvariable=ed_size, width=5, style="Dark.TSpinbox")
        ed_sp.grid(row=0, column=2, padx=(8,0))

        # Terminal
        ttk.Label(frm, text="Terminal Font", style="Dark.TLabel").grid(row=1, column=0, sticky="w", pady=(8,0))
        tm_cb = ttk.Combobox(frm, values=fams, textvariable=tm_family, width=30, state="readonly", style="Dark.TCombobox")
        tm_cb.grid(row=1, column=1, sticky="ew", padx=(8,0), pady=(8,0))
        tm_sp = ttk.Spinbox(frm, from_=8, to=48, textvariable=tm_size, width=5, style="Dark.TSpinbox")
        tm_sp.grid(row=1, column=2, padx=(8,0), pady=(8,0))

        frm.grid_columnconfigure(1, weight=1)

        # Buttons
        btns = ttk.Frame(frm, style="Dark.TFrame")
        btns.grid(row=3, column=0, columnspan=3, sticky="e", pady=(12,0))
        def do_apply():
            self.prefs.update({
                "editor_family": ed_family.get(),
                "editor_size":   int(ed_size.get()),
                "term_family":   tm_family.get(),
                "term_size":     int(tm_size.get()),
            })
            self._apply_font_prefs()

        def do_save_close():
            do_apply()
            # save state
            try:
                self._save_state()
            except Exception:
                pass
            dlg.destroy()

        ttk.Button(btns, text="Apply", style="Dark.TButton", command=do_apply).pack(side=tk.RIGHT)
        ttk.Button(btns, text="Save & Close", style="Dark.TButton", command=do_save_close).pack(side=tk.RIGHT, padx=(8,0))
        ttk.Button(btns, text="Cancel", style="Dark.TButton", command=dlg.destroy).pack(side=tk.RIGHT, padx=(8,0))

class DirectoryPicker(tk.Toplevel):
    def __init__(self, parent, title="Select directory", initialdir=None,
                 show_hidden=False, shortcuts=None, geometry="720x520"):
        super().__init__(parent)
        self.title(title)
        self.result = None
        self.parent = parent
        self.configure(bg=getattr(parent, "BG_COLOR", self.cget("bg")))
        self.transient(parent)
        self.grab_set()

        # 中央に配置
        self.update_idletasks()
        if geometry:
            self.geometry(geometry)
        x = parent.winfo_rootx() + (parent.winfo_width()//2 - self.winfo_width()//2)
        y = parent.winfo_rooty() + (parent.winfo_height()//2 - self.winfo_height()//2)
        self.geometry(f"+{max(0,x)}+{max(0,y)}")

        # 初期パス
        self.cur_path = Path(initialdir or Path.home()).expanduser().resolve()
        self.show_hidden = tk.BooleanVar(value=show_hidden)

        # クイックアクセス
        self.shortcuts = shortcuts or [
            ("Home", Path.home()),
            ("Sessions", globals().get("LOCAL_SESSIONS_ROOT", Path.home())),
            ("Base", globals().get("LOCAL_BASE_DIR", Path.home())),
        ]

        # --------- UI ---------
        outer = ttk.Frame(self, padding=10, style="Dark.TFrame")
        outer.pack(fill=tk.BOTH, expand=True)

        # パスバー
        bar = ttk.Frame(outer, style="Dark.TFrame")
        bar.pack(fill=tk.X)
        ttk.Label(bar, text="Path:", style="Dark.TLabel").pack(side=tk.LEFT)
        self.path_var = tk.StringVar()
        path_entry = ttk.Entry(bar, textvariable=self.path_var, state="readonly",
                               style="Dark.TEntry")
        path_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=8)
        ttk.Button(bar, text="Up", width=4, style="Dark.TButton",
                   command=self._go_up).pack(side=tk.LEFT)

        body = ttk.Frame(outer, style="Dark.TFrame")
        body.pack(fill=tk.BOTH, expand=True, pady=(8,0))

        # 左：ショートカット
        left = ttk.Frame(body, style="Dark.TFrame")
        left.pack(side=tk.LEFT, fill=tk.Y)
        ttk.Label(left, text="Quick Access", style="Dark.TLabel").pack(anchor="w")
        self.sc_list = tk.Listbox(left, height=8)
        self.sc_list.pack(fill=tk.Y, expand=False, pady=(4,0))
        for i, (name, p) in enumerate(self.shortcuts):
            self.sc_list.insert(i, f"{name}  —  {str(p)}")
        self.sc_list.bind("<<ListboxSelect>>", self._on_shortcut)

        # 右：ツリービュー
        right = ttk.Frame(body, style="Dark.TFrame")
        right.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(10,0))

        cols = ("name", "mtime", "items")
        self.tree = ttk.Treeview(right, columns=cols, show="headings",
                                 style="Dark.Treeview")
        self.tree.heading("name", text="Name")
        self.tree.heading("mtime", text="Modified")
        self.tree.heading("items", text="Items")
        self.tree.column("name", width=400, anchor="w")
        self.tree.column("mtime", width=160, anchor="center")
        self.tree.column("items", width=80, anchor="e")
        self.tree.pack(fill=tk.BOTH, expand=True)
        self.tree.bind("<Double-1>", self._on_open)
        self.tree.bind("<<TreeviewSelect>>", lambda e: None)

        # 下：操作列
        bottom = ttk.Frame(outer, style="Dark.TFrame")
        bottom.pack(fill=tk.X, pady=(8,0))
        ttk.Checkbutton(bottom, text="Show hidden", variable=self.show_hidden,
                        command=self._refresh, style="Dark.TCheckbutton").pack(side=tk.LEFT)
        btns = ttk.Frame(bottom, style="Dark.TFrame")
        btns.pack(side=tk.RIGHT)
        ttk.Button(btns, text="Cancel", style="Dark.TButton",
                   command=self._cancel).pack(side=tk.RIGHT)
        ttk.Button(btns, text="Select", style="Dark.TButton",
                   command=self._select).pack(side=tk.RIGHT, padx=(8,0))

        self._refresh()

        # ESC / Enter
        self.bind("<Escape>", lambda e: self._cancel())
        self.bind("<Return>", lambda e: self._select())

    # ---- helpers ----
    def _go_up(self):
        parent = self.cur_path.parent
        if parent != self.cur_path:
            self.cur_path = parent
            self._refresh()

    def _on_shortcut(self, _e):
        sel = self.sc_list.curselection()
        if not sel:
            return
        _, p = self.shortcuts[sel[0]]
        try:
            self.cur_path = Path(p).expanduser().resolve()
        except Exception:
            self.cur_path = Path.home()
        self._refresh()

    def _on_open(self, _e):
        item = self.tree.focus()
        if not item:
            return
        target = Path(self.tree.set(item, "name"))
        # 絶対化
        target = (self.cur_path / target.name) if not target.is_absolute() else target
        if target.is_dir():
            self.cur_path = target
            self._refresh()

    def _refresh(self):
        self.path_var.set(str(self.cur_path))
        for i in self.tree.get_children():
            self.tree.delete(i)
        try:
            entries = []
            with os.scandir(self.cur_path) as it:
                for e in it:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    if not self.show_hidden.get() and e.name.startswith("."):
                        continue
                    try:
                        mtime = time.strftime("%Y-%m-%d %H:%M",
                                              time.localtime(e.stat().st_mtime))
                    except Exception:
                        mtime = "-"
                    try:
                        items = len([_ for _ in os.scandir(e.path)])
                    except Exception:
                        items = "-"
                    entries.append((e.name, mtime, items))
            # 名前でソート
            for name, mtime, items in sorted(entries, key=lambda x: x[0].lower()):
                self.tree.insert("", "end", values=(name, mtime, items))
        except Exception as ex:
            messagebox.showerror("Error", f"Cannot list: {self.cur_path}\n{ex}", parent=self)

    def _select(self):
        # 選択がなければ現在フォルダを返す
        item = self.tree.focus()
        if item:
            name = self.tree.set(item, "name")
            self.result = str((self.cur_path / name).resolve())
        else:
            self.result = str(self.cur_path)
        self.destroy()

    def _cancel(self):
        self.result = None
        self.destroy()

    def show(self):
        self.wait_window(self)
        return self.result


# ---------------------------
# 起動
# ---------------------------
if __name__ == "__main__":
    app = IntegratedGUI()
    app.mainloop()