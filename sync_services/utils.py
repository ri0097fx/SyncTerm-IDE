# sync_services/utils.py
import os, shutil, subprocess, stat
from pathlib import Path

IS_WIN = os.name == "nt"

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

def wsl_available() -> bool:
    return IS_WIN and shutil.which("wsl") is not None

def should_use_wsl_rsync() -> bool:
    return IS_WIN and wsl_available()

def win_to_wsl_path(p: str) -> str:
    # C:\Users\me\foo -> /mnt/c/Users/me/foo
    p = os.path.abspath(p)
    drive, rest = os.path.splitdrive(p)
    drive = (drive or "C:").rstrip(":").lower()
    rest_clean = rest.lstrip('\\/').replace('\\', '/')
    path_wsl = f"/mnt/{drive.rstrip(':').lower()}/{rest_clean}"
    return path_wsl

def cmd_exists(name: str) -> bool:
    return shutil.which(name) is not None

def unix(p: str) -> str:
    return str(p).replace("\\", "/")

def wipe_children(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    for c in path.iterdir():
        if c.is_dir() and not c.is_symlink():
            shutil.rmtree(c, ignore_errors=True)
        else:
            try: c.unlink()
            except: pass