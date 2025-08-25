from __future__ import annotations
import configparser
import json
import re
import sys
from pathlib import Path
from tkinter import messagebox
from pygments.token import Token
import os
# --- 設定ファイルの読み込み ---
try:
    config = configparser.ConfigParser()
    config.read(Path(__file__).resolve().parent / "config.ini")

    remote_config = config["remote"]
    local_paths_config = config["local_paths"]
    structure_config = config["structure"]
except Exception as e:
    messagebox.showerror("Config Error", f"config.iniの読み込みに失敗しました:\n{e}")
    sys.exit(1)


# --- パス設定 ---
LOCAL_BASE_DIR = Path(os.path.expanduser(local_paths_config.get("gui_mirror_dir", "~/gui_local_mirror"))).resolve()
LOCAL_SESSIONS_ROOT = (LOCAL_BASE_DIR / structure_config.get("sessions_dir_name", "sessions")).resolve()
LOCAL_REGISTRY_DIR = (LOCAL_BASE_DIR / structure_config.get("registry_dir_name", "_registry")).resolve()
LOCAL_EDITING_CACHE = (LOCAL_BASE_DIR / "_editing_cache").resolve()

# リモートサーバーの情報
REMOTE_SERVER = remote_config.get("server")
REMOTE_BASE_PATH = remote_config.get("base_path")
REMOTE_SESSIONS_PATH = f"{REMOTE_BASE_PATH}/{structure_config.get('sessions_dir_name', 'sessions')}"
REMOTE_REGISTRY_PATH = f"{REMOTE_BASE_PATH}/{structure_config.get('registry_dir_name', '_registry')}/"

# GUI自体の設定ファイルパス
GUI_CONFIG_DIR = Path(__file__).resolve().parent
THEME_JSON_PATH = (GUI_CONFIG_DIR / "theme.json").resolve()
STATE_JSON_PATH = (GUI_CONFIG_DIR / "session_state.json").resolve()


# --- グローバル設定 ---
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


# --- UIカラー・定数 ---
COMBO_BG = "#2A343F"
COMBO_FG = "white"
COMBO_SEL_BG = "#285577"
COMBO_SEL_FG = "white"
SCROLLBAR_THUMB_COLOR = "#788494"


# --- テーマ読み込み関数 ---
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

# --- テーマを読み込んでエクスポート ---
try:
    UI_COLORS, HL = load_spyder_theme(THEME_JSON_PATH, BG_OVERRIDE)
except Exception as e:
    messagebox.showerror("Theme Error", f"テーマの読み込みに失敗:\n{e}")
    sys.exit(1)