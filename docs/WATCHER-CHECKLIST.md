# Watcher が表示されないときのチェックリスト

Watcher 一覧は、**Relay 上の `_registry/` に `<watcher_id>.json` が存在すること**で表示される。以下を順に確認する。

---

## 1. Relay（バックエンドが動いているサーバー）

### 1-1. config.ini の場所

バックエンドは **「backend の 2 階層上」** をリポジトリルートとみなし、その直下の `config.ini` を読む。

- 例: バックエンドが `/hdd/usr/ishibashi/mnt/backend/app/main.py` なら、`/hdd/usr/ishibashi/mnt/config.ini` が読まれる。
- **必須**: そのパスに `config.ini` が存在すること。

### 1-2. config.ini の内容

```ini
[remote]
base_path = /path/on/relay/to/sessions_and_registry

[structure]
sessions_dir_name = sessions
registry_dir_name = _registry
```

- **base_path**: Relay 上で **sessions と _registry を置くディレクトリの絶対パス**。
- バックエンドは `{base_path}/{registry_dir_name}/` を参照する（既定で `{base_path}/_registry/`）。
- **必須**: `{base_path}/_registry/` が存在し、書き込み可能であること（無ければ手動で `mkdir`）。

### 1-3. 確認コマンド（Relay 上で実行）

```bash
# バックエンドの REPO_ROOT を確認（backend があるディレクトリ）
ls -la /hdd/usr/ishibashi/mnt/config.ini

# base_path の値に合わせて _registry を確認（例: base_path が /hdd/usr/ishibashi/mnt/term の場合）
ls -la /hdd/usr/ishibashi/mnt/term/_registry/
# ここに <watcher_id>.json が無いと一覧に出ない
```

---

## 2. Watcher を動かしている PC

### 2-1. config.ini

- **server**: Relay への SSH 接続先（例: `user@relay-host`）。
- **base_path**: **Relay 上**のパス（Relay の config.ini の `base_path` と **同一**にする）。
- Watcher はこの server の base_path 配下に `_registry/<watcher_id>.json` を書きに行く。

### 2-2. SSH 接続

- Watcher 用 PC から `ssh user@relay-host` でログインできること。
- 鍵認証推奨（`~/.ssh/id_ed25519` 等）。

### 2-3. Watcher の起動

- **従来**: `./watcher_manager.sh <watcher_id> "Display Name"`
- **RT 版**: `./watcher_manager_rt.sh <watcher_id> "Display Name"`
- 起動後、Watcher が Relay の `base_path/_registry/<watcher_id>.json` を更新する。
- **必須**: 同じリポジトリ（または同じ config.ini 内容）を使い、**base_path が Relay と一致していること**。

### 2-4. 確認（Watcher PC 上）

- ログやエラーで rsync/ssh 失敗が出ていないか確認。
- Relay に SSH して `ls {base_path}/_registry/` を実行し、`<watcher_id>.json` が作成・更新されているか確認。

---

## 3. ブラウザで操作している PC（クライアント）

- **VITE_BACKEND_URL**: バックエンドに届く URL。
  - トンネル利用時: `http://localhost:8002`（Relay の 8000 をトンネルした先）。
  - 直接アクセス時: `http://relay-host:8000` など。
- ここが誤っていると API 自体は動いても、別のバックエンドを見ている可能性がある（その場合は Relay の config / _registry が違う）。

---

## 4. よくある原因

| 原因 | 確認・対処 |
|------|------------|
| Relay の config.ini が無い / 別の場所 | バックエンドの「2 階層上」に config.ini を置く。 |
| base_path が Relay と Watcher で違う | 両方の config.ini の `[remote] base_path` を **同じ Relay 上のパス**に揃える。 |
| _registry が無い / 権限不足 | Relay で `mkdir -p {base_path}/_registry` し、バックエンド実行ユーザが書けるようにする。 |
| Watcher が動いていない | watcher_manager を起動し、ログでエラーがないか確認。 |
| Watcher が Relay に届いていない | Watcher PC から `ssh user@relay-host` と、Relay 上の `ls {base_path}/_registry/` で .json の有無を確認。 |

---

## 5. コマンド実行が失敗する場合（RT モード）

バックエンドは「RT で送信 → 失敗したら commands.txt に追記」の順で試す。RT が失敗し、かつ Relay にセッション dir が無いと **503** を返す（本文に原因のヒントあり）。

### 5-1. 診断エンドポイント

ブラウザまたは curl で以下を開く（`{wid}` は Watcher ID、例: `rtx5090`）。トンネル経由なら `http://localhost:8002` を付ける。

```
GET http://localhost:8002/watchers/{wid}/rt-status
```

返却例:

```json
{
  "registry_root": "/path/on/relay/_registry",
  "rt_port_file_exists": true,
  "rt_port": 9001
}
```

- **rt_port_file_exists が false**: Relay の `config.ini` の `base_path` と、Watcher の `config.ini` の `base_path` が **Relay 上で同じ**か確認。Watcher が `_registry/{wid}.rt_port` を rsync で Relay に送っているか確認。
- **rt_port はあるがコマンドが届かない**: Relay 上で `127.0.0.1:{rt_port}` に接続できるか確認。Watcher 側で `watcher_manager_rt.sh` が動いており、SSH の `-R {rt_port}:localhost:{rt_port}` が張られているか確認。

### 5-2. 確認チェック

| 項目 | 確認方法 |
|------|----------|
| Relay の config.ini | バックエンドの REPO_ROOT 直下の `config.ini`。`base_path` が Relay 上の実際のパスか。 |
| Watcher の config.ini | `base_path` が **Relay 上のパス**と一致しているか（Watcher と Relay で同じ値）。 |
| rt_port ファイル | Relay 上で `ls {base_path}/_registry/{wid}.rt_port` で存在し、中身がポート番号の数字か。 |
| SSH リバーストンネル | Watcher マシンで `ps` に `ssh.*-R.*9001` のようなプロセスがあるか。 |

---

## 6. 最小セッティング項目まとめ

- **Relay**: `config.ini`（base_path, structure）をバックエンドのリポジトリルートに置く。`{base_path}/_registry/` を用意する。
- **Watcher PC**: `config.ini`（server, base_path を Relay と同一に）。SSH 可能。watcher_manager_rt を起動。
- **クライアント**: ブラウザが接続するバックエンド URL（VITE_BACKEND_URL）が、上記 Relay のバックエンドを指していること。

**コマンドが届かないとき**: バックエンドの `GET /watchers/{wid}/rt-status` で rt_port の有無を確認。503 が出た場合はレスポンス本文のヒントを参照（セクション 5）。
