# components/__init__.py
"""
UI components package.

Exports (if present):
- TerminalFrame
- EditorFrame
- FileExplorerFrame
"""

from importlib import import_module

__all__ = []

def _optional(mod_name: str, cls_name: str) -> None:
    try:
        mod = import_module(f".{mod_name}", __name__)
    except Exception:
        return
    obj = getattr(mod, cls_name, None)
    if obj is not None:
        globals()[cls_name] = obj
        __all__.append(cls_name)

_optional("terminal", "TerminalFrame")
_optional("editor", "EditorFrame")
_optional("file_explorer", "FileExplorerFrame")

# tidy up
del import_module, _optional
