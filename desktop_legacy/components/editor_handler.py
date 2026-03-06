# components/editor_handler.py
import re
import tkinter as tk
from config import INDENT_STRING, INDENT_WIDTH

class EditorEventHandlerMixin:
    """Methods expected by EditorView (editor.py) to be present on self.app"""

    def _on_tab_key(self, event=None):
        tab_data = self.editor_view._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        if self.completion_popup: return "break"
        
        try:
            # Multi-line indent
            start_index = editor_text.index("sel.first")
            end_index = editor_text.index("sel.last")
            start_line = int(start_index.split('.')[0])
            end_line = int(end_index.split('.')[0])
            if start_line != end_line:
                if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
                for line in range(start_line, end_line + 1):
                    editor_text.insert(f"{line}.0", INDENT_STRING)
                return "break"
        except tk.TclError: pass
        
        # Single line indent or completion
        text_before = editor_text.get("insert linestart", "insert")
        if not text_before.strip():
            editor_text.insert(tk.INSERT, INDENT_STRING)
        else:
            self._perform_completion()
        return "break"

    def _on_shift_tab_key(self, event=None):
        tab_data = self.editor_view._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try:
            start_index = editor_text.index("sel.first"); end_index = editor_text.index("sel.last")
            start_line = int(start_index.split('.')[0]); end_line = int(end_index.split('.')[0])
            if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
        except tk.TclError:
            start_line = end_line = int(editor_text.index(tk.INSERT).split('.')[0])
        for line in range(start_line, end_line + 1):
            line_start = f"{line}.0"
            line_text = editor_text.get(line_start, f"{line}.end")
            if line_text.startswith(INDENT_STRING):
                editor_text.delete(line_start, f"{line_start}+{INDENT_WIDTH}c")
            elif line_text.startswith("\t"):
                editor_text.delete(line_start, f"{line_start}+1c")
            elif line_text and line_text[0].isspace():
                space_count = len(line_text) - len(line_text.lstrip(' '))
                to_delete = min(INDENT_WIDTH, space_count)
                if to_delete > 0: editor_text.delete(line_start, f"{line_start}+{to_delete}c")
        return "break"

    def _on_editor_return(self, event=None):
        tab_data = self.editor_view._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try: editor_text.delete("sel.first", "sel.last")
        except tk.TclError: pass
        
        cursor_pos = editor_text.index(tk.INSERT)
        line_start = f"{cursor_pos} linestart"
        prev_line = editor_text.get(line_start, f"{line_start} lineend")
        match = re.match(r'^(\s*)', prev_line)
        current_indent = match.group(1) if match else ""
        next_indent = current_indent
        if prev_line.strip().endswith(':'): next_indent += INDENT_STRING
        
        editor_text.insert(tk.INSERT, f"\n{next_indent}")
        editor_text.see(tk.INSERT)
        return "break"

    def _toggle_comment(self, event=None):
        tab_data = self.editor_view._get_current_tab_data()
        if not tab_data: return "break"
        editor_text = tab_data["text"]
        try:
            start_index, end_index = editor_text.index("sel.first"), editor_text.index("sel.last")
            start_line, end_line = int(start_index.split('.')[0]), int(end_index.split('.')[0])
            if end_index.split('.')[1] == "0" and start_index != end_index: end_line -= 1
        except tk.TclError:
            start_line = end_line = int(editor_text.index("insert").split('.')[0])
        
        lines = range(start_line, end_line + 1)
        # Check if all lines are commented
        all_commented = True
        for l in lines:
            txt = editor_text.get(f"{l}.0", f"{l}.end")
            if txt.strip() and not txt.lstrip().startswith("#"):
                all_commented = False
                break
        
        for l in lines:
            line_text = editor_text.get(f"{l}.0", f"{l}.end")
            if not line_text.strip(): continue
            
            if all_commented:
                # Uncomment
                if line_text.lstrip().startswith("# "):
                    pos = line_text.find("# ")
                    editor_text.delete(f"{l}.{pos}", f"{l}.{pos+2}")
                elif line_text.lstrip().startswith("#"):
                    pos = line_text.find("#")
                    editor_text.delete(f"{l}.{pos}", f"{l}.{pos+1}")
            else:
                # Comment
                ws_len = len(line_text) - len(line_text.lstrip())
                editor_text.insert(f"{l}.{ws_len}", "# ")
        
        editor_text.tag_remove("sel", "1.0", "end")
        editor_text.tag_add("sel", f"{start_line}.0", f"{end_line+1}.0")
        return "break"

    def _perform_completion(self):
        tab_data = self.editor_view._get_current_tab_data()
        if not tab_data: return
        editor_text = tab_data["text"]
        text_before = editor_text.get("1.0", "insert")
        prefix_match = re.search(r'[\w\.]*$', text_before)
        prefix = prefix_match.group(0) if prefix_match else ""
        if not prefix: return
        
        words = re.findall(r'[\w\.]+', editor_text.get("1.0", "end-1c"))
        seen = set()
        candidates = []
        for w in words:
            if w.startswith(prefix) and w != prefix and w not in seen:
                seen.add(w); candidates.append(w)
        
        if not candidates: return
        if len(candidates) == 1:
            editor_text.insert("insert", candidates[0][len(prefix):])
        else:
            self._create_completion_popup(candidates, len(prefix))

    def _create_completion_popup(self, candidates, prefix_len):
        tab_data = self.editor_view._get_current_tab_data()
        editor_text = tab_data["text"]
        self._destroy_completion_popup()
        
        x, y, _, height = editor_text.bbox(tk.INSERT)
        root_x, root_y = editor_text.winfo_rootx() + x, editor_text.winfo_rooty() + y + height
        
        self.completion_popup = tk.Toplevel(self)
        self.completion_popup.overrideredirect(True)
        self.completion_popup.geometry(f"+{root_x}+{root_y}")
        
        lb = tk.Listbox(self.completion_popup, bg=self.UI_COLORS["TEXT_BG"], fg=self.UI_COLORS["TEXT_FG"],
                        selectbackground=self.UI_COLORS["SELECT_BG"], selectforeground=self.UI_COLORS["SELECT_FG"])
        lb.pack(fill=tk.BOTH, expand=True)
        for c in candidates: lb.insert(tk.END, c)
        lb.selection_set(0)
        
        def select(e):
            if not lb.curselection(): self._destroy_completion_popup(); return
            val = lb.get(lb.curselection())[prefix_len:]
            editor_text.insert("insert", val)
            editor_text.focus_set()
            self._destroy_completion_popup()
            return "break"
            
        lb.bind("<Return>", select)
        lb.bind("<Tab>", select)
        lb.bind("<Double-Button-1>", select)
        lb.bind("<Escape>", lambda e: self._destroy_completion_popup())
        lb.focus_set()

    def _destroy_completion_popup(self):
        if self.completion_popup:
            self.completion_popup.destroy()
            self.completion_popup = None
            tab_data = self.editor_view._get_current_tab_data()
            if tab_data: tab_data["text"].focus_set()

    def _editor_delete_line(self, event=None):
        tab = self.editor_view._get_current_tab_data()
        if not tab: return "break"
        tab["text"].delete("insert linestart", "insert +1l linestart")
        return "break"

    def _editor_move_line_up(self, event=None):
        self._move_line(-1); return "break"
    def _editor_move_line_down(self, event=None):
        self._move_line(1); return "break"

    def _move_line(self, direction):
        tab = self.editor_view._get_current_tab_data()
        if not tab: return
        text = tab["text"]
        try:
            sel_start, sel_end = text.index("sel.first"), text.index("sel.last")
            start = int(sel_start.split('.')[0])
            end = int(sel_end.split('.')[0])
            if sel_end.split('.')[1] == "0" and sel_start != sel_end: end -= 1
        except tk.TclError:
            start = end = int(text.index("insert").split('.')[0])
        
        if direction == -1 and start <= 1: return
        last_line = int(text.index("end-1c").split('.')[0])
        if direction == 1 and end >= last_line: return
        
        target_start = f"{start}.0"
        target_end = f"{end+1}.0"
        content = text.get(target_start, target_end)
        if not content.endswith('\n'): content += '\n'
        
        text.delete(target_start, target_end)
        dest_line = start + direction
        text.insert(f"{dest_line}.0", content)
        
        new_start = f"{dest_line}.0"
        new_end = f"{dest_line + (end-start) + 1}.0"
        text.tag_add("sel", new_start, new_end)
        text.mark_set("insert", new_start)
    
    def _on_selection_changed(self, event=None):
        tab_data = self.editor_view._get_current_tab_data()
        if not tab_data: return
        if tab_data["selection_timer"]: self.after_cancel(tab_data["selection_timer"])
        tab_data["selection_timer"] = self.after(200, self._update_selection_highlights)

    def _update_selection_highlights(self):
        tab = self.editor_view._get_current_tab_data()
        if not tab: return
        txt, bar = tab["text"], tab["marker_bar"]
        bar.delete("selection_marker")
        txt.tag_remove("selection_match_highlight", "1.0", tk.END)
        
        try: sel = txt.selection_get()
        except: return
        if not sel or len(sel) < 2: return
        
        start = "1.0"
        total = int(txt.index("end-1c").split('.')[0])
        h = bar.winfo_height()
        while True:
            pos = txt.search(sel, start, stopindex=tk.END, exact=True)
            if not pos: break
            end = f"{pos}+{len(sel)}c"
            if h > 0:
                y = (int(pos.split('.')[0]) / total) * h
                bar.create_rectangle(0, y, 10, y+2, fill="#6A9ECF", outline="", tags="selection_marker")
            if not txt.compare(pos, "==", "sel.first"):
                txt.tag_add("selection_match_highlight", pos, end)
            start = end