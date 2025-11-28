# gui_app.py
from __future__ import annotations
import sys
import time
import json
import shlex
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk, messagebox
from pathlib import Path
import uuid
from tkinter import simpledialog

# --- Config ---
from config import (
    LOCAL_BASE_DIR, LOCAL_SESSIONS_ROOT, LOCAL_REGISTRY_DIR,
    LOCAL_EDITING_CACHE, REMOTE_SERVER, REMOTE_SESSIONS_PATH,
    REMOTE_REGISTRY_PATH, STATE_JSON_PATH, UI_COLORS, HL,
    WATCHER_HEARTBEAT_TIMEOUT_SEC, COMBO_BG, COMBO_FG,
    COMBO_SEL_BG, COMBO_SEL_FG, SCROLLBAR_THUMB_COLOR, REMOTE_BASE_PATH, 
    INDENT_STRING, INDENT_WIDTH, INIT_TAIL_LINES
)

# --- Components ---
from components.terminal import TerminalFrame
from components.editor import EditorView 
from components.dirpicker import DirectoryPicker
from components.file_tree import FileTreePanel
from components.image_preview import ImagePreviewPanel
from components.editor_handler import EditorEventHandlerMixin

# --- Sync Services ---
from sync_services.watcher_registry import load_active_watchers
from sync_services.manager import SyncManager
from sync_services.client import WatcherClient

# =============================================================================
# Class: RunnerConfigDialog (Complete Version)
# =============================================================================
class RunnerConfigDialog(tk.Toplevel):
    def __init__(self, parent, current_config: dict):
        super().__init__(parent)
        self.app = parent
        self.title("Runner Configuration")
        self.geometry("600x550")
        self.result = None
        self.configure(bg=parent.BG_COLOR)
        
        style_frame = "Dark.TFrame"
        style_label = "Dark.TLabel"
        style_entry = "Dark.TEntry"
        style_btn = "Dark.TButton"
        style_combo = "Dark.TCombobox"

        main_frame = ttk.Frame(self, style=style_frame, padding=15)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # --- Execution Mode ---
        ttk.Label(main_frame, text="Execution Mode:", style=style_label).grid(row=0, column=0, sticky="w", pady=5)
        self.mode_var = tk.StringVar(value=current_config.get("mode", "host"))
        mode_cb = ttk.Combobox(main_frame, textvariable=self.mode_var, 
                               values=["host", "docker_run", "docker_exec"], 
                               state="readonly", width=20, style=style_combo)
        mode_cb.grid(row=0, column=1, sticky="w", pady=5)

        # --- Container Name (Combobox + Refresh) ---
        ttk.Label(main_frame, text="Container Name:", style=style_label).grid(row=1, column=0, sticky="w", pady=5)
        
        cont_frame = ttk.Frame(main_frame, style=style_frame)
        cont_frame.grid(row=1, column=1, sticky="ew", pady=5)
        
        self.container_var = tk.StringVar(value=current_config.get("container_name", ""))
        self.container_cb = ttk.Combobox(cont_frame, textvariable=self.container_var, style=style_combo, width=35)
        self.container_cb.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        # Container Refresh Button
        self.refresh_cont_btn = ttk.Button(cont_frame, text="↻", width=3, 
                                           command=self._refresh_containers, style=style_btn)
        self.refresh_cont_btn.pack(side=tk.LEFT, padx=(5, 0))
        self.app._set_tooltip_text(self.refresh_cont_btn, "Fetch active containers")

        ttk.Label(main_frame, text="(Required for 'docker_exec'. Select existing or type new name)", font=("", 8), style=style_label).grid(row=2, column=1, sticky="w")

        # --- Base Image (Combobox + Refresh) ---
        ttk.Label(main_frame, text="Base Image:", style=style_label).grid(row=3, column=0, sticky="w", pady=5)
        
        img_frame = ttk.Frame(main_frame, style=style_frame)
        img_frame.grid(row=3, column=1, sticky="ew", pady=5)
        
        self.image_var = tk.StringVar(value=current_config.get("image", ""))
        self.image_cb = ttk.Combobox(img_frame, textvariable=self.image_var, style=style_combo, width=35)
        self.image_cb.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        # Image Refresh Button
        self.refresh_img_btn = ttk.Button(img_frame, text="↻", width=3, 
                                          command=self._refresh_images, style=style_btn)
        self.refresh_img_btn.pack(side=tk.LEFT, padx=(5, 0))
        self.app._set_tooltip_text(self.refresh_img_btn, "Fetch available images")

        ttk.Label(main_frame, text="(For 'docker_run' OR creating new 'docker_exec' container)", font=("", 8), style=style_label).grid(row=4, column=1, sticky="w")

        # --- Internal Mount Path ---
        ttk.Label(main_frame, text="Internal Mount Path:", style=style_label).grid(row=5, column=0, sticky="w", pady=5)
        self.mount_path_var = tk.StringVar(value=current_config.get("mount_path", "/workspace"))
        ttk.Entry(main_frame, textvariable=self.mount_path_var, style=style_entry, width=40).grid(row=5, column=1, sticky="w", pady=5)

        # --- Extra Args ---
        ttk.Label(main_frame, text="Extra Docker Args:", style=style_label).grid(row=6, column=0, sticky="w", pady=5)
        self.args_var = tk.StringVar(value=current_config.get("extra_args", ""))
        ttk.Entry(main_frame, textvariable=self.args_var, style=style_entry, width=40).grid(row=6, column=1, sticky="w", pady=5)
        ttk.Label(main_frame, text="(e.g. -v /host:/container --gpus all)", font=("", 8), style=style_label).grid(row=7, column=1, sticky="w")

        # --- Buttons ---
        btn_frame = ttk.Frame(main_frame, style=style_frame)
        btn_frame.grid(row=8, column=0, columnspan=2, pady=20)
        ttk.Button(btn_frame, text="Cancel", command=self.destroy, style=style_btn).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="Save & Apply", command=self._on_save, style=style_btn).pack(side=tk.LEFT, padx=5)

        self._load_caches()

    def _load_caches(self):
        if not self.app.current_tree_root: return
        # Images
        img_path = self.app.current_tree_root / ".docker_images.txt"
        if img_path.exists():
            try: self.image_cb["values"] = sorted([l.strip() for l in img_path.read_text("utf-8").splitlines() if l.strip()])
            except: pass
        # Containers
        cnt_path = self.app.current_tree_root / ".docker_containers.txt"
        if cnt_path.exists():
            try: self.container_cb["values"] = sorted([l.strip() for l in cnt_path.read_text("utf-8").splitlines() if l.strip()])
            except: pass

    # --- Fetch Logic (Generic) ---
    def _fetch_remote_list(self, cmd, filename, cb_widget, btn_widget):
        if not self.app.current_session_name:
            messagebox.showinfo("Info", "Session not active.")
            return
        
        btn_widget.config(state="disabled")
        self.app.sync_indicator_label.config(text="Fetching list...")
        self.app.watcher_client.send_command(cmd)
        
        self.check_count = 0
        self.after(1000, lambda: self._check_file(filename, cb_widget, btn_widget))

    def _check_file(self, filename, cb_widget, btn_widget):
        remote = f"{REMOTE_SESSIONS_PATH}/{self.app.current_watcher_id}/{self.app.current_session_name}/{filename}"
        local = self.app.current_tree_root / filename
        
        try: self.app.sync_manager.pull_file(remote, str(local), timeout=5, lightweight=True)
        except: pass
        
        if local.exists() and time.time() - local.stat().st_mtime < 20:
            try:
                items = sorted([l.strip() for l in local.read_text("utf-8").splitlines() if l.strip()])
                cb_widget["values"] = items
                if items and not cb_widget.get(): cb_widget.set(items[0])
                messagebox.showinfo("Success", f"Found {len(items)} items.")
            except: pass
            btn_widget.config(state="normal")
            self.app.sync_indicator_label.config(text="")
        else:
            self.check_count += 1
            if self.check_count < 15:
                self.after(1000, lambda: self._check_file(filename, cb_widget, btn_widget))
            else:
                btn_widget.config(state="normal")
                self.app.sync_indicator_label.config(text="")
                messagebox.showwarning("Timeout", f"Failed to fetch {filename}.")

    def _refresh_images(self):
        self._fetch_remote_list("_internal_get_docker_images", ".docker_images.txt", self.image_cb, self.refresh_img_btn)

    def _refresh_containers(self):
        self._fetch_remote_list("_internal_get_docker_containers", ".docker_containers.txt", self.container_cb, self.refresh_cont_btn)

    def _on_save(self):
        self.result = {
            "mode": self.mode_var.get(),
            "container_name": self.container_var.get().strip(),
            "image": self.image_var.get().strip(),
            "mount_path": self.mount_path_var.get().strip(),
            "extra_args": self.args_var.get().strip()
        }
        if self.app.watcher_client:
             self.app.watcher_client.send_command("_internal_reset_cwd")
        self.destroy()
        
        

