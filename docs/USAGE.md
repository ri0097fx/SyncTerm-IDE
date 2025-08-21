# SyncTerm-IDE / USAGE

*日常の使い方ガイド（基本操作）*
※ 事前に [docs/SETUP.md](./SETUP.md) の手順を完了してください。

---

## 0. 前提（構成の要点）

* **GUI（PC A）**：`gui_terminal.py` を実行して操作する側。
* **Watcher（PC B など複数可）**：`watcher_manager.sh` が `command_watcher.py` を起動し、**サーバーに置かれたセッション領域**を監視・実行します。
* **サーバー**：ファイルを **中継・保管**するだけ。GUI ⇄ サーバー ⇄ Watcher を **SSH/rsync** で同期します。
  ※ 矢印の向きは **ローカル → サーバー** のみ（サーバーからのプッシュはしません）。GUI/Watcher がサーバーへ取りに行く（pull）＆送る（push）動作です。

---

## 1. Watcher を起動（制御したい各 PC で）

制御したい PC（PC B など）で実行します。`watcher_id` と `display_name` は任意の識別子です。

```bash
# 例: PC B 上で
chmod +x watcher_manager.sh
./watcher_manager.sh pc-b "PC B" &
# ログをファイルに残す場合
nohup ./watcher_manager.sh pc-b "PC B" > watcher.log 2>&1 &
```

ポイント

* `config.ini` は **GUI 側・Watcher 側・サーバー側で同一**にしておくこと。
* `base_path` 配下に `sessions/` と `_registry/` が作られます（自動）。
* Watcher はサーバー上の **自分用セッション**をポーリングし、`commands.txt` を見つけると実行、結果を `commands.log` へ書き戻します。

---

## 2. GUI を起動（操作する PC で）

PC A（操作端末）で GUI を立ち上げます。

```bash
# 例: PC A 上で
python gui_terminal.py
```

起動後の流れ

1. 右上の **Watcher** ドロップダウンに、起動中の Watcher が表示されます（自動検出）。
2. Watcher を選ぶと **Session** の一覧が出ます。

   * 既存を選ぶ
   * または **New** に名前を入れて **Create** で作成
3. 接続すると、ターミナル出力が読み込み直され、以後は **自動同期** で動きます。

---

## 3. ターミナルの使い方

* 上部の **Mode: Remote / Local** で切替

  * **Remote**：選択中の Watcher（遠隔 PC）でコマンド実行
  * **Local**：GUI を動かしている PC A でコマンド実行
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
* `config.ini` の `base_path` と、サーバーへの SSH/rsync が正しく通っているかも確認。

---

## 4. エディタの使い方（タブ・検索・補完）

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

## 5. セッション／マルチ Watcher の切替

* Watcher ドロップダウンから **別の Watcher** を選択可能（PC B / PC C …）
* Session ドロップダウンで **別セッション**へ切替可（作業単位で分けるのがおすすめ）

---

## 6. 便利な小ワザ

* **自動スクロール**（ターミナル）：必要に応じてトグル
* **行番号**（エディタ左）：自動更新
* **ハイライト再適用**：キー入力後に自動（負荷軽減のためディレイあり）

---

## 7. トラブルシュート（抜粋）

* **Watcher が一覧に出ない**

  * サーバーの `_registry/` にハートビートが同期されていない可能性。Watcher 側で `watcher_manager.sh` が動いているか / SSH 鍵 / `config.ini` を確認。
* **プロンプトが `$` のみ**

  * `.watcher_status.json` 未生成の可能性。少し待つ／Watcher 再起動／`base_path` の権限確認。
* **ログが更新されない**

  * サーバーとの rsync が失敗している可能性。`~/.ssh/config` の `IdentityFile` 等を点検。
* **色が崩れる／フォント問題**

  * `theme.json` を調整。プラットフォームに応じてフォント指定（Menlo/Consolas）を見直し。

→ 詳細は [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) を参照してください。

---

## 8. キーボードショートカット一覧

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

## 9. よくあるワークフロー

1. **PC B で Watcher を起動**（常駐させるなら `nohup ... &`）
2. **PC A で GUI 起動** → Watcher を選ぶ → セッション選択/作成
3. **Remote モード**でコマンド実行、**エディタ**で編集

   * 保存 → サーバーへ同期 → Watcher が反映／実行
   * `Clear log file` でログ初期化（必要に応じて）
4. 必要に応じて **別 Watcher** や **別セッション**に切替

---

## 10. 関連ドキュメント

* セットアップ：[`docs/SETUP.md`](./SETUP.md)
* トラブルシュート：[`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
* プロジェクト概要：`README.md`
