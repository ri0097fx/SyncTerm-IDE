# components/editor.py
from __future__ import annotations
import os
import sys
import re
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import tkinter.font as tkfont

from pygments import lex
from pygments.lexers import guess_lexer_for_filename, get_lexer_by_name
from pygments.token import Token

# Fallback（app から上書きされます）
REHIGHLIGHT_DELAY_MS = 500
LINE_NUMBER_UPDATE_DELAY_MS = 100
INDENT_WIDTH = 4
INDENT_STRING = " " * INDENT_WIDTH
COMBO_BG = "#2A343F"


class EditorView(ttk.Frame):
    """
    Phase-1: エディタ UI + 基礎ロジック（open/save/new tab/ハイライト/行番号/タブクローズ）
    それ以外（検索・補完・行移動・コメント切替など）は現状 app 側を呼び出します。
    """
    def __init__(self, parent, app):
        super().__init__(parent, style="Dark.TFrame")
        self.app = app

        # ---- theme/定数を app から継承（無ければ最小フォールバック）----
        self.TEXT_BG = getattr(app, "TEXT_BG", "#1e1e1e")
        self.TEXT_FG = getattr(app, "TEXT_FG", "#e0e0e0")
        self.INSERT_FG = getattr(app, "INSERT_FG", "#ffffff")
        self.SELECT_BG = getattr(app, "SELECT_BG", "#264f78")
        self.SELECT_FG = getattr(app, "SELECT_FG", "#ffffff")
        self.BORDER_CLR = getattr(app, "BORDER_CLR", "#2d2d2d")
        self.HL = getattr(app, "HL", {})
        self.mono_font = getattr(app, "mono_font", ("Consolas", 12))
        self.REHIGHLIGHT_DELAY_MS = getattr(app, "REHIGHLIGHT_DELAY_MS", REHIGHLIGHT_DELAY_MS)
        self.LINE_NUMBER_UPDATE_DELAY_MS = getattr(app, "LINE_NUMBER_UPDATE_DELAY_MS", LINE_NUMBER_UPDATE_DELAY_MS)
        self.INDENT_STRING = getattr(app, "INDENT_STRING", INDENT_STRING)
        self.COMBO_BG = getattr(app, "COMBO_BG", COMBO_BG)

        # ---- state ----
        self.tabs: dict[str, dict] = {}
        self.completion_popup = None
        self.search_bar_visible = getattr(app, "search_bar_visible", False)
        self.search_var = getattr(app, "search_var", tk.StringVar())  # 既存を共有

        # ---- Toolbar ----
        editor_toolbar = ttk.Frame(self, style="Dark.TFrame", padding=(8, 6))
        editor_toolbar.pack(side=tk.TOP, fill=tk.X)

        ttk.Button(editor_toolbar, text="Open File", command=self.editor_open_file,
                   style="Dark.TButton").pack(side=tk.LEFT)
        ttk.Button(editor_toolbar, text="Save File", command=self.editor_save_file,
                   style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))
        ttk.Button(editor_toolbar, text="Save As...", command=self.editor_save_file_as,
                   style="Dark.TButton").pack(side=tk.LEFT, padx=(6, 0))

        self.file_label = ttk.Label(editor_toolbar, text="No file opened", style="Dark.TLabel")
        self.file_label.pack(side=tk.LEFT, padx=(12, 0))
        app.editor_file_label = self.file_label  # 互換公開

        # ---- 検索バー（UIのみ。ロジックは当面 app を使用）----
        self.search_frame = ttk.Frame(editor_toolbar, style="Dark.TFrame")
        app.search_frame = self.search_frame  # 互換公開
        search_entry = ttk.Entry(self.search_frame, textvariable=self.search_var,
                                 style="Dark.TEntry", width=20)
        search_entry.pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(self.search_frame, text="Next ↓",
                   command=getattr(app, "_find_next", lambda: None),
                   style="Dark.TButton", width=7).pack(side=tk.LEFT)
        ttk.Button(self.search_frame, text="Prev ↑",
                   command=getattr(app, "_find_prev", lambda: None),
                   style="Dark.TButton", width=7).pack(side=tk.LEFT, padx=4)
        ttk.Button(self.search_frame, text="Highlight",
                   command=getattr(app, "_perform_search", lambda: None),
                   style="Dark.TButton").pack(side=tk.LEFT)
        ttk.Button(self.search_frame, text="✖",
                   command=getattr(app, "_hide_search_bar", lambda: None),
                   style="Dark.TButton", width=3).pack(side=tk.LEFT, padx=4)
        search_entry.bind("<Return>",        lambda e: getattr(app, "_find_next",  lambda: None)())
        search_entry.bind("<Shift-Return>",  lambda e: getattr(app, "_find_prev",  lambda: None)())
        search_entry.bind("<Escape>",        getattr(app, "_hide_search_bar",      lambda e=None: None))

        # ---- Notebook ----
        self.editor_notebook = ttk.Notebook(self, style="Closable.TNotebook")
        self.editor_notebook.pack(fill=tk.BOTH, expand=True)
        app.editor_notebook = self.editor_notebook  # 互換公開

        # 以降は EditorView のハンドラを使用
        self.editor_notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)
        self.editor_notebook.bind("<ButtonPress-1>",        self._on_close_press)
        self.editor_notebook.bind("<ButtonRelease-1>",      self._on_close_release)

    # ============================ Core (moved) ============================

    def _create_new_tab(self, filepath=None, remote_path=None):
        tab_frame = ttk.Frame(self.editor_notebook, style="Dark.TFrame")
        tab_frame.grid_rowconfigure(0, weight=1)
        tab_frame.grid_columnconfigure(1, weight=1)
        if isinstance(self.mono_font, tkfont.Font):
            shared_font = getattr(self.app, "mono_font", self.mono_font)
        else:
            if isinstance(self.mono_font, tuple) and len(self.mono_font) >= 2:
                family, size = self.mono_font[0], int(self.mono_font[1])
            else:
                family, size = "Consolas", 12
            shared_font = tkfont.Font(family=family, size=size)

        line_numbers = tk.Text(
            tab_frame, width=4, padx=4, takefocus=0, bd=0, bg=self.COMBO_BG, fg="#888888",
            state="disabled", wrap="none", font=shared_font, highlightthickness=3,
            highlightbackground=self.COMBO_BG
        )
        line_numbers.grid(row=0, column=0, sticky="ns")

        editor_text = tk.Text(
            tab_frame, wrap="word", undo=True, bg=self.TEXT_BG, fg=self.TEXT_FG,
            insertbackground=self.INSERT_FG, selectbackground=self.SELECT_BG,
            selectforeground=self.SELECT_FG, font=shared_font, highlightthickness=4,
            highlightbackground=self.COMBO_BG, highlightcolor="#3B729F",
            relief="flat", borderwidth=0
        )
        editor_text.grid(row=0, column=1, sticky="nsew")
        editor_text.tag_configure("search_highlight", background="#D8A01D", foreground="#000000")
        editor_text.tag_configure("selection_match_highlight", background="#4A4A4A")

        marker_bar = tk.Canvas(tab_frame, width=10, bg=self.COMBO_BG, highlightthickness=0)
        marker_bar.grid(row=0, column=2, sticky="ns")
        marker_bar.bind("<Button-1>", self._on_marker_bar_click)

        scrollbar = ttk.Scrollbar(tab_frame, orient="vertical", command=self._on_scrollbar_move)
        scrollbar.grid(row=0, column=3, sticky="ns")

        editor_text['yscrollcommand'] = self._on_text_scroll
        line_numbers['yscrollcommand'] = self._on_text_scroll

        tab_title = os.path.basename(filepath or remote_path) if (filepath or remote_path) else "Untitled"
        self.editor_notebook.add(tab_frame, text=tab_title)
        tab_id = self.editor_notebook.tabs()[-1]

        self.tabs[tab_id] = {
            "filepath": filepath, "is_dirty": False, "text": editor_text,
            "line_numbers": line_numbers, "marker_bar": marker_bar, "scrollbar": scrollbar,
            "syntax_tags": set(), "highlight_timer": None, "line_number_timer": None,
            "selection_timer": None, "remote_path": remote_path, "local_cache_path": filepath,
            "shared_font": shared_font,
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

    def editor_open_file(self, filepath: Path | None = None, remote_path: str | None = None):
        if filepath is None and remote_path is None:
            initial = getattr(self.app, "initial_open_dir", os.getcwd())
            filepath_str = filedialog.askopenfilename(initialdir=initial)
            if not filepath_str:
                return
            filepath = Path(filepath_str)

        # 既に開いているタブを選択
        for tab_id, data in self.tabs.items():
            if (filepath and data.get("filepath") == filepath) or \
               (remote_path and data.get("remote_path") == remote_path):
                self.editor_notebook.select(tab_id)
                return

        try:
            content = filepath.read_text("utf-8", errors="replace") if filepath else ""
            tab_id = self._create_new_tab(filepath=filepath, remote_path=remote_path)

            # タブ情報更新
            self.tabs[tab_id]["filepath"] = filepath
            self.tabs[tab_id]["remote_path"] = remote_path
            self.tabs[tab_id]["local_cache_path"] = filepath

            tab_data = self.tabs[tab_id]
            editor_text = tab_data["text"]
            editor_text.delete("1.0", tk.END)
            editor_text.insert("1.0", content)
            tab_data["is_dirty"] = False
            editor_text.edit_modified(False)

            self._update_editor_title()
            self.apply_syntax_highlight(content, str(filepath or remote_path))
            self._update_line_numbers()
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open file:\n{e}")

    def editor_save_file(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return "break"

        filepath = tab_data.get("filepath")
        if not filepath:
            return self.editor_save_file_as(event)

        try:
            content = tab_data["text"].get("1.0", "end-1c")
            Path(filepath).write_text(content, encoding="utf-8")
            tab_data["is_dirty"] = False
            tab_data["text"].edit_modified(False)
            self._update_editor_title()
        except Exception as e:
            messagebox.showerror("Save Error", f"Failed to save file:\n{e}")

    def editor_save_file_as(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return "break"

        initial = str(tab_data.get("filepath") or Path.cwd() / "untitled.txt")
        path = filedialog.asksaveasfilename(
            initialfile=os.path.basename(initial),
            initialdir=os.path.dirname(initial)
        )
        if not path:
            return "break"
        try:
            Path(path).write_text(tab_data["text"].get("1.0", "end-1c"), encoding="utf-8")
            tab_data["filepath"] = Path(path)
            tab_data["is_dirty"] = False
            tab_data["text"].edit_modified(False)
            self._update_editor_title()
        except Exception as e:
            messagebox.showerror("Save Error", f"Failed to save file:\n{e}")

    def _update_editor_title(self):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            self.file_label.config(text="No file opened")
            return

        filepath = tab_data.get("filepath")
        remote_path = tab_data.get("remote_path")

        if remote_path:
            display_path = f"[REMOTE] {remote_path}"
            filename = Path(remote_path).name
        else:
            display_path = str(filepath) if filepath else "Untitled"
            filename = filepath.name if filepath else "Untitled"

        dirty_marker = "*" if tab_data["is_dirty"] else ""
        full_title = f"{filename}{dirty_marker}"

        self.file_label.config(text=display_path)
        try:
            tab_id = self.editor_notebook.select()
            self.editor_notebook.tab(tab_id, text=full_title)
        except tk.TclError:
            pass

    # --------- Syntax highlight & timers ---------

    def _resolve_color(self, ttype):
        t = ttype
        while True:
            if t in self.HL:
                return self.HL[t]
            if t is Token:
                return self.HL.get(Token, self.TEXT_FG)
            t = t.parent

    def apply_syntax_highlight(self, content, filename):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return
        editor_text, syntax_tags = tab_data["text"], tab_data["syntax_tags"]

        for tag in list(syntax_tags):
            editor_text.tag_remove(tag, '1.0', tk.END)
        syntax_tags.clear()

        try:
            lexer = guess_lexer_for_filename(filename, content)
        except Exception:
            lexer = get_lexer_by_name("text")

        idx = "1.0"
        for ttype, value in lex(content, lexer):
            start, end = idx, self._advance_index(idx, value)
            name = str(ttype)
            color = self._resolve_color(ttype)
            editor_text.tag_configure(name, foreground=color)
            syntax_tags.add(name)
            editor_text.tag_add(name, start, end)
            idx = end

        if self.search_var.get():
            # 検索ハイライトは当面 app 側を呼ぶ（後で移行）
            getattr(self.app, "_perform_search", lambda: None)()
        editor_text.see("insert")

    @staticmethod
    def _advance_index(index, text):
        line, col = map(int, index.split("."))
        parts = text.split("\n")
        if len(parts) == 1:
            return f"{line}.{col + len(text)}"
        else:
            return f"{line + len(parts) - 1}.{len(parts[-1])}"

    def _on_editor_modified(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return

        editor_text = tab_data["text"]
        if editor_text.edit_modified():
            if not tab_data["is_dirty"]:
                tab_data["is_dirty"] = True
                self._update_editor_title()
            editor_text.edit_modified(False)
        self._schedule_rehighlight()
        self._schedule_update_line_numbers()

    def _schedule_rehighlight(self, event=None):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return

        if tab_data["highlight_timer"]:
            self.after_cancel(tab_data["highlight_timer"])
        tab_data["highlight_timer"] = self.after(self.REHIGHLIGHT_DELAY_MS, self._rehighlight)

    def _rehighlight(self):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return

        tab_data["highlight_timer"] = None
        filename = tab_data["filepath"] or "untitled.py"
        content = tab_data["text"].get("1.0", "end-1c")
        self.apply_syntax_highlight(content, str(filename))

    def _update_line_numbers(self):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return

        editor_text, line_numbers = tab_data["text"], tab_data["line_numbers"]

        tab_data["line_number_timer"] = None
        line_numbers.config(state="normal")
        line_numbers.delete("1.0", "end")
        try:
            line_count = int(editor_text.index("end-1c").split('.')[0])
            line_numbers.insert("1.0", "\n".join(str(i) for i in range(1, line_count + 1)))
        except tk.TclError:
            pass
        line_numbers.config(state="disabled")
        try:
            line_numbers.yview_moveto(editor_text.yview()[0])
        except Exception:
            pass

    def _schedule_update_line_numbers(self):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return

        if tab_data["line_number_timer"]:
            self.after_cancel(tab_data["line_number_timer"])
        tab_data["line_number_timer"] = self.after(self.LINE_NUMBER_UPDATE_DELAY_MS, self._update_line_numbers)

    # --------- Tab/Notebook events ---------

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
        if not tab_data:
            return

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

    def _on_tab_changed(self, event=None):
        tab_data = self._get_current_tab_data()
        if tab_data:
            tab_data["text"].focus_set()
            try:
                if tab_data.get("remote_path"):
                    self.editor_notebook.configure(style="Remote.TNotebook")
                else:
                    self.editor_notebook.configure(style="Closable.TNotebook")
            except tk.TclError:
                pass
        self._update_editor_title()

    # --------- Scroll linkage ---------

    def _on_text_scroll(self, *args):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return
        tab_data["scrollbar"].set(*args)
        try:
            tab_data["line_numbers"].yview_moveto(args[0])
            tab_data["marker_bar"].yview_moveto(args[0])
        except Exception:
            pass

    def _on_scrollbar_move(self, *args):
        tab_data = self._get_current_tab_data()
        if not tab_data:
            return
        tab_data["text"].yview(*args)
        tab_data["line_numbers"].yview(*args)
        try:
            tab_data["marker_bar"].yview(*args)
        except tk.TclError:
            pass

    # --------- Key bindings（当面は app 実装に委譲する分あり） ---------

    def _bind_editor_keys(self, editor_text: tk.Text):
        editor_text.bind("<FocusIn>", self._handle_editor_focus_in)
        editor_text.bind("<<Modified>>", self._on_editor_modified)

        # ここは段階的移行：今は app 側ハンドラを呼ぶ
        editor_text.bind("<KeyRelease>",       getattr(self.app, "_on_selection_changed",  lambda e: None))
        editor_text.bind("<ButtonRelease-1>",  getattr(self.app, "_on_selection_changed",  lambda e: None))
        editor_text.bind("<Tab>",              getattr(self.app, "_on_tab_key",            lambda e: "break"))
        editor_text.bind("<Shift-Tab>",        getattr(self.app, "_on_shift_tab_key",      lambda e: "break"))
        editor_text.bind("<Return>",           getattr(self.app, "_on_editor_return",      lambda e: "break"))

        if sys.platform == "darwin":
            editor_text.bind("<Command-slash>", getattr(self.app, "_toggle_comment",        lambda e: "break"))
            editor_text.bind("<Command-d>",     getattr(self.app, "_editor_delete_line",    lambda e: "break"))
            editor_text.bind("<Option-Up>",     getattr(self.app, "_editor_move_line_up",   lambda e: "break"))
            editor_text.bind("<Option-Down>",   getattr(self.app, "_editor_move_line_down", lambda e: "break"))
        else:
            editor_text.bind("<Control-slash>", getattr(self.app, "_toggle_comment",        lambda e: "break"))
            editor_text.bind("<Control-d>",     getattr(self.app, "_editor_delete_line",    lambda e: "break"))
            editor_text.bind("<Alt-Up>",        getattr(self.app, "_editor_move_line_up",   lambda e: "break"))
            editor_text.bind("<Alt-Down>",      getattr(self.app, "_editor_move_line_down", lambda e: "break"))

    def _handle_editor_focus_in(self, event=None):
        # 補完ポップアップ破棄（必要なら後続でこちらに移行）
        if getattr(self.app, "completion_popup", None):
            try:
                self.app._destroy_completion_popup()
            except Exception:
                pass

    def _on_marker_bar_click(self, event):
        # 既存実装へ委譲（後続で移行）
        return getattr(self.app, "_on_marker_bar_click", lambda e: None)(event)
