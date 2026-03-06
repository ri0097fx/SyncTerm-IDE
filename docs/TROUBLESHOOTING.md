# SyncTerm-IDE — Troubleshooting

このドキュメントは、**SyncTerm-IDE** の利用時に遭遇しやすい問題の切り分け手順と対処法をまとめたものである。症状に最も近い項目から確認すること。

---

## 0. まず最初に（健康診断）

以下の 3 点がすべて成功するか確認してください（失敗した箇所から読み進めるのが最短です）。

> 以降の例では `server = user@203.0.113.10`、アプリルート `~/SyncTerm-IDE`（例: `/home/user/SyncTerm-IDE`）を仮定します。

### 0-1) GUI 側 → サーバーに SSH できるか

```bash
ssh user@203.0.113.10 -o BatchMode=yes -T true && echo OK || echo NG
```

### 0-2) GUI 側 → サーバーへ rsync でアップロード可能か（ドライラン）

```bash
rsync -azvn ~/gui_local_mirror/ user@203.0.113.10:~/SyncTerm-IDE/sessions/_dryrun/
```

### 0-3) GUI 側 → サーバーから rsync で取得可能か（レジストリ）

```bash
rsync -azv user@203.0.113.10:~/SyncTerm-IDE/_registry/ ~/gui_local_mirror/_probe_registry/
```

> 0-2/0-3 のどちらかでも失敗する場合は **SSH 鍵設定**・**パス**・**権限**・**ファイアウォール**を確認してください。

> 注: 本ドキュメントは現在 **macOS** を主対象として記述しています。**Windows/Linux での動作確認は未実施**です（動作可否や表示差は未検証）。

---

## 1. Watcher が GUI のプルダウンに出てこない

**症状**

* Watcher を起動しているのに、GUI の Watcher 一覧に見つからない。

**確認ポイント**

* Watcher 側で `watcher_manager.sh` が動いているか（`ps` / ログ確認）。
* `config.ini` の `server` およびアプリルート（base_path 未設定なら ~/SyncTerm-IDE）が GUI 側と一致しているか。
* サーバー上の `_registry/` に Watcher のハートビートが作成・更新されているか。

**対処**

* `watcher_manager.sh` を再起動する。
* サーバーへの SSH/rsync を再確認（鍵・防火壁・ユーザー権限）。

---

## 2. ターミナルのプロンプトが出ない / `$` だけで `user@host` が出ない

**症状**

* GUI を起動してもプロンプトが表示されない。
* `Clear log file` やモード切替（Local → Remote）後に固まる。

**確認ポイント**

* サーバーのセッションディレクトリに `.watcher_status.json` が生成されているか。
* アプリルートとパーミッションが正しいか（GUI/Watcher ともに書込権限があるか）。

**対処**

* Watcher を再起動し、数秒待ってから接続し直す。
* `config.ini` の `sessions_dir_name` / `registry_dir_name` を既定から変更している場合は、全マシンで一致させる。

---

## 3. コマンドが実行されない / 反応が遅い

**症状**

* リモートコマンドを送っても結果が返らない。
* ログの更新が止まる / 遅延する。

**確認ポイント**

* ネットワーク品質（遅延・パケットロス・帯域）。
* Watcher 側で長時間ブロッキングするコマンドを実行していないか。
* rsync の差分が巨大でないか（大量の小ファイル）。

**対処**

* 長い処理はステップに分割する／チェックポイントを出力する。
* `rsync -n`（ドライラン）で差分規模を把握してから実行する。

## 3-1) リンクの展開が遅い / “Loading.” から進まない

**症状**

* File Explorer に追加したリンクの三角を開いても “Loading.” のまま。
* 展開に極端に時間がかかる。

**確認ポイント**

* **大規模フォルダ**をリンクしていないか（初回の一覧取得とキャッシュ準備に時間がかかることがあります）。
* 入力した **Source Path**（Watcher 側パス）が存在・読取可能か（権限・パス綴り）。
* **Link Name** にスラッシュ（`/` `\`）が含まれていないか（無効）。

**対処**

* まずサブフォルダだけをリンクして検証 → 問題がなければ段階的に範囲を広げる。
* しばらく待っても進まない場合、GUI を再起動し、リンクを作り直す。
* ネットワーク遅延や I/O が高負荷の可能性もあるため、回線状況・ディスク使用率を確認する。

---

## 4. 同期されない / 片方向のみ同期される

**症状**

* 片側で更新したはずのファイルが、もう片側に現れない。

**確認ポイント**

* `server` およびアプリルート（base_path 未設定なら ~/SyncTerm-IDE）の設定が全マシンで一致しているか。
* 同期の向き（pull/push）の誤解がないか（本システムはサーバーからのプッシュはしない）。

**対処**

* `rsync -azv` を手動実行して疎通と差分を確認する。

---

## 4-1. キャッシュ削除が失敗する（Web 版・RT モード）

**症状**

* SessionBar の「キャッシュ削除」を押すと「削除に失敗しました」や HTTP エラーが出る。

**原因と確認**

* **Relay のバックエンドが古い**  
  `cleanup-staged` でセッション未存在時に 404 を返す旧コードのままの場合、relay にセッション dir が無いと失敗します。→ 最新の `backend/app/main.py` を配置し、uvicorn を再起動してください。
* **Watcher のスクリプトが古い**  
  `_internal_cleanup_staged` を処理する処理が入っていない `command_watcher_rt.py` のままの場合、Watcher 側でキャッシュが削除されません。→ 最新の `scripts/command_watcher_rt.py` を Watcher マシンに転送し、`watcher_manager_rt.sh` を再起動してください。

**手順の詳細**

* [WEB-SETUP.md の「4-1. キャッシュ削除を動かすために（RT モード）」](WEB-SETUP.md#4-1-キャッシュ削除を動かすためにrt-モード) を参照してください。

---

## 4-2. Web 版トンネルで「Connection refused」/ channel open failed

**症状**

* `./scripts/start-web-with-tunnel.sh` 実行後にログに `channel 2: open failed: connect failed: Connection refused` が出る。
* ブラウザで API（例: ファイル一覧）が読めない / 405 や接続エラーになる。

**原因**

* **リレー上の 8000 番でバックエンドが動いていない**。トンネルは「ローカル 8002 → リレー 8000」なので、リレー側で何も listen していないと接続が拒否される。

**確認（リレーに SSH して実行）**

```bash
# ポート 8000 を誰が使っているか
lsof -i :8000

