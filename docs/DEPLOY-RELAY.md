# リレー（バックエンド）の更新手順

リレーサーバーで動かしている FastAPI バックエンドを、最新コードで更新する手順です。  
更新後、**セッション作成**（`POST .../sessions`、body: `{"name":"セッション名"}`）などが利用できます。

---

## 前提

- 手元の PC で SyncTerm-IDE のリポジトリが最新（`git pull` 済みなど）
- リレーへ SSH できる（例: `ssh user@relay-host`）
- `config.ini` の `[remote]` の `server` がリレーを指している

---

## 手順 1: デプロイ実行（手元の PC で）

リポジトリの**ルート**で実行します。

```bash
cd /path/to/SyncTerm-IDE
./scripts/deploy_backend.sh user@relay-host
```

- `user@relay-host` は `config.ini` の `server` に合わせて指定する。
- 第 2 引数を省略すると、`config.ini` の `[remote]` に `deploy_dir` があればそのパス、なければ **`~/SyncTerm-IDE`** がリレー上のデプロイ先になる。
- 別のディレクトリにデプロイしたい場合:
  ```bash
  ./scripts/deploy_backend.sh user@relay-host '/path/on/relay' 8000
  ```

実行すると次のような流れになります。

1. **[0/5]** リモートのデプロイ先を絶対パスに解決
2. **[1/5]** `backend/` を rsync で転送
3. **[2/5]** `config.ini` / `watcher_manager_rt.sh` / `scripts/` を転送
4. **[2b/5]** デプロイ先（アプリルート）直下に `sessions` / `_registry` を作成
5. **[3/5]** リモートで venv 作成と `pip install -r backend/requirements.txt`
6. **[4/5]** 既存の uvicorn を停止し、新しく起動（`backend.pid` に PID 保存）

エラーが出た場合は、表示されたメッセージに従って対処してください。

---

## 手順 2: リレー上でコードが入っているか確認（任意）

SSH でリレーに入り、**セッション作成**（POST /watchers/{wid}/sessions）が含まれているか確認します。

```bash
ssh user@relay-host "grep -n 'def create_session' ~/SyncTerm-IDE/backend/app/main.py"
```

- `deploy_dir` で別パスにしている場合は、そのパスに置き換える。  
  例: デプロイ先が `~/mnt` の場合:  
  `ssh user@relay-host "grep -n 'def create_session' ~/mnt/backend/app/main.py"`

次のような行が出ていれば、最新コードが置けています。

```
430:def create_session(wid: str, body: CreateSessionModel):
```

何も出てこない場合は、デプロイ先のパスが違うか、rsync が失敗している可能性があります。

---

## 手順 3: 動作確認（手元の PC で）

トンネルでリレーの 8000 番をローカルの 8002 に転送している前提です。

1. **トンネルと Web を起動**
   ```bash
   ./scripts/start-web-with-tunnel.sh
   ```
   または、既に別ターミナルでトンネルと `npm run dev` を動かしている場合はそのままでかまいません。

2. **セッション作成 API を叩く**
   ```bash
   curl -s -X POST "http://localhost:8002/watchers/<watcher_id>/sessions" \
     -H "Content-Type: application/json" \
     -d '{"name":"test-session"}' \
     -w "\nHTTP: %{http_code}\n"
   ```
   - `<watcher_id>` は必ず実際の ID に置き換える（`GET http://localhost:8002/watchers` で一覧の `id` を確認。例: `rtx5090` → `curl .../watchers/rtx5090/sessions`）。

3. **期待する結果**
   - **HTTP: 200** かつ JSON で `{"name":"test-session","watcherId":"<watcher_id>"}` に近い内容  
     → セッション作成は動いている。
   - **HTTP: 404**  
     → リレー上のバックエンドがまだ古い。手順 1 のデプロイと、リレー上のプロセス再起動を再度確認する。

---

## うまくいかないとき

- **デプロイ先が違う**  
  `config.ini` の `deploy_dir` と、実際に uvicorn を起動しているディレクトリが同じか確認する。
- **uvicorn が再起動されていない**  
  リレー上で `backend.pid` のプロセスを確認し、必要なら手動で停止してから `deploy_backend.sh` を再実行するか、手動で uvicorn を起動する。
- **トンネルが張られていない**  
  `start-web-with-tunnel.sh` を実行したターミナルでエラーが出ていないか、`curl http://localhost:8002/watchers` が 200 を返すか確認する。
