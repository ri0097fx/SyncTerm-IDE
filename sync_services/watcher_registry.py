# sync_services/watcher_registry.py
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import json
import time

@dataclass
class WatcherInfo:
    watcher_id: str
    display_name: str
    last_heartbeat: float

def load_active_watchers(
    registry_dir: Path,
    timeout_sec: float,
) -> list[WatcherInfo]:
    """レジストリディレクトリから有効な watcher を列挙する"""
    watchers: list[WatcherInfo] = []
    now = time.time()

    if not registry_dir.exists():
        return watchers

    HB_KEYS = ("last_heartbeat", "last_seen", "heartbeat_ts")

    # *.json だけを見る
    files = sorted(registry_dir.glob("*.json"), key=lambda p: p.name.lower())

    for reg_file in files:
        try:
            data = json.loads(reg_file.read_text("utf-8"))
        except Exception:
            continue

        # ハートビート時刻
        ts = None
        for k in HB_KEYS:
            if k in data:
                ts = data.get(k)
                break
        if ts is None:
            ts = reg_file.stat().st_mtime

        try:
            ts = float(ts)
        except Exception:
            continue

        if now - ts > timeout_sec:
            # タイムアウトした watcher はスキップ
            continue

        watcher_id = Path(reg_file).stem
        if not watcher_id:
            continue

        display_name = data.get("display_name") or watcher_id

        watchers.append(
            WatcherInfo(
                watcher_id=watcher_id,
                display_name=display_name,
                last_heartbeat=ts,
            )
        )

    return watchers
