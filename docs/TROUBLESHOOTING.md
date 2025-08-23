# SyncTerm-IDE — Troubleshooting

このドキュメントは、**SyncTerm-IDE** の導入・運用時によくある問題の切り分け手順と対処法をまとめたものです。GUI（`gui_terminal.py`）と Watcher（`watcher_manager.sh` / `command_watcher.py`）は**別ネットワークにあっても**、双方が中継サーバー（`server = user@xxx.xxx.xxx.xxx`）に SSH できれば動作します。

---

## 0. まず最初に（健康診断）

以下の 3 点がすべて成功するか確認してください（失敗した箇所から読み進めるのが最短です）。

> 以降の例では `server = user@203.0.113.10`、`base_path = /home/user/remote_dev` を仮定します。

### 0-1) GUI 側 → サーバーに SSH できるか

```bash
ssh user@203.0.113.10 -o BatchMode=yes -T true && echo OK || echo NG
```

### 0-2) GUI 側 → サーバーへ rsync でアップロード可能か（ドライラン）

```bash
rsync -azvn ~/gui_local_mirror/ user@203.0.113.10:/home/user/remote_dev/sessions/_dryrun/
```

### 0-3) GUI 側 → サーバーから rsync で取得可能か（レジストリ）

```bash
rsync -azv user@203.0.113.10:/home/user/remote_dev/_registry/ ~/gui_local_mirror/_probe_registry/
```

> 0-2/0-3 のどちらかでも失敗する場合は **SSH 鍵設定**・**パス**・**権限**・**ファイアウォール**を確認してください。

---

## 1. Watcher が GUI のプルダウンに出てこない

**症状**

* GUI の「Watcher」コンボに何も表示されない / 期待の Watcher が出ない。

**確認ポイント**

1. **サーバー上のレジストリにハートビートがあるか**

```bash
ssh user@203.0.113.10 'ls -l /home/user/remote_dev/_registry/'
# 例: pc-b.json, pc-c.json などが数十秒以内に更新されていること
```

2. **Watcher 側（PC B/C）のプロセスが生きているか**

* `watcher_manager.sh` を使う場合：

```bash
ps aux | grep watcher_manager.sh
```

* 直接 `command_watcher.py` を起動する場合：

```bash
ps aux | grep command_watcher.py
```

3. **`config.ini` の `base_path` とディレクトリ名が全マシンで一致**

* `[structure] sessions_dir_name = sessions`
* `[structure] registry_dir_name = _registry`

**対処**

* Watcher 側で再起動（ログを別途保存しておくと原因特定に役立ちます）

```bash
# 例: systemd や nohup など、運用方法に合わせて
pkill -f command_watcher.py || true
nohup ./watcher_manager.sh <watcher_id> "Display Name" > watcher.log 2>&1 &
```

* レジストリが古い/壊れている場合は削除して再生成（※運用に応じて慎重に）

```bash
ssh user@203.0.113.10 'rm -rf /home/user/remote_dev/_registry && mkdir -p /home/user/remote_dev/_registry'
```

---

## 2. ターミナルのプロンプトが出ない / `$` だけで `user@host` が出ない

**症状**

* GUI を起動してもプロンプトが表示されない。
* `Clear log file` やモード切替（Local → Remote）をすると `$` は出るが `user@host` が出ない。

**確認ポイント**

1. **セッション切替が完了しているか**（Watcher/Session を選択後）

* GUI のステータスバーにエラーが出ていないか確認。

2. **サーバー上のセッションディレクトリに `commands.log` が存在するか**

```bash
ssh user@203.0.113.10 'ls -l /home/user/remote_dev/sessions/<watcher_id>/<session_name>/commands.log'
```

3. **` .watcher_status.json` が更新されているか**

* Watcher 側の Agent が出力し、サーバーのセッションフォルダへ同期されます。

```bash
ssh user@203.0.113.10 'cat /home/user/remote_dev/sessions/<watcher_id>/<session_name>/.watcher_status.json'
```

* `user`, `host`, `cwd`, `conda_env` などが入っていること。

**対処**

* GUI で一度 `Mode: Local` に切替 → `Mode: Remote` に戻す。
* `Clear log file` を押して、**EOC マーカー**（`__CMD_EXIT_CODE__::`）がログに現れるか確認。現れなければ Watcher 側でログ出力が止まっている可能性があります。
* Watcher 側ログ（例：`watcher.log`）に例外が出ていないか確認。

---

## 3. コマンドが実行されない / 反応が遅い

