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

## [2.1.0] - 2025-08-25

### Added

* ターミナルで **`conda` コマンド**に対応（`conda activate` など）。
* **Linux** における未対応フォントへの **フォールバック** を追加（指定フォントが無効な場合に代替フォントで表示）。

### Changed

* **Watcher は `commands.txt` をサーバーへ送信しない**設計に変更（ログ送信の安定化に伴う挙動変更）。
* **フォルダツリーの自動読み込みを廃止**（大規模フォルダを指定した際に GUI 起動時フリーズを避けるため）。

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

[Unreleased]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/ri0097fx/SyncTerm-IDE/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/ri0097fx/SyncTerm-IDE/releases/tag/v2.0.0
[1.0.0]: https://github.com/ri0097fx/SyncTerm-IDE/releases/tag/v1.0.0
