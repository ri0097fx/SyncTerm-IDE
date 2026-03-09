# SyncTerm-IDE / USAGE

*日常の使い方ガイド（基本操作）*
※ 事前に [docs/WEB-SETUP.md](./WEB-SETUP.md) の手順で Web 版を起動してください（デスクトップ版は廃止、[desktop_legacy/](../desktop_legacy/) 参照）。

---

## 0. 前提（構成の要点）

* **クライアント（PC A）**: ブラウザで **syncterm-web** を開いて操作する側。ローカルで Vite 開発サーバーを起動し、Relay 上の FastAPI バックエンドへ HTTP でアクセスします。
* **Watcher（PC B など複数可）**: `watcher_manager_rt.sh` が `scripts/command_watcher_rt.py` を起動し、**RT モード（リバーストンネル）で Relay と HTTP** によりコマンド・ログ・ファイル操作をやりとりします。
* **中継サーバー（Relay）**: Linux サーバー上で FastAPI バックエンドを常駐させ、`sessions/` と `_registry/` を通じて Watcher / Session の状態とファイルを管理します。サーバーは **中継・保管専用** で、クライアントへプッシュは行わず、すべて **クライアント発の HTTP リクエスト** でログ取得・コマンド送信・ファイル編集・AI 呼び出しを行います。

**ファイルリンクの目的**: Watcher 側に存在するコードやデータを、GUI から直接 **編集・閲覧** できるようにするために、Watcher 上のフォルダを **セッション直下へ論理的に取り込む** 仕組みです。リンク配下はファイルツリーで仮想展開され、ダブルクリック時に必要なファイルのみローカルに自動取得して編集できます（サーバーからのプッシュは行いません）。

---

## 1. Watcher を起動（制御したい各 PC で）

制御したい PC（PC B など）で **RT 版 Watcher** を実行します。`watcher_id` と `display_name` は任意の識別子です。

```bash
# 例: PC B 上で
chmod +x watcher_manager_rt.sh
./watcher_manager_rt.sh pc-b "PC B"
# バックグラウンドで
nohup ./watcher_manager_rt.sh pc-b "PC B" > watcher.log 2>&1 &
```

ポイント

* `config.ini` は **Relay・Watcher 側で同一**にし、`[rt]` セクションを用意する。
* Watcher は Relay へ HTTP（リバーストンネル）でコマンド・ログを送受信する。

---

## 2. Web を起動（操作する PC で）

PC A（操作端末）でブラウザから **syncterm-web** にアクセスする。起動方法は [WEB-SETUP.md](WEB-SETUP.md) を参照。

起動後の流れ

1. **Watcher** ドロップダウンに、起動中の Watcher が表示される（Relay の _registry から取得）。
2. Watcher を選ぶと **Session** の一覧が出る。

   * 既存を選ぶ
   * または **New** に名前を入れて **Create** で作成
3. 接続すると、ターミナル出力が読み込み直され、以後は **自動同期** で動きます。

---

## 3. File Explorer と Watcher フォルダのリンク（目的と手順）

**目的**: Watcher 側のコード／データを Web UI から安全に編集・閲覧するために、Watcher 上のフォルダをセッション直下に論理的に取り込みます（リンク）。

手順

