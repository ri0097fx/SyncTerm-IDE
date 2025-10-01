# SyncTerm-IDE セットアップ

最小構成で **GUI（PC A）** と **Watcher（PC B ほか複数）** を、**中継サーバー** 経由で同期・制御できるようにする手順です。GUI と Watcher は別ネットワーク（NAT配下）でも、どちらも **サーバーへ SSH できれば** 連携できます（サーバーからローカルへは接続しません）。

---

## 0. 事前準備（必須）

* 各マシン（PC A / PC B / … / サーバー）に **ssh** と **rsync** が入っていること
* Python 3.9+（GUI と Watcher 側）
* サーバーへ **公開鍵認証** でログインできること（パスワードログインは不可推奨）

  * 鍵の作成とサーバー登録は **[`docs/SSH-SETUP.md`](SSH-SETUP.md)** を参照

> 参考：サーバー例 `user@203.0.113.10`、サーバー上の作業ルート `~/syncterm_remote`

---

### Windows で初めて使う場合（WSL 未導入の方）
1. **管理者権限 PowerShell を開く**  
   スタートメニューで **Windows PowerShell** を右クリックし、**「管理者として実行」** を選択。

2. **WSL + Ubuntu をインストール**
   ```powershell
   wsl --install -d Ubuntu
   ```
   もしエラーになる場合（古い Windows など）は:
   ```powershell
   dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
   dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
   ```
   再起動後に `wsl --install -d Ubuntu` を実行。
3. **Ubuntu 初期化**（初回起動してユーザ名/パスワードを設定）
4. **依存の自動導入（初回のみ）**
   ```powershell
   # リポジトリ直下から実行
   .\scripts\wsl\setup.ps1
   ```
   このスクリプトは Ubuntu 内で `rsync`/`openssh-client`/`python3` を導入します。

---

## 1. リポジトリ取得（各マシン）

サーバー、PC A（GUI）、PC B（Watcher）それぞれでリポジトリを取得します。

```bash
git clone https://github.com/ri0097fx/SyncTerm-IDE.git
cd SyncTerm-IDE
```

> HTTPS で取得する場合は `https://github.com/...` を使用して構いません。

---

## 2. `config.ini` を統一（全マシン同一内容）

このファイルは **全マシンで同一** にしてください（パスは環境に合わせて変更）。

```ini
[remote]
server = user@203.0.113.10
base_path = /home/user/syncterm_remote   ; サーバー側の作業ルート

[local_paths]
; GUI 側のローカルミラー
gui_mirror_dir = ~/gui_local_mirror

[structure]
sessions_dir_name = sessions
registry_dir_name = _registry
```

* サーバー上では `base_path` 以下に `sessions/` と `_registry/` が使用されます（存在しなければ自動作成されます）。
* GUI / Watcher は、それぞれのローカル側にミラー（キャッシュ）を作ります。

---

## 3. 依存パッケージ（GUI マシンのみ）

GUI マシン（PC A）で必要な Python パッケージを入れます。

```bash
pip install -r requirements.txt  # Pygments など
```

> macOS の場合、`tkinter` は公式 Python か Homebrew Python に含まれます。

---

## 4. Watcher を起動（PC B / PC C … 任意台数）

Watcher は **ローカル PC 側** で起動します（サーバーではありません）。

```bash
# 例: PC B で
chmod +x watcher_manager.sh
./watcher_manager.sh <watcher_id> "<Display Name>"

# バックグラウンド起動例（ログをファイルへ）
nohup ./watcher_manager.sh pc-b "PC B" > watcher.log 2>&1 &
```

* `watcher_id` は GUI で識別するための一意な文字列（例: `pc-b`、`laptop-01`）
* `<Display Name>` は GUI のプルダウンに表示される名前
* 正常に動いていれば、サーバーの `base_path/_registry/` に `watcher_id` という名前の JSON が作成・更新されます（ハートビート）

---

## 5. GUI を起動（PC A）

```bash
python gui_terminal.py
```

GUI から以下の手順で接続します：

1. 右上の **Watcher** プルダウンに、先ほど起動した表示名（例: `PC B`）が現れることを確認
2. **Session** を選択、または **New** に任意名を入力して **Create**
3. ターミナルにプロンプトが出れば接続完了（`[Remote] user@host:~$` など）

> GUI はサーバー上のファイル（ログ等）を **ローカルから rsync で取得** し、コマンドは **サーバーへアップロード** して Watcher に拾わせます。サーバーがローカルに能動接続することはありません。

---

## 6. 動作確認チェックリスト

* [ ] PC A / PC B から `ssh user@203.0.113.10` でパスワードなしログインできる
* [ ] サーバーの `base_path/_registry/` に `watcher_id` の JSON が周期的に更新される
* [ ] GUI の Watcher 一覧に表示名が出る
* [ ] セッション作成後、簡単なコマンド（`pwd` など）が GUI のターミナルで実行できる

---

## 7. よくあるつまずき

* **`Permission denied (publickey)`**

  * 公開鍵がサーバーの `~/.ssh/authorized_keys` に入っていない／権限が厳格でない
  * `docs/SSH-SETUP.md` を再確認し、ローカル `~/.ssh` パーミッション（`700`）、秘密鍵（`600`）を確認
* **Watcher が GUI に出てこない**

  * PC B 側の `watcher_manager.sh` が起動していない／エラー終了している
  * サーバーの `base_path/_registry/<watcher_id>` が更新されていない → ネットワーク/権限/パスを確認
* **プロンプトが `$` のみで `user@host` が出ない**

  * セッション直下の `.watcher_status.json` がまだ生成・同期されていない可能性
  * Watcher 側の Python が動作し、`sessions/<watcher_id>/<session>/` 配下にステータス/ログが出ているか確認

> さらに詳しい対処は **[`docs/TROUBLESHOOT.md`](TROUBLESHOOT.md)** を参照してください。

---

## 8. 別ネットワーク（NAT 配下）運用のポイント

* **双方向の受け入れポート開放は不要**：GUI / Watcher ともに、**外向き（→サーバー）** の SSH/rsync ができれば動作します。
* サーバーは **中継（ストレージ）役** としてファイルを受け取り、GUI はそれを自分から取りに行きます。
* 企業ネットワーク等でアウトバウンドが制限されている場合は、プロキシ経由の SSH が必要になることがあります。

---

## 9. 次のステップ

* 認証の詳細：**[`docs/SSH-SETUP.md`](SSH-SETUP.md)**
* 使い方の詳細（エディタ／ターミナル操作）：**[`docs/USAGE.md`](USAGE.md)**
* トラブルシュート：**[`docs/TROUBLESHOOT.md`](TROUBLESHOOT.md)**

---

© SyncTerm-IDE
