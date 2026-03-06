# デスクトップ版（廃止・退避）

**このフォルダは廃止されたデスクトップ版（Python + Tkinter GUI）の退避先です。**  
新規利用・通常利用はプロジェクトルートの **Web 版** を使用してください。

## 含まれるもの

* **GUI**: `main.py`, `gui_app.py`, `components/`, `config.py`, `theme.json`
* **同期クライアント**: `sync_services/`
* **従来 Watcher**: `command_watcher.py`, `watcher_manager.sh`（rsync/SSH ポーリング方式）

設定ファイル `config.ini` はプロジェクトルートを参照します。実行時はルートで `config.ini` を用意したうえで、このフォルダで以下を実行してください。

```bash
cd desktop_legacy
pip install -r requirements.txt
python main.py
```

## Web 版について

* セットアップ: ルートの [docs/WEB-SETUP.md](../docs/WEB-SETUP.md)
* RT モード: `watcher_manager_rt.sh` と `scripts/command_watcher_rt.py`（ルートにあります）
