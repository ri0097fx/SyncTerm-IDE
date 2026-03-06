## SyncTerm-IDE Web 版 セットアップガイド

本ドキュメントは、SyncTerm-IDE の Web 版（ブラウザクライアント + FastAPI バックエンド）の構成とセットアップ手順を記載する。

---

## 1. 構成概要

- **Watcher 側（PC B/C...）**  
  - `watcher_manager_rt.sh` および `scripts/command_watcher_rt.py` を実行するマシン（Watcher）。  
  - コマンドの実行およびファイルの更新を行う。

- **中継サーバー（Relay）**  
  - SSH でアクセス可能な Linux サーバーを想定する。  
  - `config.ini` の `base_path` に従い、`sessions/` および `_registry/` を配置する。  
  - **FastAPI バックエンド** を常駐させ、ブラウザからの HTTP リクエストを受ける。

- **クライアント（Web フロント）**  
  - ローカル PC 上で `syncterm-web` を起動し、ブラウザで `http://localhost:5173` にアクセスして操作する。  
  - 画面構成: 上部に Watcher / Session / Runner、左に Files、右に Editor、下に Terminal。

---

## 2. 前提条件

- **中継サーバー**: Python 3.9 以上、SSH でログイン可能であること。`config.ini` の `base_path` 以下に `sessions/` および `_registry/` が作成可能であること。
- **Watcher 側**: SyncTerm-IDE の既存要件を満たし、`watcher_manager_rt.sh` を実行できること。
- **クライアント（Web フロント実行環境）**: Node.js v18 以上、およびブラウザ（Chrome / Edge / Safari 等）。

---

## 3. 中継サーバー側のセットアップ

以下は中継サーバー上で実行する。

### 3-1. リポジトリの配置

```bash
git clone <リポジトリURL> SyncTerm-IDE
cd SyncTerm-IDE
```

既に配置済みの場合は不要である。

### 3-2. `config.ini` の確認

`config.ini` の `base_path` が、中継サーバー上の所定の作業ディレクトリを指していることを確認する。

```ini
[remote]
server = user@devserver.example.com
base_path = /home/user/remote_dev

[structure]
sessions_dir_name = sessions
registry_dir_name = _registry
```

環境に応じて `server` および `base_path` を編集する。FastAPI バックエンドは `base_path` および `sessions_dir_name` / `registry_dir_name` に従い `sessions/` と `_registry/` を参照する。

### 3-3. バックエンド（FastAPI）のインストールと起動

```bash
cd backend
pip install -r requirements.txt

# 開発・検証時（自動リロードあり）
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```

起動に成功すると、`http://<サーバー名>:8000/docs` で Swagger UI が表示される。ポート 8000 が Web フロントを実行するマシンから到達可能であることを確認すること。

---

## 4. Watcher 側の準備

Watcher は **RT モード**（`watcher_manager_rt.sh`）で稼働させる。Watcher が中継サーバーへ SSH リバーストンネルを張り、コマンド・ログを HTTP で即時送受信する。

**前提**: Watcher 側から中継サーバーへ SSH 接続可能であること。

1. `config.ini` に `[rt]` セクションを追加する（既存の場合はスキップ）:

```ini
[rt]
rt_port = 9001
backend_port = 8000
relay_local_port = 8001
```

ポート 8000 が既に使用中の場合、`relay_local_port` を 8001 等に変更する。

2. Watcher を稼働させる PC（PC B/C...）で、以下を実行する:

```bash
cd SyncTerm-IDE
chmod +x watcher_manager_rt.sh
./watcher_manager_rt.sh pc-b "PC B"
```

- `pc-b`: 一意な Watcher ID  
- `"PC B"`: Web UI に表示するラベル  

3. バックエンドは `_registry/<watcher_id>.rt_port` を検出し、コマンドを HTTP で送信、ログを `log-append` で受信する。

### 4-2. キャッシュ削除（RT モード）

「キャッシュ削除」で Staged キャッシュを削除するには、Relay および Watcher の両方で最新コードを配置し、必要に応じてプロセスを再起動する。

| 場所 | やること |
|------|----------|
| **Relay（中継サーバー）** | 最新の `backend/app/main.py` を配置し、FastAPI（uvicorn）を再起動する。 |
| **Watcher** | 最新の `scripts/command_watcher_rt.py` を転送し、`watcher_manager_rt.sh` を再起動する。 |

例:

```bash
# 手元の SyncTerm-IDE から Watcher へスクリプトを転送
rsync -av scripts/command_watcher_rt.py user@watcher-host:/path/to/SyncTerm-IDE/scripts/
# Watcher マシンに SSH して watcher_manager_rt を再起動
```

Relay 側でバックエンドを再起動する例:

```bash
# Relay マシン上で
cd /path/to/SyncTerm-IDE/backend
# 既存の uvicorn プロセスを止めてから
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

---

## 5. Web フロントエンドの起動（クライアント側）

以下はローカル（Web フロントを実行するマシン）で行う。

### 5-1. 依存パッケージのインストール

```bash
cd /path/to/SyncTerm-IDE/syncterm-web
npm install
```

### 5-2. バックエンド URL の設定（必要に応じて）

中継サーバーと Web フロントが別マシンの場合、`syncterm-web` 直下に `.env.local` を作成し、バックエンドの URL を指定する。

```env
VITE_BACKEND_URL=http://<中継サーバーのホスト名またはIP>:8000
VITE_AI_PROXY_URL=http://127.0.0.1:8011
```

中継サーバーと同一マシンで実行する場合、またはポート 8000 に直接アクセスできる場合は省略可能である。省略時は `http://localhost:8000` が使用される。