class IntegratedGUI(tk.Tk, EditorEventHandlerMixin):
    def __init__(self):
        super().__init__()
        self.is_loading = True
        self.title("Integrated Terminal & Editor (Multi-Watcher Control Panel)")
        self.geometry("1400x820")

        # --- Constants & Config ---
        self.UI_COLORS = UI_COLORS
        self.HL = HL
        self.TEXT_BG = self.UI_COLORS["TEXT_BG"]
        self.TEXT_FG = self.UI_COLORS["TEXT_FG"]
        self.SELECT_BG = self.UI_COLORS["SELECT_BG"]
        self.SELECT_FG = self.UI_COLORS["SELECT_FG"]
        self.INSERT_FG = self.UI_COLORS["INSERT_FG"]
        self.BORDER_CLR = self.UI_COLORS["BORDER_CLR"]
        self.COMBO_BG = COMBO_BG
        self.REHIGHLIGHT_DELAY_MS = 500
        self.LINE_NUMBER_UPDATE_DELAY_MS = 100
        self.INDENT_STRING = INDENT_STRING
        
        self._setup_styles()
        
        # --- Application State ---
        self.watchers = {}
        self.current_watcher_id = None
        self.current_session_name = None
        self.command_file = None
        self.log_file = None
        self.status_file = None
        self.sync_indicator_label = None
        self.current_tree_root = None
        self.pending_download_info = None
        self.remote_cwd = None
        self.tabs = {} 
        self.history = []     # Added for TerminalFrame compatibility
        self.history_idx = 0  # Added for TerminalFrame compatibility
        self.search_bar_visible = False
        self.search_var = tk.StringVar()
        self.completion_popup = None
        
        self.prefs = {
            "editor_family": "Menlo" if sys.platform == "darwin" else "Consolas",
            "editor_size": 12,
            "term_family": "Menlo" if sys.platform == "darwin" else "Consolas",
            "term_size": 12,
        }
        
        # Initialize fonts early
        self.mono_font = tkfont.Font(family=self.prefs["editor_family"], size=self.prefs["editor_size"])
        
        # --- Sub-components ---
        self.sync_manager = SyncManager(self)
        self.watcher_client = WatcherClient(self, self.sync_manager)
        
        # --- UI Construction ---
        self._create_widgets()
        
        # --- Init ---
        self._load_state()
        self._bind_global_keys()
        
        LOCAL_SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
        LOCAL_EDITING_CACHE.mkdir(parents=True, exist_ok=True)

        self._update_watcher_list()
        self.protocol("WM_DELETE_WINDOW", self._on_closing)
        self.is_loading = False
    
    def _setup_styles(self):
        self.BG_COLOR = self.UI_COLORS["BG_COLOR"]; self.PANEL_BG = self.UI_COLORS["PANEL_BG"]
        self.configure(bg=self.BG_COLOR)
        style = ttk.Style(self)
        try: style.theme_use("clam")
        except tk.TclError: pass
        style.configure(".", background=self.BG_COLOR, foreground=self.TEXT_FG)
        style.configure("Dark.TFrame", background=self.BG_COLOR)
        style.configure("Dark.TLabel", background=self.BG_COLOR, foreground=self.TEXT_FG)
        style.configure("Dark.TButton", background=self.BG_COLOR, foreground=self.TEXT_FG, bordercolor=self.BORDER_CLR)
        style.map("Dark.TButton", background=[('active', COMBO_BG)])
        style.configure("DarkCompact.TButton", padding=(2, 1, 2, 1), background=self.BG_COLOR, foreground=self.TEXT_FG, bordercolor=self.BORDER_CLR)
        style.map("DarkCompact.TButton", background=[('active', COMBO_BG)])
        style.configure("Dark.TEntry", fieldbackground=COMBO_BG, foreground=COMBO_FG)
        style.configure("Dark.TSpinbox", fieldbackground=COMBO_BG, foreground=COMBO_FG, bordercolor=self.BORDER_CLR)
        style.configure("TScrollbar", troughcolor=self.TEXT_BG, background=SCROLLBAR_THUMB_COLOR, relief='flat', borderwidth=0, arrowcolor=self.BORDER_CLR)
        style.map("TScrollbar", background=[('active', '#8A98A8')])
        style.configure("TPanedWindow", background=self.BG_COLOR)
        style.configure("Dark.TCombobox", fieldbackground=COMBO_BG, background=COMBO_BG, foreground=COMBO_FG, arrowcolor=COMBO_FG, bordercolor=self.BORDER_CLR)
        style.map("Dark.TCombobox", fieldbackground=[("readonly", COMBO_BG)], foreground=[("readonly", COMBO_FG)], background=[("readonly", COMBO_BG)])
        self.option_add("*TCombobox*Listbox*Background", COMBO_BG)
        self.option_add("*TCombobox*Listbox*Foreground", COMBO_FG)
        self.option_add("*TCombobox*Listbox*selectBackground", COMBO_SEL_BG)
        self.option_add("*TCombobox*Listbox*selectForeground", COMBO_SEL_FG)
        style.configure("Treeview", borderwidth=1, relief="solid", background=self.TEXT_BG, fieldbackground=self.TEXT_BG, foreground=self.TEXT_FG, rowheight=22)
        style.map("Treeview", background=[('selected', self.SELECT_BG)], foreground=[('selected', self.SELECT_FG)])
        
        # Tab close buttons
        def _make_cross_img(px=10, thickness=2, color="#D9DEE7"):
            img = tk.PhotoImage(master=self, width=px, height=px)
            half = thickness // 2
            def put(x, y):
                if 0 <= x < px and 0 <= y < px: img.put(color, (x, y))
            for i in range(px):
                for o in range(-half, half + 1):
                    put(i, i + o); put(i, (px - 1 - i) + o)
            return img
        
        self.close_btn_images = {
            "default": _make_cross_img(9, 2, "#D9DEE7"),
            "hover":   _make_cross_img(9, 2, "#66A8FF"),
            "pressed": _make_cross_img(9, 2, "#3D8CFF"),
        }
        try:
            style.element_create("close", "image", self.close_btn_images["default"],
                ("active", self.close_btn_images["hover"]), ("pressed", self.close_btn_images["pressed"]), border=5, sticky="")
        except tk.TclError: pass
        style.layout("Closable.TNotebook", [("Notebook.client", {"sticky": "nswe"})])
        style.layout("Closable.TNotebook.Tab", [("Notebook.tab", {"sticky": "nswe", "children": [
            ("Notebook.padding", {"side": "top", "sticky": "nswe", "children": [
                ("Notebook.focus", {"side": "top", "sticky": "nswe", "children": [
                    ("close", {"side": "left", "sticky": ''}), ("Notebook.label", {"side": "left", "sticky": ''})
                ]})]})]})])
        style.configure("TNotebook", background=self.BG_COLOR, borderwidth=0)
        style.configure("TNotebook.Tab", background=self.BG_COLOR, foreground=self.TEXT_FG, borderwidth=1, padding=[10, 4])
        style.map("TNotebook.Tab", background=[("selected", COMBO_BG)], foreground=[("selected", COMBO_SEL_FG)])
        
        # Symlink icon
        self.symlink_icon = tk.PhotoImage(master=self, width=16, height=16)
        c = "#66A8FF"
        for i in range(5): self.symlink_icon.put(c, (7+i, 10+i))
        for i in range(4): self.symlink_icon.put(c, (8+i, 14)); self.symlink_icon.put(c, (11, 11+i))

    def _create_widgets(self):
        # Top Session Bar
        session_bar = ttk.Frame(self, style="Dark.TFrame", padding=(10, 8))
        session_bar.pack(side=tk.TOP, fill=tk.X)
        
        runner_btn = ttk.Button(session_bar, text="Runner", width=10, command=self._open_runner_config, style="Dark.TButton")
        runner_btn.pack(side=tk.RIGHT, padx=(6, 0))
        self._tooltip(runner_btn, "Configure Docker Execution")
        
        gear_btn = ttk.Button(session_bar, text="\u2699\ufe0f" if not sys.platform.startswith("linux") else "Prefs", width=3, command=self.open_preferences, style="Dark.TButton")
        gear_btn.pack(side=tk.RIGHT, padx=(6, 0))
        self._tooltip(gear_btn, "Preferences")
        
        self.sync_indicator_label = ttk.Label(session_bar, text="", style="Dark.TLabel") # For SyncManager
        self.sync_indicator_label.pack(side=tk.RIGHT, padx=10)

        ttk.Label(session_bar, text="Watcher:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        self.watcher_combo = ttk.Combobox(session_bar, state="readonly", width=24, style="Dark.TCombobox")
        self.watcher_combo.pack(side=tk.LEFT)
        self.watcher_combo.bind("<<ComboboxSelected>>", self._on_watcher_selected)
        ttk.Button(session_bar, text="↻", width=4, command=self._update_watcher_list).pack(side=tk.LEFT, padx=(4, 0))
        
        ttk.Label(session_bar, text="Session:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(10, 4))
        self.session_combo = ttk.Combobox(session_bar, state="readonly", width=20, style="Dark.TCombobox")
        self.session_combo.pack(side=tk.LEFT)
        self.session_combo.bind("<<ComboboxSelected>>", self._on_session_selected)
        
        self.new_session_var = tk.StringVar()
        ttk.Label(session_bar, text="New:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(10, 4))
        ttk.Entry(session_bar, textvariable=self.new_session_var, width=16, style="Dark.TEntry").pack(side=tk.LEFT)
        ttk.Button(session_bar, text="Create", command=self._create_session, style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))

        # Main Panes
        self.main_pane = ttk.PanedWindow(self, orient=tk.VERTICAL)
        self.main_pane.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        self.editor_pane = ttk.PanedWindow(self.main_pane, orient=tk.HORIZONTAL)
        
        # Left: File Tree
        file_tree_frame = ttk.Frame(self.editor_pane, style="Dark.TFrame")
        self.file_tree_panel = FileTreePanel(self, file_tree_frame) 
        
        # Right: Editor + Preview
        self.editor_right_pane = ttk.PanedWindow(self.editor_pane, orient=tk.HORIZONTAL)
        editor_frame = ttk.Frame(self.editor_right_pane, style="Dark.TFrame")
        self.editor_view = EditorView(editor_frame, app=self)
        self.editor_view.pack(fill=tk.BOTH, expand=True)
        self.tabs = self.editor_view.tabs
        self.editor_notebook = self.editor_view.editor_notebook
        self.editor_file_label = self.editor_view.file_label
        self.search_frame = self.editor_view.search_frame

        self.editor_right_pane.add(editor_frame, weight=8)
        self.editor_pane.add(file_tree_frame, weight=2)
        self.editor_pane.add(self.editor_right_pane, weight=8)
        
        self.preview_panel = ImagePreviewPanel(self, self.editor_right_pane)

        # Bottom: Terminal
        self.terminal = TerminalFrame(self.main_pane, self)
        self.main_pane.add(self.editor_pane, weight=8)
        self.main_pane.add(self.terminal, weight=2)
        
        self.terminal_context_menu = tk.Menu(self, tearoff=0)
        self.terminal_context_menu.add_command(label="Copy", command=self._copy_selection)
        
        # Sashes
        for pane in (self.editor_pane, self.editor_right_pane):
            pane.bind("<B1-Motion>", lambda e: (self._hide_all_tooltips(), self._on_pane_drag()), "+")
            pane.bind("<ButtonRelease-1>", lambda e: self._on_pane_drag_end(), "+")

    def _on_pane_drag(self):
        if self.preview_panel: self.preview_panel.render_fit()
    def _on_pane_drag_end(self): 
        self._hide_all_tooltips()
        self._on_pane_drag()

    # --- Tooltips ---
    def _ensure_tooltip(self, widget):
        if not hasattr(self, "_tooltips"): self._tooltips = {}
        obj = self._tooltips.get(widget)
        if obj: return obj
        tip = tk.Toplevel(self); tip.withdraw(); tip.overrideredirect(True)
        lbl = ttk.Label(tip, style="Dark.TLabel", padding=(6, 3)); lbl.pack()
        obj = {"tip": tip, "label": lbl, "after_id": None}
        self._tooltips[widget] = obj
        def _show():
            try:
                tip.deiconify()
                x, y = widget.winfo_rootx() + 10, widget.winfo_rooty() + widget.winfo_height() + 6
                tip.geometry(f"+{x}+{y}")
            except tk.TclError: pass
        def enter(_):
            if obj["after_id"]: self.after_cancel(obj["after_id"])
            obj["after_id"] = self.after(220, _show)
        def leave(_):
            if obj["after_id"]: self.after_cancel(obj["after_id"]); obj["after_id"] = None
            tip.withdraw()
        widget.bind("<Enter>", enter, "+"); widget.bind("<Leave>", leave, "+")
        return obj

    def _set_tooltip_text(self, widget, text):
        obj = self._ensure_tooltip(widget)
        obj["label"].config(text=text or "")
        if not text: obj["tip"].withdraw()
    def _tooltip(self, widget, text): self._set_tooltip_text(widget, text)
    def _hide_all_tooltips(self):
        if hasattr(self, "_tooltips"):
            for obj in self._tooltips.values():
                try: obj["tip"].withdraw()
                except tk.TclError: pass

    # --- State Management ---
    def _save_state(self):
        open_files = []
        for tab_data in self.tabs.values():
            if tab_data.get("remote_path"): open_files.append(f"remote::{tab_data['remote_path']}")
            elif tab_data.get("filepath"): open_files.append(str(tab_data['filepath']))
        
        active_file = None
        cd = self.editor_view._get_current_tab_data()
        if cd:
            if cd.get("remote_path"): active_file = f"remote::{cd['remote_path']}"
            elif cd.get("filepath"): active_file = str(cd['filepath'])

        state = {
            "open_files": open_files, "active_file": active_file,
            "last_tree_root": str(self.current_tree_root) if self.current_tree_root else None,
            "prefs": self.prefs
        }
        try:
            state["main_sash_pos"] = self.main_pane.sashpos(0)
            state["editor_sash_pos"] = self.editor_pane.sashpos(0)
        except tk.TclError: pass
        try:
            with open(STATE_JSON_PATH, "w", encoding="utf-8") as f: json.dump(state, f, indent=2)
        except Exception as e: print(f"Save state failed: {e}")

    def _load_state(self):
        if not STATE_JSON_PATH.exists():
            self.after(100, self._set_initial_sash_position)
            self.editor_view._create_new_tab()
            return
        try:
            state = json.load(STATE_JSON_PATH.open("r", encoding="utf-8"))
            if "prefs" in state: self.prefs.update(state["prefs"])
            
            open_files = state.get("open_files", [])
            if not open_files: self.editor_view._create_new_tab()
            else:
                for f in open_files:
                    if not f.startswith("remote::") and Path(f).is_file():
                        self.editor_view.editor_open_file(filepath=Path(f))
            
            ms, es = state.get("main_sash_pos"), state.get("editor_sash_pos")
            if ms and es:
                def apply(e):
                    self.unbind("<Configure>")
                    self.after(10, lambda: (self.main_pane.sashpos(0, ms), self.editor_pane.sashpos(0, es)))
                self.bind("<Configure>", apply, "+")
        except Exception: self.editor_view._create_new_tab()
        self._apply_font_prefs()

    def _set_initial_sash_position(self):
        try:
            self.main_pane.sash_place(0, 0, int(self.main_pane.winfo_height() * 0.80))
            self.editor_pane.sash_place(0, int(self.editor_pane.winfo_width() * 0.25), 0)
        except tk.TclError: pass

    def _on_closing(self):
        dirty = [d["filepath"].name for d in self.tabs.values() if d["is_dirty"]]
        if dirty:
            if not messagebox.askyesno("Confirm", f"Unsaved changes in:\n{', '.join(dirty)}\nExit anyway?"): return
        self.watcher_client.reset()
        self._save_state()
        self.destroy()

    # --- Session / Watcher Logic ---
    def _update_watcher_list(self):
        try:
            LOCAL_REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
            self.sync_manager.pull_dir(REMOTE_REGISTRY_PATH, str(LOCAL_REGISTRY_DIR), delete=True, timeout=30)
        except Exception: return # Silent fail

        infos = load_active_watchers(LOCAL_REGISTRY_DIR, WATCHER_HEARTBEAT_TIMEOUT_SEC)
        watchers_by_label, choices = {}, []
        seen = set()
        for info in infos:
            lbl = info.display_name
            if lbl in seen: lbl = f"{lbl} ({info.watcher_id})"
            seen.add(lbl)
            watchers_by_label[lbl] = {"id": info.watcher_id, "display_name": info.display_name}
            choices.append(lbl)
        
        self.watchers = watchers_by_label
        self.watcher_combo["values"] = choices
        if choices and not self.watcher_combo.get():
            self.watcher_combo.set(choices[0])
            self._on_watcher_selected()

    def _on_watcher_selected(self, event=None):
        name = self.watcher_combo.get()
        if not name: return
        wid = self.watchers[name]["id"]
        local_wd = LOCAL_SESSIONS_ROOT / wid
        remote_wd = f"{REMOTE_SESSIONS_PATH}/{wid}/"
        sessions = []
        try:
            self.sync_manager.pull_dir(remote_wd, str(local_wd), delete=True, timeout=60)
            if local_wd.is_dir():
                sessions = sorted([p.name for p in local_wd.iterdir() if p.is_dir()])
        except Exception as e: messagebox.showwarning("Error", f"Failed to list sessions: {e}")
        
        self.session_combo["values"] = sessions
        if sessions: self.session_combo.set(sessions[0]); self._on_session_selected()
        else: self.session_combo.set("")

    def _on_session_selected(self, event=None):
        wname, sname = self.watcher_combo.get(), self.session_combo.get()
        if not wname or not sname:
            self._clear_connection()
            return
        wid = self.watchers[wname]["id"]
        self._switch_to_session(wid, sname)

    def _create_session(self):
        wname = self.watcher_combo.get()
        if not wname: return
        wid = self.watchers[wname]["id"]
        new_name = self.new_session_var.get().strip()
        if not new_name or any(c in new_name for c in r'\/:*?"<>|'): return
        
        local_sess = LOCAL_SESSIONS_ROOT / wid / new_name
        if local_sess.exists():
            messagebox.showwarning("Error", "Session already exists locally.")
            return
        
        dlg = RunnerConfigDialog(self, {"mode": "host", "mount_path": "/workspace"})
        self.wait_window(dlg)
        
        config_data = dlg.result
        if not config_data:
            config_data = {"mode": "host"}

        try:
            local_sess.mkdir(parents=True, exist_ok=True)
            
            config_path = local_sess / ".runner_config.json"
            config_path.write_text(json.dumps(config_data, indent=2), encoding="utf-8")
            
            remote_wd = f"{REMOTE_SESSIONS_PATH}/{wid}"
            self.sync_manager.run_sync_command(["ssh", REMOTE_SERVER, f"mkdir -p '{remote_wd}'"], check=True)
            
            self.sync_manager.push_dir(str(local_sess)+"/", f"{remote_wd}/{new_name}/", timeout=120)
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to create session: {e}")
            return
        
        self.new_session_var.set("")
        self._on_watcher_selected()
        self.after(500, lambda: self.session_combo.set(new_name))
        self.after(600, self._on_session_selected)

    def _clear_connection(self):
        self.current_watcher_id = None
        self.current_session_name = None
        self.watcher_client.reset()
        self.terminal.reset_to_disconnected_state()
        self.command_file = None
        self.log_file = None
        self.file_tree_panel.populate(None)
        self._update_editor_title()

    def _switch_to_session(self, wid: str, sname: str):
        if self.current_watcher_id == wid and self.current_session_name == sname: return
        self.current_watcher_id, self.current_session_name = wid, sname
        session_dir = LOCAL_SESSIONS_ROOT / wid / sname
        session_dir.mkdir(parents=True, exist_ok=True)
        self.command_file = session_dir / "commands.txt"
        self.log_file = session_dir / "commands.log"
        self.status_file = session_dir / ".watcher_status.json"
        
        self.current_tree_root = session_dir
        self.file_tree_panel.populate(session_dir)
        
        self.terminal.view.config(state=tk.NORMAL)
        self.terminal.view.delete("1.0", tk.END)
        self.terminal.append_log(f"[--- Switched to: '{sname}' ---]\n")
        
        try:
            remote_sess = f"{REMOTE_SESSIONS_PATH}/{wid}/{sname}/"
            self.sync_manager.pull_file(f"{remote_sess}commands.log", str(self.log_file), timeout=30)
            if self.log_file.exists():
                content = self.log_file.read_text(encoding="utf-8", errors="replace")
                init_log = "\n".join(content.splitlines()[-INIT_TAIL_LINES:])
                self.terminal.process_and_append_log(init_log + "\n")
                self.watcher_client.log_pos = self.log_file.stat().st_size
            else: self.watcher_client.log_pos = 0
        except Exception: self.watcher_client.log_pos = 0
        
        self.terminal._show_remote_prompt()
        self.watcher_client.start_log_polling()

    def sync_current_session_dir(self, delete=True):
        if not (self.current_watcher_id and self.current_session_name): return
        wid = Path(self.current_watcher_id).stem
        remote = f"{REMOTE_SESSIONS_PATH}/{wid}/{self.current_session_name}/"
        local = str(LOCAL_SESSIONS_ROOT / wid / self.current_session_name) + "/"
        
        def on_done(res, err):
            if err: self._set_status(f"Sync failed: {err}")
            else: 
                self.file_tree_panel.populate(self.current_tree_root)
                self._set_status("Synced")
        
        cmd = ["rsync", "-az"]
        if delete: cmd.append("--delete")
        cmd.extend([f"{REMOTE_SERVER}:{remote}", local])
        self.sync_manager.run_sync_command_async(cmd, on_done=on_done)
        
    def _set_status(self, msg): pass 

    # --- Compatibility Methods for External Components ---
    
    def _sync_pull_file(self, remote, local, timeout=30):
        # Bridge for TerminalFrame which calls this directly
        return self.sync_manager.pull_file(remote, local, timeout=timeout)
        
    def request_send_command(self, cmd):
        # Bridge for TerminalFrame
        self.watcher_client.send_command(cmd)
        self.watcher_client.fetch_log_updates()

    # --- File Tree Interactions ---
    def browse_file_tree_root(self):
        init_dir = str(LOCAL_SESSIONS_ROOT / self.current_watcher_id if self.current_watcher_id else LOCAL_BASE_DIR)
        dlg = DirectoryPicker(self, title="Select Directory", initialdir=init_dir, show_hidden=False, 
                              shortcuts=[("Home", Path.home()), ("Sessions", LOCAL_SESSIONS_ROOT)], geometry="720x520")
        sel = dlg.show()
        if sel: 
            self.current_tree_root = Path(sel)
            self.file_tree_panel.populate(Path(sel))
            
    def jump_to_mirror(self):
        if not self.current_session_name: return
        p = LOCAL_SESSIONS_ROOT / self.current_watcher_id / self.current_session_name
        p.mkdir(parents=True, exist_ok=True)
        self.current_tree_root = p
        self.file_tree_panel.populate(p)

    def prompt_create_symlink(self):
        if not self.current_session_name: return
        dlg = tk.Toplevel(self); dlg.title("Create Link"); dlg.geometry("500x200")
        main = ttk.Frame(dlg, style="Dark.TFrame", padding=15); main.pack(fill=tk.BOTH, expand=True)
        
        src_var = tk.StringVar(value=self.remote_cwd or REMOTE_BASE_PATH)
        ttk.Label(main, text="Source (Remote):", style="Dark.TLabel").pack(anchor="w")
        ttk.Entry(main, textvariable=src_var, width=50, style="Dark.TEntry").pack(fill=tk.X, pady=5)
        
        name_var = tk.StringVar(value="project_link")
        ttk.Label(main, text="Link Name:", style="Dark.TLabel").pack(anchor="w")
        ttk.Entry(main, textvariable=name_var, width=50, style="Dark.TEntry").pack(fill=tk.X, pady=5)
        
        def ok():
            s, n = src_var.get().strip(), name_var.get().strip()
            if not s or not n or '/' in n: return
            self.watcher_client.send_command(f"_internal_create_link::{s}::{n}")
            dlg.destroy()
            self.after(2000, lambda: self.file_tree_panel.populate(self.current_tree_root))
            
        ttk.Button(main, text="Create", command=ok, style="Dark.TButton").pack(side=tk.RIGHT, pady=10)

    def start_inline_new_entry(self, parent_iid, dir_path, is_dir):
        self.file_tree_panel.tree.item(parent_iid, open=True)
        ph = self.file_tree_panel.tree.insert(parent_iid, "end", text="", values=[str(dir_path)], tags=("virtual_file",))
        self.file_tree_panel.tree.see(ph)
        
        def place():
            bbox = self.file_tree_panel.tree.bbox(ph, "#0")
            if not bbox: self.after(30, place); return
            entry = tk.Entry(self.file_tree_panel.tree)
            entry.place(x=bbox[0], y=bbox[1], width=bbox[2], height=bbox[3])
            entry.focus_set()
            
            def finish(commit):
                name = entry.get().strip()
                entry.destroy()
                self.file_tree_panel.tree.delete(ph)
                if not commit or not name: return
                
                try: rel_dir = dir_path.relative_to(self.current_tree_root).as_posix()
                except: rel_dir = ""
                
                full_rel = f"{rel_dir}/{name}" if rel_dir and rel_dir != "." else name
                cmd = "_internal_create_dir" if is_dir else "_internal_create_file"
                self.watcher_client.send_command(f"{cmd}::{full_rel}")
                self.watcher_client.send_command(f"_internal_list_dir::{rel_dir or '.'}")

            entry.bind("<Return>", lambda e: finish(True))
            entry.bind("<Escape>", lambda e: finish(False))
            entry.bind("<FocusOut>", lambda e: finish(True))
        self.after(0, place)

    def handle_ls_done(self, rel_path):
        # Update Virtual Tree
        session_root = LOCAL_SESSIONS_ROOT / self.current_watcher_id / self.current_session_name
        res_file = session_root / ".ls_result.txt"
        
        remote_res = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}/.ls_result.txt"
        try:
            self.sync_manager.pull_file(remote_res, str(res_file), timeout=30, lightweight=True)
            if not res_file.exists(): return
            content = res_file.read_text(encoding="utf-8", errors="replace")
            if content.startswith("ERROR:"): 
                self.terminal.append_log(f"LS Fail: {content}")
                return
            
            parent_abs = str(self.current_tree_root / rel_path)
            parent_iid = self.file_tree_panel.path_to_iid.get(parent_abs)
            
            if parent_iid:
                # Clear children
                tree = self.file_tree_panel.tree
                for c in tree.get_children(parent_iid): tree.delete(c)
                
                lines = sorted(content.splitlines())
                parent_rel = Path(rel_path)
                
                for line in lines:
                    is_dir = line.endswith('/')
                    name = line.strip('/')
                    local_p = self.current_tree_root / parent_rel / name
                    tags = ["virtual", "virtual_dir" if is_dir else "virtual_file"]
                    
                    iid = tree.insert(parent_iid, "end", text=name, open=False, values=[str(local_p)], tags=tags)
                    self.file_tree_panel.path_to_iid[str(local_p)] = iid
                    if is_dir: tree.insert(iid, "end", text="Loading...", tags=["placeholder"])
                    
        except Exception as e: print(e)

    def _on_file_tree_double_click(self, event=None):
        tree = self.file_tree_panel.tree
        iid = tree.focus()
        if not iid: return
        vals = tree.item(iid, "values")
        tags = tree.item(iid, "tags")
        fpath = Path(vals[0])
        
        if "virtual_file" in tags:
            rel = self._to_posix_rel(fpath.relative_to(self.current_tree_root))
            if self._is_image_file(Path(rel)): self._open_remote_image_preview(rel)
            else: self._open_remote_file_edit(rel)
        elif fpath.is_file() and "virtual" not in tags:
            if self._is_image_file(fpath): self.preview_panel.show_image(fpath)
            else: self.editor_view.editor_open_file(filepath=fpath)

    def _is_image_file(self, path: Path) -> bool:
        return path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}

    def _open_remote_image_preview(self, rel_path):
        self._stage_download(rel_path, "preview")
    def _open_remote_file_edit(self, rel_path):
        # Check open tabs
        for tab in self.tabs.values():
            if tab.get("remote_path") == rel_path:
                self.editor_notebook.select(self.editor_notebook.tabs()[list(self.tabs.values()).index(tab)])
                return
        self._stage_download(rel_path, "edit")

    def _stage_download(self, rel_path, mode):
        if not self.current_session_name: return
        local_dir = LOCAL_EDITING_CACHE / self.current_watcher_id / self.current_session_name / Path(rel_path).parent
        local_dir.mkdir(parents=True, exist_ok=True)
        local_path = local_dir / Path(rel_path).name
        
        self.pending_download_info = {"remote_relative_path": rel_path, "local_cache_path": local_path, "mode": mode}
        self.watcher_client.send_command(f"_internal_stage_file_for_download::{rel_path}", False)
        self.watcher_client.fetch_log_updates()

    def execute_pending_download(self):
        info = self.pending_download_info
        if not info: return
        self.pending_download_info = None
        
        remote_staged = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}/.staged_for_download"
        try:
            self.sync_manager.pull_file(remote_staged, str(info["local_cache_path"]), timeout=60)
            if info["mode"] == "preview":
                self.preview_panel.show_image(info["local_cache_path"], remote_path=info["remote_relative_path"])
            else:
                self.editor_view.editor_open_file(filepath=info["local_cache_path"], remote_path=info["remote_relative_path"])
        except Exception as e: messagebox.showerror("Download Error", str(e))

    def _upload_cached_remote_file(self, rel_path, local_path):
        if not (self.current_watcher_id and self.current_session_name): return
        token = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
        remote_base = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}"
        staged_dir = f"{remote_base}/.staged_uploads"
        
        try:
            self.sync_manager.run_sync_command(["ssh", REMOTE_SERVER, f"mkdir -p '{staged_dir}'"], check=True)
            self.sync_manager.push_file(str(local_path), f"{staged_dir}/{token}", timeout=60)
            self.watcher_client.send_command(f"_internal_move_staged_file::{token}::{rel_path}")
            self.watcher_client.fetch_log_updates()
        except Exception: pass

    def _update_editor_title(self):
        tab = self.editor_view._get_current_tab_data()
        if not tab: self.editor_file_label.config(text="No file"); return
        
        rp, fp = tab.get("remote_path"), tab.get("filepath")
        name = Path(rp).name if rp else (fp.name if fp else "Untitled")
        disp = f"[REMOTE] {rp}" if rp else str(fp or "Untitled")
        dirty = "*" if tab["is_dirty"] else ""
        
        self.editor_file_label.config(text=disp)
        try: self.editor_notebook.tab(self.editor_notebook.select(), text=f"{name}{dirty}")
        except: pass

    # --- Terminal Utils ---
    def _run_current_python_file(self, event=None):
        tab = self.editor_view._get_current_tab_data()
        if not tab: return
        self.editor_view.editor_save_file()
        
        if self.terminal.terminal_mode.get() == "Remote" and self.current_session_name:
            fname = Path(tab.get("remote_path") or tab.get("filepath")).name
            self.terminal._show_remote_prompt()
            cmd = f"python3 {shlex.quote(fname)}"
            self.terminal.append_log(cmd)
            self.watcher_client.send_command(cmd)
            self.watcher_client.fetch_log_updates()
        else:
            if tab.get("filepath"):
                cmd = f"python3 {shlex.quote(str(tab['filepath'].resolve()))}"
                self.terminal.terminal_mode.set("Local")
                self.terminal._execute_local_command(cmd)

    def _copy_selection(self, event=None):
        try:
            txt = self.terminal.view.selection_get()
            self.clipboard_clear(); self.clipboard_append(txt)
        except: pass

    def _show_context_menu(self, event):
        try: self.terminal.view.selection_get(); s="normal"
        except: s="disabled"
        self.terminal_context_menu.entryconfigure("Copy", state=s)
        self.terminal_context_menu.tk_popup(event.x_root, event.y_root)

    # --- Utils ---
    def _to_posix_rel(self, rel):
        s = rel.as_posix() if isinstance(rel, Path) else str(rel).replace('\\', '/')
        while s.startswith('/'): s = s[1:]
        return s

    def _tree_relpath(self, item_id, as_dir=False):
        try:
            val = self.file_tree_panel.tree.item(item_id, "values")[0]
            rel = Path(val).relative_to(self.current_tree_root)
            s = self._to_posix_rel(rel)
            return s if s else ("." if as_dir else "")
        except: return "." if as_dir else ""

    def _font_for(self, widget):
        try: f = widget.cget("font"); return tkfont.nametofont(f) if isinstance(f, str) else tkfont.Font(font=f)
        except: return tkfont.nametofont("TkDefaultFont")

    # --- Global Keys & Editor Search Delegates ---
    def _bind_global_keys(self):
        self.bind_all("<Escape>", self._hide_search_bar)
        mod = "Command" if sys.platform == "darwin" else "Control"
        self.bind_all(f"<{mod}-f>", self._show_search_bar)
        self.bind_all(f"<{mod}-s>", lambda e: self.editor_view.editor_save_file() or "break")
        self.bind_all(f"<{mod}-Shift-s>", self.editor_view.editor_save_file_as)

    def _show_search_bar(self, event=None):
        tab = self.editor_view._get_current_tab_data()
        if not tab: return "break"
        if not self.search_bar_visible:
            self.search_frame.pack(side=tk.RIGHT, padx=10, fill=tk.Y)
            self.search_bar_visible = True
        
        entry = self.search_frame.winfo_children()[0]
        entry.focus_set()
        try:
            sel = tab["text"].selection_get()
            if sel: self.search_var.set(sel); entry.icursor(tk.END)
        except: pass
        return "break"

    def _hide_search_bar(self, event=None):
        if self.search_bar_visible:
            self.search_frame.pack_forget()
            self.search_bar_visible = False
            self._clear_search_highlight()
            t = self.editor_view._get_current_tab_data()
            if t: t["text"].focus_set()

    def _perform_search(self):
        tab = self.editor_view._get_current_tab_data()
        if not tab: return
        txt, bar = tab["text"], tab["marker_bar"]
        self._clear_search_highlight()
        k = self.search_var.get()
        if not k: return
        
        count = tk.IntVar()
        start = "1.0"
        total = int(txt.index("end-1c").split('.')[0])
        h = bar.winfo_height() if bar else 0
        
        while True:
            pos = txt.search(k, start, stopindex=tk.END, count=count, nocase=True)
            if not pos: break
            end = f"{pos}+{count.get()}c"
            txt.tag_add("search_highlight", pos, end)
            start = end
            if h > 0:
                y = (int(pos.split('.')[0]) / total) * h
                bar.create_rectangle(0, y, 10, y+2, fill="#D8A01D", outline="")

    def _clear_search_highlight(self):
        for t in self.tabs.values():
            t["text"].tag_remove("search_highlight", "1.0", tk.END)
            if t["marker_bar"]: t["marker_bar"].delete("all")

    def _find_next(self, event=None):
        self._find_direction(False)
    def _find_prev(self, event=None):
        self._find_direction(True)
        
    def _find_direction(self, back):
        tab = self.editor_view._get_current_tab_data()
        if not tab: return
        k = self.search_var.get()
        if not k: return
        txt = tab["text"]
        
        start = txt.index(tk.INSERT)
        if not back: start = f"{start}+1c"
        
        pos = txt.search(k, start, stopindex=("1.0" if back else tk.END), backwards=back, nocase=True)
        if not pos: # Wrap
            start = tk.END if back else "1.0"
            pos = txt.search(k, start, stopindex=("1.0" if back else tk.END), backwards=back, nocase=True)
            
        if pos:
            end = f"{pos}+{len(k)}c"
            txt.tag_remove(tk.SEL, "1.0", tk.END)
            txt.tag_add(tk.SEL, pos, end)
            txt.mark_set(tk.INSERT, pos)
            txt.see(pos)
            txt.focus_set()

    # --- Preferences ---
    def open_preferences(self):
        dlg = tk.Toplevel(self); dlg.title("Preferences"); dlg.transient(self); dlg.grab_set()
        f = ttk.Frame(dlg, style="Dark.TFrame", padding=15); f.pack(fill=tk.BOTH, expand=True)
        
        fams = sorted(set(tkfont.families()))
        pref = ["Menlo", "Consolas", "Courier New", "Monaco"]
        fams = pref + [x for x in fams if x not in pref]
        
        ev_fam, ev_sz = tk.StringVar(value=self.prefs["editor_family"]), tk.IntVar(value=self.prefs["editor_size"])
        tv_fam, tv_sz = tk.StringVar(value=self.prefs["term_family"]), tk.IntVar(value=self.prefs["term_size"])
        
        def r(r, l, v, s):
            ttk.Label(f, text=l, style="Dark.TLabel").grid(row=r, column=0, sticky="w")
            ttk.Combobox(f, values=fams, textvariable=v, width=30, style="Dark.TCombobox").grid(row=r, column=1, padx=5)
            ttk.Spinbox(f, from_=8, to=48, textvariable=s, width=5, style="Dark.TSpinbox").grid(row=r, column=2)
            
        r(0, "Editor Font", ev_fam, ev_sz)
        r(1, "Terminal Font", tv_fam, tv_sz)
        
        def save():
            self.prefs.update({"editor_family": ev_fam.get(), "editor_size": ev_sz.get(), "term_family": tv_fam.get(), "term_size": tv_sz.get()})
            self._apply_font_prefs()
            self._save_state()
            dlg.destroy()
            
        ttk.Button(f, text="Save", command=save, style="Dark.TButton").grid(row=3, column=1, pady=10)

    def _apply_font_prefs(self):
        ef, es = self.prefs["editor_family"], self.prefs["editor_size"]
        self.mono_font.configure(family=ef, size=es)
        
        for t in self.tabs.values():
            font = t.get("shared_font")
            if font and isinstance(font, tkfont.Font):
                font.configure(family=ef, size=es)

        tf, ts = self.prefs["term_family"], self.prefs["term_size"]
        try:
            tv = self.terminal.view
            current_font = tkfont.nametofont(tv.cget("font")) if isinstance(tv.cget("font"), str) else tv.cget("font")
            if not isinstance(current_font, tkfont.Font):
                new_font = tkfont.Font(family=tf, size=ts)
                tv.configure(font=new_font)
            else:
                current_font.configure(family=tf, size=ts)
        except Exception: 
            pass
        
    def _open_runner_config(self):
        if not self.current_session_name:
            messagebox.showinfo("Info", "Please select a session first.")
            return

        # 現在の設定を読み込む（ローカルキャッシュにあれば）
        config_path = self.current_tree_root / ".runner_config.json"
        current_conf = {}
        if config_path.exists():
            try:
                current_conf = json.loads(config_path.read_text("utf-8"))
            except: pass
        
        dlg = RunnerConfigDialog(self, current_conf)
        self.wait_window(dlg)
        
        if dlg.result:
            # 保存
            try:
                config_path.write_text(json.dumps(dlg.result, indent=2), encoding="utf-8")
                
                # ★ 即座にリモートへPushして反映させる
                remote_dir = f"{REMOTE_SESSIONS_PATH}/{self.current_watcher_id}/{self.current_session_name}"
                self.sync_manager.push_file(str(config_path), f"{remote_dir}/.runner_config.json", timeout=10)
                
                # ターミナルに通知
                if hasattr(self, 'terminal'):
                    self.terminal.append_log(f"[GUI] Updated runner config: {dlg.result['mode']}\n")
                    
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save runner config: {e}")