# components/image_preview.py
import sys
import tkinter as tk
from tkinter import ttk
from pathlib import Path

try:
    from PIL import Image, ImageTk
    PIL_AVAILABLE = True
except Exception:
    PIL_AVAILABLE = False

class ImagePreviewPanel:
    def __init__(self, app, parent_pane):
        self.app = app
        self.parent_pane = parent_pane
        self.frame = None
        self.canvas = None
        self.label_var = None
        self.label = None
        self.full_label_text = ""
        self.original_image = None
        self.photo_image = None
        
        # Resources (borrow from main app)
        self.close_btn_images = self.app.close_btn_images 

    def ensure_visible(self):
        if self.frame and self.frame.winfo_exists(): return
        
        is_linux = sys.platform.startswith("linux")
        close_btn_text = "X" if is_linux else "✕"

        self.frame = ttk.Frame(self.parent_pane, style="Dark.TFrame")
        
        top = ttk.Frame(self.frame, style="Dark.TFrame", padding=(8,6))
        top.pack(side=tk.TOP, fill=tk.X)
        top.grid_columnconfigure(0, weight=1)

        self.label_var = tk.StringVar(value="(no image)")
        self.label = ttk.Label(top, textvariable=self.label_var, style="Dark.TLabel", anchor="w")
        self.label.grid(row=0, column=0, sticky="ew", padx=(0, 8))

        close_btn = ttk.Button(
            top, text=close_btn_text, width=3, style="Dark.TButton",
            command=self.hide, takefocus=False
        )
        close_btn.grid(row=0, column=1, sticky="e")
        self.app._set_tooltip_text(close_btn, "Close preview")

        self.canvas = tk.Canvas(self.frame, bg=self.app.TEXT_BG, highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind("<Configure>", lambda e: self.render_fit())

        try:
            self.parent_pane.add(self.frame, weight=4)
        except tk.TclError: pass
        
        top.bind("<Configure>", lambda e: self.update_label_text())

    def hide(self):
        if not self.frame: return
        try:
            self.parent_pane.forget(self.frame)
        except tk.TclError: pass
        try:
            self.frame.destroy()
        except Exception: pass
        self.frame = None
        self.canvas = None
        self.original_image = None

    def show_image(self, file_path: Path, remote_path: str = None):
        self.ensure_visible()
        label_text = str(file_path) if not remote_path else f"[REMOTE] {remote_path}"
        self.full_label_text = label_text
        self.update_label_text()

        self.original_image = None
        self.photo_image = None
        
        if PIL_AVAILABLE:
            try:
                self.original_image = Image.open(file_path)
            except Exception as e:
                self.canvas.delete("all")
                self.canvas.create_text(10, 10, anchor="nw", fill=self.app.TEXT_FG, text=f"Failed: {e}")
                return
        self.render_fit()

    def render_fit(self):
        if not self.canvas: return
        self.canvas.delete("all")
        w = self.canvas.winfo_width()
        h = self.canvas.winfo_height()
        if w <= 2 or h <= 2: return

        if PIL_AVAILABLE and self.original_image:
            img = self.original_image
            iw, ih = img.width, img.height
            if iw > 0 and ih > 0:
                scale = min(w / iw, h / ih)
                new_w = max(1, int(iw * scale))
                new_h = max(1, int(ih * scale))
                try:
                    resized = img.resize((new_w, new_h), Image.LANCZOS)
                except Exception:
                    resized = img.resize((new_w, new_h))
                self.photo_image = ImageTk.PhotoImage(resized)
                self.canvas.create_rectangle(0, 0, w, h, fill=self.app.TEXT_BG, width=0)
                self.canvas.create_image(w // 2, h // 2, image=self.photo_image, anchor="center")
        else:
            self.canvas.create_rectangle(0, 0, w, h, fill=self.app.TEXT_BG, width=0)
            msg = "(Pillow not available)" if not PIL_AVAILABLE else "(No Image)"
            self.canvas.create_text(w//2, h//2, text=msg, fill=self.app.TEXT_FG, anchor="center")

    def update_label_text(self):
        if not self.label: return
        top = self.label.nametowidget(self.label.winfo_parent())
        total_w = top.winfo_width()
        if total_w <= 1: 
            self.app.after(1, self.update_label_text)
            return
        
        close_w = 40
        padding = 24
        avail = max(10, total_w - close_w - padding)
        
        full = self.full_label_text or ""
        font = self.app._font_for(self.label)
        if font.measure(full) <= avail:
            self.label_var.set(full)
            self.app._set_tooltip_text(self.label, full)
            return
            
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
        self.label_var.set(best)
        self.app._set_tooltip_text(self.label, full)