#!/usr/bin/env python3
"""Create sessions and _registry under CWD (app root, e.g. ~/SyncTerm-IDE).
Used by deploy_backend.sh on the relay server after syncing. base_path は廃止。"""
from __future__ import annotations

import configparser
import sys
from pathlib import Path

def main():
    config_path = Path("config.ini")
    if not config_path.exists():
        return 0
    parser = configparser.ConfigParser()
    parser.read(config_path)
    base = Path.cwd()
    sess_name = parser.get("structure", "sessions_dir_name", fallback="sessions") if parser.has_section("structure") else "sessions"
    reg_name = parser.get("structure", "registry_dir_name", fallback="_registry") if parser.has_section("structure") else "_registry"
    for d in (base / sess_name, base / reg_name):
        d.mkdir(parents=True, exist_ok=True)
        print("Created:", d, file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
