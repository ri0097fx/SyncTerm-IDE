import tkinter as tk
from pathlib import Path
from tkinter import ttk, messagebox
import os
import time

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
