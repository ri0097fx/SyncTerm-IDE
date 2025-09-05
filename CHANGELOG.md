# Changelog

本ファイルは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) の考え方に沿って記述している。バージョン表記は [Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

> 詳細は GitHub Releases を参照。ここでは要点のみを簡潔に列挙する。

---

## [Unreleased]

### Added

* なし

### Changed

* なし

### Fixed

* なし

---

## [2.3.1] - 2025-09-05

### Added
- **Editor**: 横方向スクロールバーを追加。長い行は折り返さず横にスクロールして閲覧可能に。
- **File Tree（リンク内）**: リンク配下の**サブフォルダ展開**に対応。リンク直下だけでなく、階層を辿ってファイルを開けるように。

### Changed
- **Editor**: 既定の折り返しを無効化（`wrap="none"`）。行番号ガターとのスクロール同期を強化。

### Fixed
- **行番号のズレ**: 長い行が折り返されるケースで、行番号と本文のスクロール位置がずれることがあった問題を解消。

### Notes
- 破壊的変更なし（設定・保存の互換性に影響なし）。

---

## [2.3.0] - 2025-09-04

### Added
- **GUI**: リンク経由のファイルを *watcher/session/link/相対パス* で一意にローカルキャッシュ化。
- **GUI**: 保存後のアップロードを **トークン付きステージング**（`<session>/.staged_uploads/<token>`）に変更し、`_internal_move_staged_file::<token>::<relpath>` を送出。

### Changed
- **Watcher**: トークン付きステージファイルを **原子的置換**（`copy2 → os.replace`）で適用。相対パスの安全性（絶対/`..` を拒否）を検証。

### Fixed
- 複数のリンク先ファイルを続けて保存した際に、キャッシュ衝突やステージファイル上書きで**別ファイルが誤上書きされる**問題を解消。
- 異なるリンク/セッション間で**キャッシュ先が衝突**する可能性を排除。

### Breaking
- 旧形式の `"_internal_move_staged_file::<relpath>"` と **単一 `.staged_for_upload`** 方式を**廃止**。Watcher は **トークン付きのみ**受理します。
- `.commands.offset` は **Watcher 側を正** とし、GUI/manager から **pull しない**方針を明確化。

### Migration
- GUI は保存時に `<session>/.staged_uploads/<token>` へアップロードし、  
  `"_internal_move_staged_file::<token>::<relpath>"` を送るようにしてください。
- `watcher_manager.sh` の pull フィルタに **`--include '*/.staged_uploads/**'`**（必要なら互換で `--include '*/.staged_for_upload'` も）を追加。  
  `.commands.offset` は **除外**のままにしてください。

---

## [2.2.2] - 2025-08-25

### Fixed
- **Registry の上書き問題**：`_registry/` をディレクトリごと同期して他 Watcher の JSON を消す不具合を修正。  
  各 Watcher は **`<watcher_id>.json` に `watcher_id / display_name / last_heartbeat` を出力し、ファイル単位で rsync（`--delete` 不使用）** するよう変更。  
  これにより、**複数 Watcher が常に正しく一覧表示**されます。

### Chore
- 終了時のクリーンアップで **自分の JSON のみ** を削除するように整理。

---

## [2.2.1] - 2025-08-25

### Added
- **DirectoryPicker（カスタム）**：`_askdirectory_styled()` を追加。ダークテーマに合わせてエントリ／ドロップダウン／ツリーの配色を統一可能。

### Changed
- **行番号のフォントをエディタに連動**：エディタ本文と行番号で同一 `tkinter.font.Font` を共有するように変更（Preferences の適用で同期）。

### Fixed
- 一部環境でのディレクトリ選択ダイアログの視認性（白文字×白背景）に対する回避策を提供（カスタムダイアログの利用）。


---

## [2.2.0] - 2025-08-25

### Added
- **Preferences（設定）** を追加：セッションバー右端の **⚙︎** ボタンから開くダイアログで、**Editor / Terminal のフォントファミリとサイズ**を変更可能。
- **即時反映＋永続化**：**Apply** で即時、**Save & Close** で `STATE_JSON_PATH` の `prefs` に保存し、次回起動時に復元。
- **`Dark.TSpinbox`** スタイルを追加し、数値入力の背景色を Watcher / Session と統一。

### Changed
- セッションバーの **Preferences ボタンをアイコン系に統一**（他ボタンと同じ `Dark.TButton`、幅=3）。

### Fixed
- なし

---

## [2.1.1] - 2025-08-25

### Fixed

* **Python のバージョン差で型アノテーションが無効化される環境に対応**：`config.py` と `gui_terminal.py` に `from __future__ import annotations` を追加し、前方参照の遅延評価を有効化（Py 3.7–3.10 互換性向上／Py 3.11+ では挙動に影響なし）。

---

## [2.1.0] - 2025-08-25

### Added

* ターミナルで **`conda` コマンド**に対応（`conda activate` など）。
* **Linux** における未対応フォントへの **フォールバック** を追加。

### Changed

* **Watcher は `commands.txt` をサーバーへ送信しない**設計に変更。
* **フォルダツリーの自動読み込みを廃止**（大規模フォルダでのフリーズ回避）。

### Fixed

* **rsync の送信負荷が高い場合**に、Watcher→サーバーのログが**書き込まれないことがある問題**を修正。

---

## [2.0.0]

### Added

* **リンク編集（Watcher 連携）**：Watcher 上のフォルダを **セッション直下にシンボリックリンクとして作成**し、ファイルツリーで仮想展開。ダブルクリックでローカル編集キャッシュに自動取得して開ける。
* **画像プレビュー**：右ペインにプレビュー領域を追加（対応拡張子: `png`, `jpg`, `jpeg`, `gif`, `bmp`, `webp`）。

### Docs

* README/USAGE を更新。注意事項として「大規模フォルダの初回展開は時間がかかる場合がある」「Watcher は処理完了後にまとめてログへ書き込む（途中経過はターミナルで見えない）」を明記。

---

## [1.0.0]

### Added

* 初期リリース。

---
[Unreleased]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.3.1...HEAD
[2.3.1]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.2.2...v2.3.0
[2.2.2]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/ri0097fx/SyncTerm-IDE/releases/tag/v2.0.0
[1.0.0]: https://github.com/ri0097fx/SyncTerm-IDE/releases/tag/v1.0.0

