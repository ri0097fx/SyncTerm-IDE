# components/file_tree.py
import sys
import os
import stat
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path

# --- Helper Functions (Private to this module) ---
def _safe_is_dir(p: Path) -> bool:
    try:
        return p.is_dir()
    except OSError:
        return False

def _is_windows_reparse_point(p: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        attrs = os.stat(str(p), follow_symlinks=False).st_file_attributes
        return bool(attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except Exception:
        return False

class FileTreePanel:
    def __init__(self, app, parent_frame):
        self.app = app
        self.parent = parent_frame
        self.tree = None
        self.context_menu = None
        self._context_target = None
        self.path_to_iid = {}
        
        self.toolbar = ttk.Frame(self.parent, style="Dark.TFrame", padding=(8, 6))
        self.toolbar.pack(side=tk.TOP, fill=tk.X)
        self._setup_toolbar()
        
        scroll_frame = ttk.Frame(self.parent)
        scroll_frame.pack(fill=tk.BOTH, expand=True)
        self.tree = ttk.Treeview(scroll_frame, show="tree", selectmode="browse")
        ysb = ttk.Scrollbar(scroll_frame, orient="vertical", command=self.tree.yview)
        xsb = ttk.Scrollbar(scroll_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=ysb.set, xscrollcommand=xsb.set)
        ysb.pack(side=tk.RIGHT, fill=tk.Y)
        xsb.pack(side=tk.BOTTOM, fill=tk.X)
        self.tree.pack(fill=tk.BOTH, expand=True)
        
        self.tree.bind("<Double-1>", self.app._on_file_tree_double_click)
        self.tree.bind("<Button-1>", self.on_click)
        self.tree.bind("<<TreeviewOpen>>", self.on_open)
        self.tree.bind("<Button-3>", self.on_right_click)
        if sys.platform == "darwin":
            self.tree.bind("<Button-2>", self.on_right_click)
            self.tree.bind("<Control-Button-1>", self.on_right_click)
            
        self._create_context_menu()

    def _setup_toolbar(self):
        is_linux = sys.platform.startswith("linux")
        txt_open = "Open" if is_linux else "📁"
        txt_link = "Link" if is_linux else "🔗"
        txt_home = "Home" if is_linux else "🏠"
        
        b1 = ttk.Button(self.toolbar, text=txt_open, width=4, command=self.app.browse_file_tree_root, style="Dark.TButton")
        b1.pack(side=tk.LEFT, padx=(6,0))
        b2 = ttk.Button(self.toolbar, text=txt_link, width=4, command=self.app.prompt_create_symlink, style="Dark.TButton")
        b2.pack(side=tk.LEFT, padx=(6,0))
        b3 = ttk.Button(self.toolbar, text=txt_home, width=4, command=self.app.jump_to_mirror, style="Dark.TButton")
        b3.pack(side=tk.LEFT, padx=(6,0))
        b4 = ttk.Button(self.toolbar, text="↻", width=3, command=lambda: self.app.sync_current_session_dir(delete=True), style="Dark.TButton")
        b4.pack(side=tk.LEFT, padx=(6,0))
        
        self.app._tooltip(b1, "Open Folder")
        self.app._tooltip(b2, "Remote Link Folder")
        self.app._tooltip(b3, "Jump Mirror Home")
        self.app._tooltip(b4, "Refresh Folder Tree")

    def _create_context_menu(self):
        self.context_menu = tk.Menu(self.app, tearoff=0)
        self.context_menu.add_command(label="New File", command=self.on_new_file)
        self.context_menu.add_command(label="New Folder", command=self.on_new_dir)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="Delete", command=self.on_delete)

    def populate(self, root_path: Path):
        for i in self.tree.get_children(): self.tree.delete(i)
        self.path_to_iid.clear()
        if not root_path or not root_path.is_dir(): return
        root_iid = self.tree.insert("", "end", text=str(root_path), open=True)
        self.insert_items(root_path, root_iid)

    def insert_items(self, path: Path, parent_iid: str):
        try:
            self.path_to_iid[str(path)] = parent_iid
            try:
                entries = list(path.iterdir())
            except OSError: return
            
            entries.sort(key=lambda p: (not _safe_is_dir(p), p.name.casefold()))
            
            for item in entries:
                tags = []
                item_icon = ""
                try: is_link_like = item.is_symlink()
                except OSError: is_link_like = True
                
                if os.name == "nt" and not is_link_like and _is_windows_reparse_point(item):
                    is_link_like = True
                    
                if is_link_like:
                    tags.append("symlink")
                    item_icon = self.app.symlink_icon
                
                iid = self.tree.insert(parent_iid, "end", text=item.name, image=item_icon, open=False, values=[str(item)], tags=tags)
                self.path_to_iid[str(item)] = iid
                
                if is_link_like:
                    self.tree.insert(iid, "end", text="Loading...", tags=["placeholder"])
                    continue
                
                if _safe_is_dir(item):
                    self.insert_items(item, iid)
        except Exception: return

    def on_click(self, event):
        region = self.tree.identify_region(event.x, event.y)
        if region != "tree": return
        item_id = self.tree.identify_row(event.y)
        if not item_id: return
        tags = self.tree.item(item_id, "tags")
        children = self.tree.get_children(item_id)
        has_placeholder = bool(children) and self.tree.item(children[0], "text") == "Loading..."
        
        if (("symlink" in tags) or ("virtual_dir" in tags)) and has_placeholder:
            self._request_remote_list(item_id)

    def on_open(self, event=None):
        item_id = self.tree.focus()
        if not item_id: return
        tags = self.tree.item(item_id, "tags")
        children = self.tree.get_children(item_id)
        needs_load = bool(children) and self.tree.item(children[0], "text") == "Loading..."
        if (("virtual_dir" in tags) or ("symlink" in tags)) and needs_load:
            self._request_remote_list(item_id)

    def _request_remote_list(self, item_id):
        full_local_path = Path(self.tree.item(item_id, "values")[0])
        try:
            relative = full_local_path.relative_to(self.app.current_tree_root)
            rel_posix = self.app._to_posix_rel(relative)
            self.app.watcher_client.send_command(f"_internal_list_dir::{rel_posix}")
            self.app.watcher_client.fetch_log_updates()
        except Exception as e: print(e)

    def on_right_click(self, event):
        item_id = self.tree.identify_row(event.y)
        if not item_id: return
        self.tree.selection_set(item_id)
        self.tree.focus(item_id)
        self._context_target = item_id
        try: self.context_menu.tk_popup(event.x_root, event.y_root)
        finally: self.context_menu.grab_release()

    def on_new_file(self): self._context_action_new(False)
    def on_new_dir(self): self._context_action_new(True)

    def _context_action_new(self, is_dir):
        item_id = self._context_target
        if not item_id:
            sel = self.tree.selection()
            if sel: item_id = sel[0]
        
        if not item_id: return
        
        values = self.tree.item(item_id, "values")
        tags = self.tree.item(item_id, "tags")
        if not values: return
        
        node_path = Path(values[0])
        
        is_dir_like = ("dir" in tags) or ("virtual_dir" in tags) or ("symlink" in tags)
        is_file_like = ("virtual_file" in tags) or ("file" in tags)

        if is_file_like and not is_dir_like:
            parent = self.tree.parent(item_id)
            if parent:
                item_id = parent
                node_path = Path(self.tree.item(item_id, "values")[0])
                tags = self.tree.item(item_id, "tags")
                is_dir_like = ("dir" in tags) or ("virtual_dir" in tags) or ("symlink" in tags)
        
        if not is_dir_like:
            messagebox.showwarning("New File/Folder", "フォルダまたはリンクを選択してください。")
            return
        
        self.app.start_inline_new_entry(item_id, node_path, is_dir)

    def on_delete(self):
        item_id = self._context_target
        if not item_id: return
        values = self.tree.item(item_id, "values")
        if not values: return
        node_path = Path(values[0])
        
        try:
            if node_path.resolve() == self.app.current_tree_root.resolve():
                messagebox.showinfo("Delete", "Cannot delete session root")
                return
        except Exception: pass

        name = self.tree.item(item_id, "text")
        if not messagebox.askyesno("Delete", f"Delete '{name}'?"): return
        
        rel_posix = self.app._tree_relpath(item_id, as_dir=False)
        self.app.watcher_client.send_command(f"_internal_delete_path::{rel_posix}")
        try: self.tree.delete(item_id)
        except Exception: pass