# バックエンドのログ（起動失敗の理由が書いてあることが多い）
tail -80 <アプリルート>/backend.log
```

**対処**

1. **手動でバックエンドを常駐起動する（リレー上）**

   **重要**: フォアグラウンドで `uvicorn ...` だけ実行すると、SSH を切った瞬間にプロセスが SIGHUP を受けて終了します（ログに `Shutting down` が出る）。**必ず `nohup` と `&` でバックグラウンド起動**してください。

```bash
ssh user@relay-host
cd <アプリルート>   # 例: ~/SyncTerm-IDE または deploy_dir
. .venv-backend/bin/activate
nohup uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 > backend.log 2>&1 &
echo $! > backend.pid
exit
```

   * 起動に失敗している場合は `tail -80 backend.log` でエラー（ModuleNotFoundError, config.ini not found 等）を確認する。
   * 別ターミナルで `curl -s http://127.0.0.1:8000/health` が `{"status":"ok","file_ops":true}` を返すか確認する。

2. **デプロイをやり直す**

   * ローカルで `./scripts/deploy_backend.sh user@relay-host` を再実行する。[4/5] で「uvicorn may have exited」と出た場合は、表示された `backend.log` の末尾を確認する。

---

## 5. SSH 認証エラー（`Permission denied (publickey)` など）

**確認ポイント**

* GUI 側からサーバーへ `ssh -T` が成功するか。
* `~/.ssh/authorized_keys` とパーミッション（600/700）。

**対処**

* `ssh -vvv` で詳細ログを確認。
* `~/.ssh/config` の `Host` セクションを見直し（`HostName` / `User` / `IdentityFile`）。

---

## 6. rsync エラーの典型例

**よくある例**

* `rsync: failed: Permission denied`
* `rsync: connection unexpectedly closed`

**対処**

* まず `-n`（ドライラン）で確認。
* 絶対パス/相対パスの取り違いに注意。

---

## 7. GUI 表示・操作まわりのトラブル

**症状例**

* テーマが崩れる、フォントが化ける。
* エディタが重い、ハイライトが遅い。

**対処**

* `theme.json` を簡素化する／フォントを標準的なものに。
* 大きなファイルは分割する。

### 画像プレビューが表示されない / プレースホルダのまま

**確認ポイント**

* 画像プレビューには **Pillow** が必要です。`pip install pillow` を GUI 実行環境に対して実行してください。
* 対応拡張子は `png` / `jpg` / `jpeg` / `gif` / `bmp` / `webp` です（それ以外はエディタで開くか無視されます）。
* リンク配下の画像は **ダブルクリックで一度ローカル編集キャッシュに取得**してから表示します。取得中はタイムラグが発生します。

**対処**

* Pillow 導入後に GUI を再起動する。
* 超大きな画像は読み込みに時間がかかるため、必要に応じてサイズを落とす。

---

## 8. きれいに“初期化”したい（ローカルのみ）

**手順**

* GUI を終了。
* `~/gui_local_mirror/` 配下の対象セッションフォルダを削除（必要に応じてバックアップ）。

---

## 9. 実行途中の経過が「まったく出ない」ように見える

**症状**

* 長いコマンドを実行しているのに、途中経過がしばらく何も表示されない／一気にまとまって出てくるように見える。

**実際の挙動（v3.0.0 以降）**

* `command_watcher.py` 側では、通常コマンドも Python 実行も **逐次的にログへ書き込み** ます。
  * 通常コマンド: `subprocess.Popen(..., stdout=PIPE, stderr=STDOUT)` で 1 行ずつ `commands.log` に追記。
  * Python 実行: 一時ファイル（例: `python.log`）を 0.1 秒間隔で tail しつつ `commands.log` に反映。
* GUI 側（`WatcherClient`）は `LOG_FETCH_INTERVAL_MS`（既定 1000ms）ごとに `commands.log` を pull して追記部分だけを読みます。
  * そのため、**数百 ms〜数秒単位の「かたまり」で更新される**のが正しい挙動です（完全リアルタイムではありません）。

**こう見えやすいケース**

* 非常に大量のログを一度に吐くコマンド（ビルド・大規模テストなど）。
* ネットワーク遅延や rsync の負荷が高いとき。

**対処・調整の例**

* 進捗を細かく出す: 長い処理の中で `print("step1 ...")` などを適宜出力する。
* 1 回のログ量を抑える: 必要に応じて冗長なログを減らす（`MAX_OUTPUT_CHARS` による切り捨てもあります）。
* 本当に途中が止まっているかを疑う場合は、Watcher 側で直接コマンドを実行して挙動を比較する。

---

## 10. それでも解決しない場合

**情報を添えて Issue を作成してください**

* どの項目（番号）を試し、どこで躓いたか。
* 利用 OS / Python / rsync / OpenSSH のバージョン。
* `config.ini` の主要項目（秘匿情報は伏せる）。
* エラーログ（末尾 200 行程度）。