### 5-2.1 AI アシストをローカルで運用する場合

`OPENAI_API_KEY` を中継サーバーに置かず、ローカルで AI プロキシを起動する構成を推奨する。

```bash
cd /path/to/SyncTerm-IDE
python3 -m venv .venv-local-ai
. .venv-local-ai/bin/activate
pip install fastapi uvicorn
export OPENAI_API_KEY="<your-local-openai-key>"
export OPENAI_MODEL="gpt-4o-mini"
python scripts/local_ai_proxy.py
```

プロキシは `http://127.0.0.1:8011` で待ち受け、Web フロントの AI 補完・AI アシストがここに接続する。

### 5-2.2 Ollama で AI 機能を使う場合

OpenAI API キーを使わず、ローカルで Ollama を利用する構成も可能である。

```bash
brew install ollama
ollama serve
ollama pull qwen2.5-coder:7b
```

別ターミナルでローカル AI プロキシを起動する:

```bash
cd /path/to/SyncTerm-IDE
python3 -m venv .venv-local-ai
. .venv-local-ai/bin/activate
pip install fastapi uvicorn
export AI_PROVIDER=ollama
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen2.5-coder:7b
python scripts/local_ai_proxy.py
```

AI 補完・AI アシストはローカル完結で動作する。

### 5-3. 開発サーバーの起動

**方法 A: トンネル付き一括起動（推奨・RT モード時）**

SSH トンネルと Vite を同一プロセスで起動する。終了時（Ctrl+C）にトンネルも停止する。

```bash
cd /path/to/SyncTerm-IDE
cp .env.tunnel.example .env.tunnel
# .env.tunnel の TUNNEL_SSH を user@relay の形式で編集
./scripts/start-web-with-tunnel.sh
```

または `syncterm-web` ディレクトリから:

```bash
cd /path/to/SyncTerm-IDE/syncterm-web
npm run dev:tunnel
```

トンネル（例: localhost:8002 → relay:8000）が張られたうえで Vite が起動する。

**方法 B: トンネルを別ターミナルで張る場合**

```bash
cd /path/to/SyncTerm-IDE/syncterm-web
npm run dev
```

表示された URL（例: `http://localhost:5173`）をブラウザで開く。バックエンドへは別途 SSH トンネル等で接続すること。

---

## 6. ブラウザ上の操作

画面構成: 上部に Watcher / Session / Runner、左に Files、右に Editor、下に Terminal。

### 6-1. Watcher と Session の選択

1. 画面上部の Watcher ドロップダウンを開く。中継サーバーの `_registry/` 内の `<watcher_id>.json` に基づき一覧が表示される。
2. Watcher を選択すると、その Watcher に属する Session が Session ドロップダウンに表示される。
3. 使用する Session を選択する。Files / Editor / Terminal は選択した Session に紐づく。

### 6-2. Terminal でコマンドを実行する（Remote）

1. 下ペインの Mode が `Remote` であることを確認する。
2. 入力欄にコマンドを入力し、Enter または Send で送信する。
3. バックエンドが `commands.txt` にコマンドを書き込み、Watcher が実行して `commands.log` に出力する。
4. Web UI は `/log` API により `commands.log` の追記分を取得し、ターミナルに表示する。

Local モードは Web 版では**コマンドを実行しない**。入力した文字列を表示するだけのダミーである。ブラウザからローカルシェルを実行する API はないため、実機でのローカルターミナル機能は提供していない。

### 6-3. ファイルの編集

1. 左の Files ツリーで Session 配下のフォルダを展開し、ファイルをクリックする。
2. 右の Editor に内容が読み込まれる。
3. 編集後、Save を押すと中継サーバー上の該当ファイルが更新される。

Watcher 側ではサーバー上のファイルが更新されただけとして扱われる。

---

## 7. トラブルシューティング

### Watcher 一覧が空

- 中継サーバーの `{base_path}/_registry/` に `<watcher_id>.json` が存在するか、更新されているかを確認する。
- `watcher_manager_rt.sh` が稼働しているか、`config.ini` の `base_path` が正しいかを確認する。

### Session 一覧が空

- `{base_path}/sessions/<watcher_id>/` 配下にセッション名のディレクトリが存在するか確認する。Watcher 側でセッションを作成したうえで再読み込みする。

### Terminal に出力が出ない、または遅い

- 中継サーバーで `tail -f {base_path}/sessions/<watcher>/<session>/commands.log` を実行し、ログが追記されているか確認する。
- FastAPI バックエンド（uvicorn）のログにエラーがないか確認する。

### Editor の保存が反映されない

- サーバー上で該当ファイルの最終更新時刻を確認する。ブラウザで再読み込みすると `/file` API から最新内容が取得される。

---

## 8. まとめ

- Watcher 側の構成は従来のままとして、GUI を Web（React）と FastAPI バックエンドに置き換えた構成である。
- 中継サーバー上のファイル・ログに HTTP で直接アクセスし、rsync ポーリングに依存しない運用が可能である。
- 運用の流れ: (1) Watcher を起動、(2) 中継サーバーで FastAPI を起動、(3) ローカルで `syncterm-web` を起動してブラウザでアクセス。以降は画面上で操作する。

