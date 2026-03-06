#!/usr/bin/env python3
"""Create base_path, sessions, and _registry dirs from config.ini in CWD.
Used by deploy_backend.sh on the relay server after syncing config.ini."""
from __future__ import annotations

import configparser
import os
import sys
from pathlib import Path

def main():
    config_path = Path("config.ini")
    if not config_path.exists():
        return 0
    parser = configparser.ConfigParser()
    parser.read(config_path)
    if not parser.has_section("remote"):
        return 0
    base = parser.get("remote", "base_path", fallback="").strip()
    if not base:
        return 0
    base = Path(os.path.expanduser(base))
    sess_name = parser.get("structure", "sessions_dir_name", fallback="sessions")
    reg_name = parser.get("structure", "registry_dir_name", fallback="_registry")
    for d in (base, base / sess_name, base / reg_name):
        d.mkdir(parents=True, exist_ok=True)
        print("Created:", d, file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
