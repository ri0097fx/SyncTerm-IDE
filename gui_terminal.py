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
"""
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

from pygments import lex
from pygments.lexers import guess_lexer_for_filename, get_lexer_by_name
from pygments.token import Token


import configparser

# ====== 設定ファイルの読み込み ======
config = configparser.ConfigParser()
config.read(Path(__file__).resolve().parent / "config.ini")

remote_config = config["remote"]
local_paths_config = config["local_paths"]
structure_config = config["structure"]

# ====== パス設定（設定ファイルから読み込むように変更） ======
# os.path.expanduserを使って '~' をホームディレクトリに展開
LOCAL_BASE_DIR = Path(os.path.expanduser(local_paths_config.get("gui_mirror_dir", "~/gui_local_mirror"))).resolve()
LOCAL_SESSIONS_ROOT = (LOCAL_BASE_DIR / structure_config.get("sessions_dir_name", "sessions")).resolve()
LOCAL_REGISTRY_DIR = (LOCAL_BASE_DIR / structure_config.get("registry_dir_name", "_registry")).resolve()

# リモートサーバーの情報
REMOTE_SERVER = remote_config.get("server")
REMOTE_BASE_PATH = remote_config.get("base_path")
REMOTE_SESSIONS_PATH = f"{REMOTE_BASE_PATH}/{structure_config.get('sessions_dir_name', 'sessions')}"
REMOTE_REGISTRY_PATH = f"{REMOTE_BASE_PATH}/{structure_config.get('registry_dir_name', '_registry')}/"


# GUI自体の設定ファイルパス
GUI_CONFIG_DIR = Path(__file__).resolve().parent
THEME_JSON_PATH = (GUI_CONFIG_DIR / "theme.json").resolve()
# --- 追加: 状態保存ファイル ---
STATE_JSON_PATH = (GUI_CONFIG_DIR / "session_state.json").resolve()

# ====== 設定 ======
BG_OVERRIDE = None
LOG_FETCH_INTERVAL_MS = 1000
WATCHER_DISCOVERY_INTERVAL_MS = 3000
EOC_MARKER_PREFIX = "__CMD_EXIT_CODE__::"

INIT_TAIL_LINES = 500
MAX_TERMINAL_LINES = 5000
REHIGHLIGHT_DELAY_MS = 500
LINE_NUMBER_UPDATE_DELAY_MS = 100
WATCHER_HEARTBEAT_TIMEOUT_SEC = 30

INDENT_WIDTH = 4
INDENT_STRING = " " * INDENT_WIDTH

COMBO_BG = "#2A343F"
COMBO_FG = "white"
COMBO_SEL_BG = "#285577"
COMBO_SEL_FG = "white"

SCROLLBAR_THUMB_COLOR = "#788494"


def load_spyder_theme(path: Path, bg_override: str | None = None):
    if not path.exists():
        raise FileNotFoundError(f"theme.json が見つからない: {path}")
    try:
        content = path.read_text(encoding="utf-8")
        content = re.sub(r'//.*', '', content)
        data = json.loads(content)
    except Exception as e:
        raise ValueError(f"theme.json の形式が不正: {e}")
    ui, hl_str = data["ui"], data["hl"]
    if bg_override:
        ui["BG_COLOR"] = ui["TEXT_BG"] = bg_override
    def tok(k: str):
        t = Token
        for part in k.split(".")[1:]:
            t = getattr(t, part)
        return t
    hl = {tok(k): v for k, v in hl_str.items()}
    base = hl.get(Token, ui.get("TEXT_FG", "#ffffff"))
    hl[Token.Operator] = base; hl[Token.Punctuation] = base
    ui["PANEL_BG"] = ui["BG_COLOR"]
    return ui, hl

class IntegratedGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.is_loading = True
        self.title("Integrated Terminal & Editor (Multi-Watcher Control Panel)")
        self.geometry("1400x820")

        try:
            self.UI_COLORS, self.HL = load_spyder_theme(THEME_JSON_PATH, BG_OVERRIDE)
        except Exception as e:
            messagebox.showerror("Theme Error", f"テーマの読み込みに失敗:\n{e}")
            sys.exit(1)
        
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
        style.configure("Dark.TEntry", fieldbackground=COMBO_BG, foreground=COMBO_FG)
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
        
        def _make_cross_img(px=10, thickness=2, color="#D9DEE7"):
            img = tk.PhotoImage(master=self, width=px, height=px)  # 透明で生成
            half = thickness // 2
            def put(x, y):
                if 0 <= x < px and 0 <= y < px:
                    img.put(color, (x, y))
            for i in range(px):
                for o in range(-half, half + 1):
                    put(i, i + o)                 # 主対角線
                    put(i, (px - 1 - i) + o)      # 反対角線
            return img
        
        CLOSE_COLOR_DEFAULT = "#D9DEE7"  # グレー
        CLOSE_COLOR_HOVER   = "#66A8FF"  # ホバー(青め)
        CLOSE_COLOR_PRESSED = "#3D8CFF"  # 押下(濃いめの青)
        
        ICON_SIZE = 9     # 9～12 くらいがバランス良い
        ICON_THICK = 2     # 線の太さ（1 or 2）
        
        self.close_btn_images = {
            "default": _make_cross_img(ICON_SIZE, ICON_THICK, CLOSE_COLOR_DEFAULT),
            "hover":   _make_cross_img(ICON_SIZE, ICON_THICK, CLOSE_COLOR_HOVER),
            "pressed": _make_cross_img(ICON_SIZE, ICON_THICK, CLOSE_COLOR_PRESSED),
        }
        
        # Notebook 用のカスタム要素を再作成
        try:
            style.element_create(
                "close", "image",
                self.close_btn_images["default"],
                ("active",  self.close_btn_images["hover"]),
                ("pressed", self.close_btn_images["pressed"]),
                border=5,      # 左の余白。大きすぎ/小さすぎなら 4～6 で微調整
                sticky=""
            )
        except tk.TclError:
            pass


        
        style.layout("Closable.TNotebook", [
            ("Notebook.client", {"sticky": "nswe"})
        ])
        
        style.layout("Closable.TNotebook.Tab", [
            ("Notebook.tab", {
                "sticky": "nswe",
                "children": [
                    ("Notebook.padding", {
                        "side": "top",
                        "sticky": "nswe",
                        "children": [
                            ("Notebook.focus", {
                                "side": "top",
                                "sticky": "nswe",
                                "children": [
                                    ("close", {"side": "left", "sticky": ''}),   # ← ここで close 要素を配置
                                    ("Notebook.label", {"side": "left", "sticky": ''}),
                                ]
                            })
                        ]
                    })
                ]
            })
        ])

        style.configure("TNotebook", background=self.BG_COLOR, borderwidth=0)
        style.configure("TNotebook.Tab", background=self.BG_COLOR, foreground=self.TEXT_FG, borderwidth=1, padding=[10, 4])
        style.map("TNotebook.Tab", background=[("selected", COMBO_BG)], foreground=[("selected", COMBO_SEL_FG)])
        
        # State variables
        self.watchers = {}; self.current_watcher_id = None; self.current_session_name = None
        self.command_file = None; self.log_file = None; self.status_file = None
        self.history = []; self.history_idx = -1
        self.auto_scroll = tk.BooleanVar(value=True)
        self.input_locked = False
        self._log_fetch_timer = None
        self._log_pos = 0
        self.sync_indicator_label = None
        self.file_tree = None
        self.path_to_iid = {}
        self.terminal_mode = tk.StringVar(value="Remote")
        self.local_cwd = Path.cwd()
        self.current_tree_root = None
        self.editor_notebook = None
        self.tabs = {}
        self.search_frame = None
        self.search_bar_visible = False
        self.search_var = tk.StringVar()
        self.completion_popup = None
        self.terminal_context_menu = tk.Menu(self, tearoff=0)
        self.terminal_context_menu.add_command(label="Copy", command=self._copy_selection)
        
        self._create_widgets()
        self._bind_global_keys()

        LOCAL_SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
        
        self._load_state()
        self._update_watcher_list()
        self.protocol("WM_DELETE_WINDOW", self._on_closing)
        self.is_loading = False

    def _save_state(self):
        open_files = [str(data["filepath"]) for data in self.tabs.values() if data["filepath"]]
        active_file = None
        current_tab_data = self._get_current_tab_data()
        if current_tab_data and current_tab_data["filepath"]:
            active_file = str(current_tab_data["filepath"])
        
        state_data = {
            "open_files": open_files,
            "active_file": active_file,
            "last_tree_root": str(self.current_tree_root) if self.current_tree_root else None
        }
        try:
            state_data["main_sash_pos"] = self.main_pane.sashpos(0)
            state_data["editor_sash_pos"] = self.editor_pane.sashpos(0)
        except tk.TclError:
            pass
        try:
            with open(STATE_JSON_PATH, "w", encoding="utf-8") as f:
                json.dump(state_data, f, indent=2)
        except Exception as e:
            print(f"Failed to save session state: {e}")

    def _load_state(self):
        if not STATE_JSON_PATH.exists():
            self.after(100, self._set_initial_sash_position)
            self._create_new_tab()
            return
    
        sash_positions_loaded = False
        try:
            with open(STATE_JSON_PATH, "r", encoding="utf-8") as f:
                state_data = json.load(f)
    
            last_tree_root = state_data.get("last_tree_root")
            if last_tree_root and Path(last_tree_root).is_dir():
                self._populate_file_tree(Path(last_tree_root))
    
            open_files = state_data.get("open_files", [])
            if not open_files:
                self._create_new_tab()
            else:
                for file_path_str in open_files:
                    file_path = Path(file_path_str)
                    if file_path.is_file():
                        self.editor_open_file(filepath=file_path)
    
            active_file = state_data.get("active_file")
            if active_file:
                for tab_id, data in self.tabs.items():
                    if data["filepath"] and str(data["filepath"]) == active_file:
                        self.editor_notebook.select(tab_id)
                        break
    
            main_sash_pos = state_data.get("main_sash_pos")
            editor_sash_pos = state_data.get("editor_sash_pos")
    
            if main_sash_pos is not None and editor_sash_pos is not None:
                
                def apply_sashes_on_configure(event):
                    # イベントの解除は最初に行う
                    self.unbind("<Configure>")
                    
                    def apply_sash_positions_finally():
                        try:
                            # ★ 変更点1: sash_place から sashpos に変更
                            self.main_pane.sashpos(0, main_sash_pos)
                            self.editor_pane.sashpos(0, editor_sash_pos)
                        except tk.TclError:
                            pass
                    
                    # ★ 変更点2: <Configure>イベントの後、さらにごく僅かな遅延を入れる
                    # これにより、ペイン自体のサイズ計算を待つ
                    self.after(10, apply_sash_positions_finally)
    
                self.bind("<Configure>", apply_sashes_on_configure, "+")
                sash_positions_loaded = True
    
        except (json.JSONDecodeError, FileNotFoundError, Exception) as e:
            print(f"Failed to load session state: {e}")
            self._create_new_tab()
    
        if not sash_positions_loaded:
            self.after(100, self._set_initial_sash_position)

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

    def _show_sync_indicator(self):
        self.sync_indicator_label.config(text="Syncing...")

    def _hide_sync_indicator(self):
        self.sync_indicator_label.config(text="")

    def _run_sync_command(self, cmd_list, **kwargs):
        self._show_sync_indicator()
        self.update_idletasks()
        try:
            return subprocess.run(cmd_list, **kwargs)
        finally:
            self._hide_sync_indicator()
    
    def _update_watcher_list(self):
        try:
            LOCAL_REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
            self._run_sync_command(
                ["rsync", "-az", "--delete", f"{REMOTE_SERVER}:{REMOTE_REGISTRY_PATH}", f"{str(LOCAL_REGISTRY_DIR)}/"],
                check=True, capture_output=True, timeout=5
            )
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            return

        online_watchers = {}
        now = time.time()
        for reg_file in LOCAL_REGISTRY_DIR.glob('*'):
            if not reg_file.is_file() or reg_file.name.startswith('.'): 
                continue
            try:
                data = json.loads(reg_file.read_text("utf-8"))
                if (now - data.get("last_heartbeat", 0)) < WATCHER_HEARTBEAT_TIMEOUT_SEC:
                    display_name = data.get("display_name", reg_file.name)
                    online_watchers[display_name] = {"id": reg_file.name}
            except (json.JSONDecodeError, KeyError):
                continue
        
        self.watchers = online_watchers
        current_selection = self.watcher_combo.get()
        watcher_names = sorted(self.watchers.keys())
        
        if tuple(self.watcher_combo['values']) != tuple(watcher_names):
            self.watcher_combo["values"] = watcher_names
        
        if current_selection and current_selection in watcher_names:
            if self.watcher_combo.get() != current_selection:
                self.watcher_combo.set(current_selection)
        elif current_selection not in watcher_names:
            self.watcher_combo.set(""); self.session_combo.set(""); self.session_combo["values"] = []
            if watcher_names:
                self.watcher_combo.set(watcher_names[0]); self._on_watcher_selected()
        elif not self.watcher_combo.get() and watcher_names:
            self.watcher_combo.set(watcher_names[0]); self._on_watcher_selected()

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
        self.current_watcher_id = None; self.current_session_name = None
        if self._log_fetch_timer:
            self.after_cancel(self._log_fetch_timer)
            self._log_fetch_timer = None
        self.terminal_view.config(state=tk.NORMAL)
        self.terminal_view.delete("1.0", tk.END)
        self.terminal_view.insert("1.0", "[GUI] No active session selected.")
        self.terminal_view.config(state=tk.DISABLED)
        self.command_file = None; self.log_file = None; self.status_file = None
        self.input_locked = False
        if self.file_tree:
            for i in self.file_tree.get_children():
                self.file_tree.delete(i)
        self._update_editor_title()

    def _switch_to_session(self, watcher_id: str, session_name: str):

        if self.current_watcher_id == watcher_id and self.current_session_name == session_name:
            return
        self.current_watcher_id = watcher_id; self.current_session_name = session_name
        session_dir = LOCAL_SESSIONS_ROOT / watcher_id / session_name
        session_dir.mkdir(parents=True, exist_ok=True)
        self.command_file = session_dir / "commands.txt"; self.log_file = session_dir / "commands.log"; self.status_file = session_dir / ".watcher_status.json"
        
        self._populate_file_tree(session_dir)

        self.terminal_view.config(state=tk.NORMAL)
        self.terminal_view.delete("1.0", tk.END)
        
        display_name = self.watcher_combo.get()
        self._append_log(f"[--- Switched to Watcher: '{display_name}', Session: '{session_name}' ---]\n")

        try:
            remote_session_dir = f"{REMOTE_SESSIONS_PATH}/{watcher_id}/{session_name}/"
            self._run_sync_command(["rsync", "-az", f"{REMOTE_SERVER}:{remote_session_dir}commands.log", f"{str(self.log_file.parent)}/"], timeout=5)
            
            if self.log_file.exists():
                content = self.log_file.read_text(encoding="utf-8", errors="replace")
                initial_log = "\n".join(content.splitlines()[-INIT_TAIL_LINES:])
                self._process_and_append_log(initial_log + "\n")
                self._log_pos = self.log_file.stat().st_size
            else:
                self._log_pos = 0

        except Exception as e:
            self._append_log(f"[GUI] Failed to process initial log: {e}\n")
            self._log_pos = 0

        self._show_remote_prompt()
    
    def _set_initial_sash_position(self):
        try:
            height = self.main_pane.winfo_height()
            self.main_pane.sash_place(0, 0, int(height * 0.80))
            width = self.editor_pane.winfo_width()
            self.editor_pane.sash_place(0, int(width * 0.25), 0)
        except tk.TclError:
            pass
    
    def _create_widgets(self):
        session_bar = ttk.Frame(self, style="Dark.TFrame", padding=(10, 8))
        session_bar.pack(side=tk.TOP, fill=tk.X)
        ttk.Label(session_bar, text="Watcher:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        self.watcher_combo = ttk.Combobox(session_bar, state="readonly", width=24, style="Dark.TCombobox")
        self.watcher_combo.pack(side=tk.LEFT)
        self.watcher_combo.bind("<<ComboboxSelected>>", self._on_watcher_selected)
        ttk.Button(session_bar, text="🔄", width=3, command=self._update_watcher_list).pack(side=tk.LEFT, padx=(4, 0))
        ttk.Label(session_bar, text="Session:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(10, 4))
        self.session_combo = ttk.Combobox(session_bar, state="readonly", width=20, style="Dark.TCombobox")
        self.session_combo.pack(side=tk.LEFT)
        self.session_combo.bind("<<ComboboxSelected>>", self._on_session_selected)
        self.new_session_var = tk.StringVar()
        ttk.Label(session_bar, text="New:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(10, 4))
        ttk.Entry(session_bar, textvariable=self.new_session_var, width=16, style="Dark.TEntry").pack(side=tk.LEFT)
        ttk.Button(session_bar, text="Create", command=self._create_session, style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))

        self.main_pane = ttk.PanedWindow(self, orient=tk.VERTICAL)
        self.main_pane.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        self.editor_pane = ttk.PanedWindow(self.main_pane, orient=tk.HORIZONTAL)
        
        file_tree_frame = ttk.Frame(self.editor_pane, style="Dark.TFrame")
        file_tree_toolbar = ttk.Frame(file_tree_frame, style="Dark.TFrame", padding=(8, 6))
        file_tree_toolbar.pack(side=tk.TOP, fill=tk.X)
        ttk.Label(file_tree_toolbar, text="File Explorer", style="Dark.TLabel").pack(side=tk.LEFT)
        ttk.Button(file_tree_toolbar, text="Browse...", command=self._browse_file_tree_root, style="Dark.TButton").pack(side=tk.LEFT, padx=(10,0))
        
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

        editor_frame = ttk.Frame(self.editor_pane, style="Dark.TFrame")
        editor_toolbar = ttk.Frame(editor_frame, style="Dark.TFrame", padding=(8, 6))
        editor_toolbar.pack(side=tk.TOP, fill=tk.X)
        ttk.Button(editor_toolbar, text="Open File", command=self.editor_open_file, style="Dark.TButton").pack(side=tk.LEFT)
        ttk.Button(editor_toolbar, text="Save File", command=self.editor_save_file, style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))
        ttk.Button(editor_toolbar, text="Save As...", command=self.editor_save_file_as, style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))
        self.editor_file_label = ttk.Label(editor_toolbar, text="No file opened", style="Dark.TLabel")
        self.editor_file_label.pack(side=tk.LEFT, padx=(12, 0))
        
        self.search_frame = ttk.Frame(editor_toolbar, style="Dark.TFrame")
        search_entry = ttk.Entry(self.search_frame, textvariable=self.search_var, style="Dark.TEntry", width=20)
        search_entry.pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(self.search_frame, text="Next ↓", command=self._find_next, style="Dark.TButton", width=7).pack(side=tk.LEFT)
        ttk.Button(self.search_frame, text="Prev ↑", command=self._find_prev, style="Dark.TButton", width=7).pack(side=tk.LEFT, padx=4)
        ttk.Button(self.search_frame, text="Highlight", command=self._perform_search, style="Dark.TButton").pack(side=tk.LEFT)
        ttk.Button(self.search_frame, text="✖", command=self._hide_search_bar, style="Dark.TButton", width=3).pack(side=tk.LEFT, padx=4)
        search_entry.bind("<Return>", lambda e: self._find_next())
        search_entry.bind("<Shift-Return>", lambda e: self._find_prev())
        search_entry.bind("<Escape>", self._hide_search_bar)

        self.editor_notebook = ttk.Notebook(editor_frame, style="Closable.TNotebook")
        self.editor_notebook.pack(fill=tk.BOTH, expand=True)
        self.editor_notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)
        self.editor_notebook.bind("<ButtonPress-1>", self._on_close_press)
        self.editor_notebook.bind("<ButtonRelease-1>", self._on_close_release)

        self.editor_pane.add(file_tree_frame, weight=2)
        self.editor_pane.add(editor_frame, weight=8)
        
        terminal_frame = ttk.Frame(self.main_pane, style="Dark.TFrame")
        terminal_toolbar = ttk.Frame(terminal_frame, style="Dark.TFrame", padding=(8, 6))
        terminal_toolbar.pack(side=tk.TOP, fill=tk.X)
        
        ttk.Label(terminal_toolbar, text="Mode:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        mode_combo = ttk.Combobox(terminal_toolbar, textvariable=self.terminal_mode, values=["Remote", "Local"], state="readonly", width=8, style="Dark.TCombobox")
        mode_combo.pack(side=tk.LEFT)
        mode_combo.bind("<<ComboboxSelected>>", self._on_terminal_mode_changed)

        ttk.Button(terminal_toolbar, text="Clear view", command=self.clear_output, style="Dark.TButton").pack(side=tk.LEFT, padx=(10, 0))
        ttk.Button(terminal_toolbar, text="Clear log file", command=self.clear_log_file, style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))
        ttk.Checkbutton(terminal_toolbar, text="Auto scroll", variable=self.auto_scroll, style="Dark.TCheckbutton").pack(side=tk.LEFT, padx=(12, 0))
        self.sync_indicator_label = ttk.Label(terminal_toolbar, text="", style="Dark.TLabel", font=self.mono_font)
        self.sync_indicator_label.pack(side=tk.RIGHT, padx=(10, 0))
        
        self.terminal_view = tk.Text(
            terminal_frame, wrap="word", bg=self.TEXT_BG, fg=self.TEXT_FG,
            insertbackground=self.INSERT_FG,
            selectbackground=self.SELECT_BG, selectforeground=self.SELECT_FG,
            font=self.mono_font,
            highlightthickness=4, highlightbackground=COMBO_BG, highlightcolor="#3B729F",
            relief="flat", borderwidth=0
        )
        self.terminal_view.pack(fill=tk.BOTH, expand=True)
        self.terminal_view.tag_configure("prompt_user_host", foreground="#67E02D")

        yscroll = ttk.Scrollbar(terminal_frame, orient="vertical", command=self.terminal_view.yview)
        self.terminal_view.configure(yscrollcommand=yscroll.set)
        yscroll.place(in_=self.terminal_view, relx=1.0, rely=0, relheight=1.0, anchor="ne")
        
        self.main_pane.add(self.editor_pane, weight=8)
        self.main_pane.add(terminal_frame, weight=2)
        self.terminal_view.mark_set("input_start", tk.INSERT)
        self.terminal_view.mark_gravity("input_start", tk.LEFT)

    def _on_close_press(self, event):
        try:
            element = self.editor_notebook.identify(event.x, event.y)
            if "close" in element:
                index = self.editor_notebook.index(f"@{event.x},{event.y}")
                self.editor_notebook.state(['pressed'])
                self._pressed_tab_index = index
        except tk.TclError:
            pass
    
    def _on_close_release(self, event):
        if not hasattr(self, "_pressed_tab_index"):
            return
        try:
            element = self.editor_notebook.identify(event.x, event.y)
            index = self.editor_notebook.index(f"@{event.x},{event.y}")
            if "close" in element and self._pressed_tab_index == index:
                tab_id = self.editor_notebook.tabs()[index]
                self._close_tab_by_id(tab_id)
        finally:
            self.editor_notebook.state(['!pressed'])
            if hasattr(self, "_pressed_tab_index"):
                del self._pressed_tab_index

    def _close_tab_by_id(self, tab_id):
        tab_data = self.tabs.get(tab_id)
        if not tab_data: return

        original_tab = self.editor_notebook.select()
        self.editor_notebook.select(tab_id)

        if tab_data["is_dirty"]:
            filename = tab_data["filepath"].name if tab_data["filepath"] else "Untitled"
            result = messagebox.askyesnocancel("保存の確認", f"'{filename}' への変更を保存しますか？")
            if result is True:
                self.editor_save_file()
                if tab_data["is_dirty"]:
                    self.editor_notebook.select(original_tab)
                    return
            elif result is None:
                self.editor_notebook.select(original_tab)
                return
            
        self.editor_notebook.forget(tab_id)
        del self.tabs[tab_id]
        
        if len(self.tabs) == 0:
            self._create_new_tab()
            
        self._update_editor_title()

    def _close_current_tab(self):
        try:
            tab_id = self.editor_notebook.select()
            self._close_tab_by_id(tab_id)
        except tk.TclError:
            pass

    def _create_new_tab(self, filepath=None):
        tab_frame = ttk.Frame(self.editor_notebook, style="Dark.TFrame")
        tab_frame.grid_rowconfigure(0, weight=1)
        tab_frame.grid_columnconfigure(1, weight=1)

        line_numbers = tk.Text(
            tab_frame, width=4, padx=4, takefocus=0, bd=0, bg=COMBO_BG, fg="#888888",
            state="disabled", wrap="none", font=self.mono_font, highlightthickness=3,
            highlightbackground=COMBO_BG
        )
        line_numbers.grid(row=0, column=0, sticky="ns")

        editor_text = tk.Text(
            tab_frame, wrap="word", undo=True, bg=self.TEXT_BG, fg=self.TEXT_FG,
            insertbackground=self.INSERT_FG, selectbackground=self.SELECT_BG,
            selectforeground=self.SELECT_FG, font=self.mono_font, highlightthickness=4,
            highlightbackground=COMBO_BG, highlightcolor="#3B729F", relief="flat", borderwidth=0
        )
        editor_text.grid(row=0, column=1, sticky="nsew")
        editor_text.tag_configure("search_highlight", background="#D8A01D", foreground="#000000")
        editor_text.tag_configure("selection_match_highlight", background="#4A4A4A")

        marker_bar = tk.Canvas(tab_frame, width=10, bg=COMBO_BG, highlightthickness=0)
        marker_bar.grid(row=0, column=2, sticky="ns")
        marker_bar.bind("<Button-1>", lambda e: self._on_marker_bar_click(e))
        
        scrollbar = ttk.Scrollbar(tab_frame, orient="vertical", command=lambda *args: self._on_scrollbar_move(*args))
        scrollbar.grid(row=0, column=3, sticky="ns")
        
        editor_text['yscrollcommand'] = lambda *args: self._on_text_scroll(*args)
        line_numbers['yscrollcommand'] = lambda *args: self._on_text_scroll(*args)

        tab_title = os.path.basename(filepath) if filepath else "Untitled"
        self.editor_notebook.add(tab_frame, text=tab_title)
        tab_id = self.editor_notebook.tabs()[-1]

        self.tabs[tab_id] = {
            "filepath": filepath,
            "is_dirty": False,
            "text": editor_text,
            "line_numbers": line_numbers,
            "marker_bar": marker_bar,
            "scrollbar": scrollbar,
            "syntax_tags": set(),
            "highlight_timer": None,
            "line_number_timer": None,
            "selection_timer": None,
        }

        self._bind_editor_keys(editor_text)
        self.editor_notebook.select(tab_id)
        editor_text.focus_set()
        return tab_id

    def _get_current_tab_data(self):
        try:
            selected_tab_id = self.editor_notebook.select()
            return self.tabs.get(selected_tab_id)
        except (tk.TclError, IndexError):
            return None
    
    def _handle_editor_focus_in(self, event=None):
        if self.completion_popup:
            self._destroy_completion_popup()

    def _bind_global_keys(self):
        self.file_tree.bind("<Double-1>", self._on_file_tree_double_click)
        self.terminal_view.bind("<Return>", self._on_terminal_return)
        self.terminal_view.bind("<KeyPress>", self._on_terminal_keypress)
        self.terminal_view.bind("<Button-3><ButtonRelease-3>", self._show_context_menu)
        self.terminal_view.bind("<Button-2><ButtonRelease-2>", self._show_context_menu)
        self.bind_all("<Escape>", self._hide_search_bar)

        if sys.platform == "darwin":
            self.bind_all("<Command-f>", self._show_search_bar)
            self.terminal_view.bind("<Command-c>", self._copy_selection)
            self.bind_all("<Command-s>", self._on_save_shortcut)
            self.bind_all("<Command-Shift-s>", self.editor_save_file_as)
        else:
            self.bind_all("<Control-f>", self._show_search_bar)
            self.terminal_view.bind("<Control-c>", self._copy_selection)
            self.bind_all("<Control-s>", self._on_save_shortcut)
            self.bind_all("<Control-Shift-S>", self.editor_save_file_as)

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
    
    def _browse_file_tree_root(self):
        initial_dir = str(LOCAL_SESSIONS_ROOT / self.current_watcher_id if self.current_watcher_id else LOCAL_BASE_DIR)
        selected_path = filedialog.askdirectory(initialdir=initial_dir, title="Select a directory to display")
        if selected_path:
            self._populate_file_tree(Path(selected_path))

    def _populate_file_tree(self, root_path: Path):
        self.current_tree_root = root_path
        for i in self.file_tree.get_children():
            self.file_tree.delete(i)
        if not root_path or not root_path.is_dir():
            return
        root_iid = self.file_tree.insert("", "end", text=str(root_path), open=True)
        self._insert_tree_items(root_path, root_iid)

    def _insert_tree_items(self, path: Path, parent_iid: str):
        try:
            items = sorted(list(path.iterdir()), key=lambda p: (not p.is_dir(), p.name.lower()))
            for item in items:
                iid = self.file_tree.insert(parent_iid, "end", text=item.name, open=False, values=[str(item)])
                if item.is_dir():
                    self._insert_tree_items(item, iid)
        except (PermissionError, FileNotFoundError):
            pass

    def _on_file_tree_double_click(self, event=None):
        try:
            item_id = self.file_tree.focus()
            if not item_id: return
            item_values = self.file_tree.item(item_id, "values")
            if item_values and item_values[0]:
                filepath = Path(item_values[0])
                if filepath.is_file():
                    self.editor_open_file(filepath=filepath)
        except Exception as e:
            print(f"Error opening file from tree: {e}")
    
    def _on_scrollbar_move(self, *args):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        tab_data["text"].yview(*args)
        tab_data["line_numbers"].yview(*args)
        try:
            tab_data["marker_bar"].yview(*args)
        except tk.TclError: pass

    def _on_text_scroll(self, *args):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        tab_data["scrollbar"].set(*args)
        try:
            tab_data["line_numbers"].yview_moveto(args[0])
            tab_data["marker_bar"].yview_moveto(args[0])
        except Exception: pass
    
    def _on_tab_changed(self, event=None):
        self._update_editor_title()
        tab_data = self._get_current_tab_data()
        if tab_data:
            tab_data["text"].focus_set()

    def _update_line_numbers(self):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        
        editor_text, line_numbers = tab_data["text"], tab_data["line_numbers"]
        
        tab_data["line_number_timer"] = None
        line_numbers.config(state="normal")
        line_numbers.delete("1.0", "end")
        try:
            line_count = int(editor_text.index("end-1c").split('.')[0])
            line_numbers.insert("1.0", "\n".join(str(i) for i in range(1, line_count + 1)))
        except tk.TclError: # Widget may be destroyed
            pass
        line_numbers.config(state="disabled")
        try:
            line_numbers.yview_moveto(editor_text.yview()[0])
        except Exception: pass

    def _schedule_update_line_numbers(self):
        tab_data = self._get_current_tab_data()
        if not tab_data: return

        if tab_data["line_number_timer"]:
            self.after_cancel(tab_data["line_number_timer"])
        tab_data["line_number_timer"] = self.after(LINE_NUMBER_UPDATE_DELAY_MS, self._update_line_numbers)
    
    def _show_remote_prompt(self):
        if not self.current_session_name or not self.status_file:
            # まだセッションが選択されていない場合は、処理を試みずに単純なプロンプトを表示して終了する
            if self.terminal_view.get("end-2c", "end-1c") != '\n':
                 self.terminal_view.insert(tk.END, "\n")
            self.terminal_view.insert(tk.END, "[GUI] Please select a watcher and session.$ ")
            self.terminal_view.mark_set("input_start", self.terminal_view.index("end-1c"))
            return
        if self.input_locked:
            return

        self.terminal_view.insert(tk.END, "\n")
    
        try:
            # ★ リモートのステータスファイルの正しい場所
            if not (self.current_watcher_id and self.current_session_name):
                raise RuntimeError("No remote session selected")
    
            remote_status = (
                f"{REMOTE_SESSIONS_PATH}/"
                f"{self.current_watcher_id}/"
                f"{self.current_session_name}/.watcher_status.json"
            )
    
            # ローカル側は既存の self.status_file を使う
            local_dir = str(self.status_file.parent)
            
            # リモート → ローカルへ同期
            self._run_sync_command(
                ["rsync", "-az", f"{REMOTE_SERVER}:{remote_status}", f"{local_dir}/"],
                capture_output=True, timeout=5
            )
    
            # JSON を読む（ここまで来れば user@host が描ける）
            status = json.loads(self.status_file.read_text(encoding="utf-8"))
            conda_env = status.get("conda_env")
            conda_prefix = f"({conda_env}) " if conda_env else ""
            user = status.get("user", "u")
            host = status.get("host", "h")
            cwd  = status.get("cwd", "~")
    
            home_dir = str(Path.home())
            if isinstance(cwd, str) and cwd.startswith(home_dir):
                cwd = "~" + cwd[len(home_dir):]
    
            self.terminal_view.insert(tk.END, f"[Remote] {conda_prefix}")
            tag_start = self.terminal_view.index("end-1c")
            self.terminal_view.insert(tk.END, f"{user}@{host}")
            tag_end = self.terminal_view.index("end-1c")
            self.terminal_view.tag_add("prompt_user_host", tag_start, tag_end)
            self.terminal_view.insert(tk.END, f":{cwd}$ ")
    
        except Exception:
            print(remote_status, local_dir)
            self.terminal_view.insert(tk.END, "$ ")
    
        # 入力位置のセットは常に実行
        self.terminal_view.mark_set("input_start", self.terminal_view.index("end-1c"))
        self.terminal_view.mark_set(tk.INSERT, "end-1c")
        self.terminal_view.see(tk.INSERT)
    
    def _show_local_prompt(self):
        if self.input_locked: return
        self.terminal_view.insert(tk.END, "\n")
        try:
            conda_env = os.environ.get("CONDA_DEFAULT_ENV"); conda_prefix = f"({conda_env}) " if conda_env else ""
            user, host, cwd = getpass.getuser(), socket.gethostname().split('.')[0], str(self.local_cwd)
            home_dir = str(Path.home())
            if cwd.startswith(home_dir):
                cwd = "~" + cwd[len(home_dir):]
            self.terminal_view.insert(tk.END, f"[Local] {conda_prefix}")
            tag_start = self.terminal_view.index("end-1c")
            self.terminal_view.insert(tk.END, f"{user}@{host}")
            tag_end = self.terminal_view.index("end-1c")
            self.terminal_view.tag_add("prompt_user_host", tag_start, tag_end)
            self.terminal_view.insert(tk.END, f":{cwd}$ ")
        except Exception: self.terminal_view.insert(tk.END, "$ ")
        self.terminal_view.mark_set("input_start", self.terminal_view.index("end-1c"))
        self.terminal_view.mark_set(tk.INSERT, "end-1c"); self.terminal_view.see(tk.INSERT)

    def _on_terminal_mode_changed(self, event=None):
        mode = self.terminal_mode.get()
        
        # self.clear_output() の代わりに、テキストの削除だけを直接行う
        self.terminal_view.config(state=tk.NORMAL)
        self.terminal_view.delete("1.0", tk.END)
    
        if mode == "Local":
            # メッセージを先に追加し、改行(\n)も加えておく
            self._append_log("[--- Switched to Local Terminal Mode ---]\n")
            # その後にプロンプトを一度だけ表示
            self._show_local_prompt()
        else:
            # Remoteモードの処理も同様に整理
            self._append_log("[--- Switched to Remote Terminal Mode ---]\n")
            if self.current_watcher_id:
                self._show_remote_prompt()
            else:
                self._append_log("Please select a remote watcher and session.")

    def _on_terminal_return(self, event=None):
        if self.input_locked: return "break"
        mode, current_line = self.terminal_mode.get(), self.terminal_view.get("input_start", "end-1c")
        cmd = current_line.strip()
        self.terminal_view.insert(tk.END, "\n")
        if cmd: self.history.append(cmd); self.history_idx = len(self.history)
        if mode == "Remote":
            if not self.command_file: return "break"
            if cmd:
                try:
                    self.command_file.parent.mkdir(parents=True, exist_ok=True)
                    with self.command_file.open("a", encoding="utf-8") as f: f.write(cmd + "\n")
                    remote_session_dir = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}/"
                    self._run_sync_command(["rsync", "-az", str(self.command_file), f"{REMOTE_SERVER}:{remote_session_dir}"], check=True, timeout=5)
                except Exception as e: self._append_log(f"[GUI] Failed to write/sync command: {e}\n")
            if self._log_fetch_timer: self.after_cancel(self._log_fetch_timer)
            self._fetch_log_updates(); self.terminal_view.focus_set()
        else:
            if cmd: self._execute_local_command(cmd)
            self._show_local_prompt()
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
                else: self._append_log(f"cd: no such file or directory: {parts[1] if len(parts) > 1 else ''}")
            except Exception as e: self._append_log(f"Error during cd: {e}")
            return
        try:
            proc = subprocess.run(cmdline, shell=True, capture_output=True, text=True, cwd=self.local_cwd, encoding='utf-8', errors='replace', timeout=60)
            combined_output = (proc.stdout or "") + (proc.stderr or "")
            self._append_log(combined_output.strip())
        except subprocess.TimeoutExpired: self._append_log("\n[GUI] Command timed out after 60 seconds.")
        except Exception as e: self._append_log(f"\n[GUI] Error executing local command: {e}")

    def _fetch_log_updates(self):
        if not self.current_watcher_id or not self.current_session_name: return
        try:
            local_dir = LOCAL_SESSIONS_ROOT / self.current_watcher_id / self.current_session_name
            remote_dir = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}/"
            self._run_sync_command(["rsync", "-az", f"{REMOTE_SERVER}:{remote_dir}commands.log", f"{str(local_dir)}/"], timeout=5)
        except Exception as e: print(f"Log sync failed: {e}") 
        try:
            new_size = self.log_file.stat().st_size if self.log_file.exists() else 0
            if new_size < self._log_pos:
                self.terminal_view.config(state=tk.NORMAL); self.terminal_view.delete("1.0", tk.END); self._log_pos = 0 
            if new_size > self._log_pos:
                with self.log_file.open("r", encoding="utf-8", errors="replace") as f:
                    f.seek(self._log_pos); new_text = f.read(); self._log_pos = f.tell()
                    if self._process_and_append_log(new_text):
                        self._show_remote_prompt(); return
        except Exception as e: print(f"Log read failed: {e}")
        self._log_fetch_timer = self.after(LOG_FETCH_INTERVAL_MS, self._fetch_log_updates)

    def _process_and_append_log(self, text: str) -> bool:
        marker_found, display_text = False, text
        if EOC_MARKER_PREFIX in text:
            marker_found, display_text = True, text.split(EOC_MARKER_PREFIX, 1)[0]
        if display_text: self._append_log(display_text)
        if self.input_locked and marker_found:
            self.input_locked = False
            self._append_log("[GUI] Log cleared successfully. Input unlocked.\n"); self.terminal_view.focus_set()
        return marker_found

    def _on_terminal_keypress(self, event):
        if self.input_locked: return "break"
        if self.terminal_view.compare(tk.INSERT, "<", "input_start"):
            if event.keysym not in ("Left", "Right", "Home", "End", "Up", "Down"): return "break"
        if event.keysym in ("Up", "Down"):
            if self.history:
                if event.keysym == "Up": self.history_idx = max(0, self.history_idx - 1)
                else: self.history_idx = min(len(self.history), self.history_idx + 1)
                self.terminal_view.delete("input_start", tk.END)
                if self.history_idx < len(self.history): self.terminal_view.insert(tk.END, self.history[self.history_idx])
            return "break"

    def _copy_selection(self, event=None):
        try:
            selected_text = self.terminal_view.selection_get()
            self.clipboard_clear(); self.clipboard_append(selected_text)
        except tk.TclError: pass
        return "break"

    def _show_context_menu(self, event):
        try:
            self.terminal_view.selection_get(); self.terminal_context_menu.entryconfigure("Copy", state="normal")
        except tk.TclError: self.terminal_context_menu.entryconfigure("Copy", state="disabled")
        self.terminal_context_menu.tk_popup(event.x_root, event.y_root)

    def _append_log(self, text):
        self.terminal_view.config(state=tk.NORMAL)
        try:
            current_lines = int(self.terminal_view.index('end-1c').split('.')[0])
            if current_lines > MAX_TERMINAL_LINES:
                lines_to_delete = current_lines - MAX_TERMINAL_LINES
                self.terminal_view.delete('1.0', f'{lines_to_delete + 1}.0')
        except Exception: pass
        if text: self.terminal_view.insert(tk.END, text)
        self.terminal_view.mark_set(tk.INSERT, tk.END)
        if self.auto_scroll.get(): self.terminal_view.see(tk.END)

    def clear_output(self):
        self.terminal_view.config(state=tk.NORMAL); self.terminal_view.delete("1.0", tk.END)
        if self.terminal_mode.get() == "Remote": self._show_remote_prompt()
        else: self._show_local_prompt()

    def clear_log_file(self):
        if self.terminal_mode.get() == "Local":
            messagebox.showinfo("Info", "This function is only available in Remote mode."); return
        if not self.command_file: return
        try:
            self.input_locked = True
            self.terminal_view.config(state=tk.NORMAL); self.terminal_view.delete("1.0", tk.END)
            self.terminal_view.insert(tk.END, "[GUI] Sending clear log command... Input is locked until confirmation.\n")
            clear_command = "_internal_clear_log\n"
            with self.command_file.open("a", encoding="utf-8") as f: f.write(clear_command)
            remote_session_dir = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}/"
            self._run_sync_command(["rsync", "-az", str(self.command_file), f"{REMOTE_SERVER}:{remote_session_dir}"], check=True, timeout=5)
            if self._log_fetch_timer: self.after_cancel(self._log_fetch_timer)
            self._fetch_log_updates()
        except Exception as e:
            messagebox.showerror("Error", f"Failed to send clear log command:\n{e}"); self.input_locked = False

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
        lines, all_commented = range(start_line, end_line + 1), all(editor_text.get(f"{l}.0", f"{l}.end").lstrip().startswith("#") for l in range(start_line, end_line + 1) if editor_text.get(f"{l}.0", f"{l}.end").strip())
        for l in lines:
            line_text = editor_text.get(f"{l}.0", f"{l}.end")
            if all_commented:
                if line_text.lstrip().startswith("# "): editor_text.delete(f"{l}.{line_text.find('# ')}", f"{l}.{line_text.find('# ')+2}")
                elif line_text.lstrip().startswith("#"): editor_text.delete(f"{l}.{line_text.find('#')}", f"{l}.{line_text.find('#')+1}")
            elif line_text.strip(): editor_text.insert(f"{l}.{len(line_text) - len(line_text.lstrip())}", "# ")
        editor_text.tag_remove("sel", "1.0", "end"); editor_text.tag_add("sel", f"{start_line}.0", f"{end_line+1}.0")
        return "break"

    def _on_editor_modified(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        
        editor_text = tab_data["text"]
        if editor_text.edit_modified():
            if not tab_data["is_dirty"]:
                tab_data["is_dirty"] = True
                self._update_editor_title()
            editor_text.edit_modified(False)
        self._schedule_rehighlight()
        self._schedule_update_line_numbers()

    def _update_editor_title(self):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            self.editor_file_label.config(text="No file opened")
            return
        
        filepath = tab_data.get("filepath")
        filename = filepath.name if filepath else "Untitled"
        dirty_marker = "*" if tab_data["is_dirty"] else ""
        full_title = f"{filename}{dirty_marker}"
        
        self.editor_file_label.config(text=str(filepath) if filepath else "Untitled")
        
        try:
            tab_id = self.editor_notebook.select()
            self.editor_notebook.tab(tab_id, text=full_title)
        except tk.TclError: pass
    
    def _schedule_rehighlight(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return

        if tab_data["highlight_timer"]:
            self.after_cancel(tab_data["highlight_timer"])
        tab_data["highlight_timer"] = self.after(REHIGHLIGHT_DELAY_MS, self._rehighlight)

    def _rehighlight(self):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        
        tab_data["highlight_timer"] = None
        filename = tab_data["filepath"] or "untitled.py"
        content = tab_data["text"].get("1.0", "end-1c")
        self.apply_syntax_highlight(content, str(filename))

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

    def editor_open_file(self, filepath: Path | None = None):
        if filepath is None:
            initial = str(LOCAL_SESSIONS_ROOT / self.current_watcher_id if self.current_watcher_id else LOCAL_BASE_DIR)
            filepath_str = filedialog.askopenfilename(initialdir=initial)
            if not filepath_str: return
            filepath = Path(filepath_str)
        
        for tab_id, data in self.tabs.items():
            if data["filepath"] == filepath:
                self.editor_notebook.select(tab_id)
                return

        try:
            content = filepath.read_text("utf-8", errors="replace")
            
            current_tab_data = self._get_current_tab_data()
            open_new_tab = not (current_tab_data and not current_tab_data["filepath"] and not current_tab_data["is_dirty"] and not current_tab_data["text"].get("1.0", "end-1c").strip())
            
            if open_new_tab:
                tab_id = self._create_new_tab(filepath)
                tab_data = self.tabs[tab_id]
            else:
                tab_id = self.editor_notebook.select()
                tab_data = current_tab_data
                tab_data["filepath"] = filepath
                
            editor_text = tab_data["text"]
            editor_text.delete("1.0", tk.END)
            editor_text.insert("1.0", content)
            tab_data["is_dirty"] = False
            editor_text.edit_modified(False)
            self._update_editor_title()
            self.apply_syntax_highlight(content, str(filepath))
            self._update_line_numbers()
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open file:\n{e}")

    def _save_file_logic(self, filepath_str):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        filepath = Path(filepath_str)
        
        content = tab_data["text"].get("1.0", "end-1c")
        with open(filepath, "w", encoding="utf-8") as f: f.write(content)
        tab_data["filepath"], tab_data["is_dirty"] = filepath, False
        tab_data["text"].edit_modified(False)
        self._update_editor_title()
        self.apply_syntax_highlight(content, str(filepath))

    def editor_save_file(self):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        
        if not tab_data["filepath"]:
            self.editor_save_file_as()
        else:
            try:
                self._save_file_logic(str(tab_data["filepath"]))
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save file:\n{e}")

    def editor_save_file_as(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data: return "break"
        
        initial = str(LOCAL_SESSIONS_ROOT / self.current_watcher_id if self.current_watcher_id else LOCAL_BASE_DIR)
        try:
            filepath = filedialog.asksaveasfilename(
                initialdir=initial, defaultextension=".py",
                filetypes=[("Python files", "*.py"), ("Text files", "*.txt"), ("All files", "*.*")]
            )
            if filepath: self._save_file_logic(filepath)
        except Exception as e: messagebox.showerror("Error", f"Failed to save file:\n{e}")
        return "break"
    
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
            all_content, words = editor_text.get("1.0", "end-1c"), re.findall(r'[\w\.]+', editor_text.get("1.0", "end-1c"))
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

    def _resolve_color(self, ttype):
        t = ttype
        while True:
            if t in self.HL: return self.HL[t]
            if t is Token: return self.HL.get(Token, self.TEXT_FG)
            t = t.parent

    def apply_syntax_highlight(self, content, filename):
        tab_data = self._get_current_tab_data()
        if not tab_data: return
        editor_text, syntax_tags = tab_data["text"], tab_data["syntax_tags"]

        for tag in syntax_tags:
            editor_text.tag_remove(tag, '1.0', tk.END)
        syntax_tags.clear()

        try:
            lexer = guess_lexer_for_filename(filename, content)
        except Exception: lexer = get_lexer_by_name("text")

        idx = "1.0"
        for ttype, value in lex(content, lexer):
            start, end = idx, self._advance_index(idx, value)
            name = str(ttype)
            color = self._resolve_color(ttype)
            editor_text.tag_configure(name, foreground=color)
            syntax_tags.add(name)
            editor_text.tag_add(name, start, end)
            idx = end

        if self.search_var.get(): self._perform_search()
        editor_text.see("insert")

    @staticmethod
    def _advance_index(index, text):
        line, col = map(int, index.split("."))
        parts = text.split("\n")
        if len(parts) == 1:
            return f"{line}.{col + len(text)}"
        else:
            return f"{line + len(parts) - 1}.{len(parts[-1])}"

if __name__ == "__main__":
    app = IntegratedGUI()
    app.mainloop()