**確認ポイント**

* サーバー上の `commands.txt` が更新されているか：

```bash
ssh user@203.0.113.10 'tail -n 50 /home/user/remote_dev/sessions/<watcher_id>/<session_name>/commands.txt'
```

* Watcher 側が `commands.txt` を取り込み、`commands.log` に出力しているか。
* 回線状態（往復レイテンシ、`rsync` の頻度）

**対処**

* 大量のファイルがミラーに混入していると rsync が重くなります。不要ファイルを `.rsyncignore` 的に除外する、セッション専用の軽いディレクトリを使うなどの工夫を。
* `LOG_FETCH_INTERVAL_MS`（GUI）や Watcher 側のポーリング間隔を適切に調整。

---

## 4. 同期されない / 片方向のみ同期される

**前提**：本システムは**クライアント主体**で rsync を実行します。**サーバーからクライアントへプッシュはしません**。GUI/Watcher がそれぞれ **サーバーから“取得”** することで最新化します。

**確認ポイント**

* GUI 側：`rsync` でサーバーのレジストリ・セッションを**取得**しているか。
* Watcher 側：`rsync` でサーバーのセッションを**取得**→コマンドを実行→結果を**アップロード**しているか。

**対処**

* 双方で `config.ini` の `base_path` が同じか再確認。
* `rsync` のコマンドで**末尾スラッシュ**の有無に注意（`src/` と `src` は挙動が異なる）。
* パーミッション（サーバー上の `base_path` に書き込み権限があるか）。

---

## 5. SSH 認証エラー（`Permission denied (publickey)` など）

**確認ポイント**

* クライアント（GUI/Watcher）マシンで鍵があるか：`~/.ssh/id_ed25519` / `id_ed25519.pub`
* `~/.ssh/config` に対象サーバーの設定があるか（`IdentityFile` を指定）
* サーバー側 `~/.ssh/authorized_keys` に **公開鍵** を登録済みか

**対処**（概要）

```bash
# 鍵作成（未作成なら）
ssh-keygen -t ed25519 -C "SyncTerm-IDE"

# 公開鍵をサーバーへ登録（初回のみ）
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@203.0.113.10

# または手動で authorized_keys に追記
```

> くわしい手順は `docs/SETUP.md` を参照。

---

## 6. rsync エラーの典型例

* `No such file or directory`：`base_path` やサブディレクトリが未作成。`mkdir -p` で作ってから再試行。
* `Permission denied`：サーバー側のパーミッション不備。
* `rsync: connection unexpectedly closed`：ネットワーク断・Firewall・SSH ポート変更など。

**役立つオプション**

```bash
# 詳細表示
rsync -azv ...
# 転送しないで検証
rsync -azvn ...
```

---

## 7. GUI 表示・操作まわりのトラブル

* **タブの × ボタンが表示されない / 歪む**：

  * OS の Tk バージョン差や PNG のデコード差が原因の場合あり。`Pillow` 経由で読み込むフォールバックを利用してください（既定コードに含まれています）。
  * それでも崩れる場合は 1 色アイコン（GIF など）に差し替えると安定します。

* **`TclError: Invalid -children value`（Notebook タブのレイアウト）**：

  * `style.layout("Closable.TNotebook.Tab", [...])` の配列構造・キー名が崩れている可能性。最新版コードへ更新してください。

* **行数が極端に多いと重い**：

  * `MAX_TERMINAL_LINES` を下げる・エディタで大規模ファイルを開きすぎない。

---

## 8. きれいに“初期化”したい（ローカルのみ）

```bash
# GUI を終了してから実施
rm -rf ~/gui_local_mirror/_probe_registry ~/gui_local_mirror/sessions
rm -f  <GUIディレクトリ>/session_state.json
# 必要に応じて再起動
python gui_terminal.py
```

---

## 9. それでも解決しない場合

* 実行環境（OS/バージョン）、`config.ini`（サーバーアドレスなどは伏せて）、発生手順、ログ（サーバー・GUI・Watcher）を添えて Issue を作成してください。
* ログ取得のコツ：

  * Watcher 側：`nohup` の標準出力/標準エラーを `watcher.log` に流す
  * GUI 側：ターミナルのログ（`commands.log`）と、コンソール出力があればそれも

---

### 参考リンク

* `docs/SETUP.md` — SSH 鍵・`~/.ssh/config`・サーバー準備
* `docs/USAGE.md` — 基本操作とワークフロー
* `README.md` — プロジェクト概要とアーキテクチャ