1. 左ペイン **File Explorer** のツールバーで **🔗 Remote Link Folder** を選びます。
2. ダイアログで以下を入力します。

   * **Source Path (on Watcher)**: Watcher 側でリンクしたいフォルダのパス（絶対/相対可）
   * **Link Name (to create in session)**: セッション直下に作成するリンク名（`/` と `\` は使えません）
3. 作成するとファイルツリーに **矢印アイコン付きのリンク** が追加されます。三角をクリックすると “Loading.” の後に中身が展開されます。
4. ファイルを **ダブルクリック** すると、ローカル編集キャッシュに自動取得してエディタで開きます。

補足

* **🏠 Jump Mirror Home** で現在の Watcher / Session のミラールートに移動できます。
* **大規模フォルダ**は初回展開やキャッシュ準備に時間がかかることがあります。

## 4. ターミナルの使い方

* 上部の **Mode: Remote / Local** で切替

  * **Remote**: 選択中の Watcher（遠隔 PC）でコマンド実行（Relay 経由で HTTP 送受信）
  * **Local**: Web 版では**コマンドを実行しない**ダミーモード（入力した文字列をローカルで表示するのみ）。ブラウザからローカルシェルを直接実行する機能は提供していません。
* プロンプト例

  * Remote: `[Remote] (env) user@host:~/path$`
  * Local:  `[Local] (env) user@host:~/path$`
* よく使う操作

  * `Clear view`：画面をクリア（履歴ファイルは消えません）
  * `Clear log file`：**Remote** のセッションログを初期化（Watcher 経由でクリア）
  * 右クリック（または中クリック）：**Copy** メニュー
  * 入力履歴：↑ / ↓

**補足（プロンプトが `$` だけで `user@host` が出ないとき）**

* サーバーのセッションディレクトリに `.watcher_status.json` がまだ生成されていない可能性があります。Watcher 起動直後や接続直後は数秒待ってから再度確認してください。
* アプリルート（通常 `~/SyncTerm-IDE`）と、Relay 上でのセッションディレクトリの権限が正しいかを確認します。

---

## 5. エディタの使い方（タブ・検索・補完）

* **タブ**：Notebook 形式。各タブ右側の **×** で閉じられます（未保存の場合は確認ダイアログ）。
* **シンタックスハイライト**：拡張子から自動判定（Pygments）
* **検索バー**：`Ctrl/Cmd + F` で表示（次/前、全件ハイライト、マーカー表示）
* **スマートインデント**：`Tab` / `Shift+Tab`
* **行操作**：`Alt+↑/↓`（macOS は `Option+↑/↓`）、`Ctrl/Cmd + D` で行削除
* **コメントトグル**：`Ctrl/Cmd + /`
* **簡易補完**：同一ファイル内の単語から候補を提示（`Tab`）

ファイル操作

* `Open File` / `Save File` / `Save As...`
* 左ペインの **File Explorer** からダブルクリックで開く

---

## 6. 画像プレビュー

画像ファイル（`png` / `jpg` / `jpeg` / `gif` / `bmp` / `webp`）を **ダブルクリック**すると、右ペインにプレビューを表示します。プレビューのヘッダーは末尾優先で省略表示され、右端の **✕** で閉じられます。ペインのサイズ変更に応じて画像がフィットします。

* 画像はエディタではなくプレビューに送られます（編集は行いません）。
* Web 版ではブラウザがそのまま画像を描画するため、追加の Python ライブラリ（Pillow など）は不要です。Relay 側からはバイナリを HTTP 経由で取得するだけです。

## 7. セッション／マルチ Watcher の切替

* Watcher ドロップダウンから **別の Watcher** を選択可能（PC B / PC C …）
* Session ドロップダウンで **別セッション**へ切替可（作業単位で分けるのがおすすめ）

---

## 8. トラブルシュート（抜粋）

* **Watcher が一覧に出ない**

  * Relay の `_registry/` に `<watcher_id>.json` が登録されていない可能性。Watcher 側で `watcher_manager_rt.sh` が動いているか / SSH 鍵 / `config.ini` を確認。
* **プロンプトが `$` のみ**

  * `.watcher_status.json` 未生成の可能性。少し待つ／Watcher 再起動／アプリルートの権限確認。
* **ログが更新されない**

  * Relay 側の FastAPI バックエンドが落ちていないか、`/log` 系エンドポイントでエラーになっていないかを確認。

→ 詳細は [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) を参照してください。

---

## 9. キーボードショートカット一覧

| 機能       | Windows/Linux      | macOS             |
| -------- | ------------------ | ----------------- |
| 保存       | `Ctrl + S`         | `Cmd + S`         |
| 別名で保存    | `Ctrl + Shift + S` | `Cmd + Shift + S` |
| 検索バー     | `Ctrl + F`         | `Cmd + F`         |
| コメントトグル  | `Ctrl + /`         | `Cmd + /`         |
| 行削除      | `Ctrl + D`         | `Cmd + D`         |
| 行を上/下へ移動 | `Alt + ↑ / ↓`      | `Option + ↑ / ↓`  |
| インデント    | `Tab`              | `Tab`             |
| アンインデント  | `Shift + Tab`      | `Shift + Tab`     |

---

## 10. よくあるワークフロー

1. **PC B で Watcher を起動**（`watcher_manager_rt.sh`。常駐なら `nohup ... &`）
2. **PC A で Web を起動**（[WEB-SETUP.md](WEB-SETUP.md) 参照）→ Watcher を選ぶ → セッション選択/作成
3. **Remote モード**でコマンド実行、**エディタ**で編集

   * 保存 → Relay 経由で Watcher に反映
   * 必要に応じて「キャッシュ・commands 削除」で Staged と commands をリセット
4. 必要に応じて **別 Watcher** や **別セッション**に切替

---

## 11. 関連ドキュメント

* セットアップ：[`docs/WEB-SETUP.md`](./WEB-SETUP.md)
* トラブルシュート：[`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
* プロジェクト概要：`README.md`

---
