## SyncTerm‑IDE

**SyncTerm‑IDE** は、リモート開発向けの Web IDE です。Relay（中継サーバー）を介して、ブラウザから **ファイル編集 / ターミナル / GPU 状態 / AI エージェント** を一括で扱えます。

> 🚧 Experimental / Beta: 実験段階のため仕様変更の可能性があります。重要データは検証環境でお試しください。

---

## Architecture（概念）

- **Client（Browser）**: `syncterm-web/`（React + Vite）
- **Relay（Server）**: `backend/`（FastAPI）
  - セッション/ファイル保存: `sessions/<watcher>/<session>/...`
  - コマンド/ログの仲介
  - AI オーケストレーション（agent / multi）
- **Watcher（Remote node）**
  - Relay からのコマンドを実行し、ログ/GPU 状態を Relay に返す

---

## AI

- **agent**: `<command>...</command>` で安全なコマンドを実行しながら調査/修正
- **multi**: 代表エージェント（実行） + レビュワー（評価） + モデレータ（最終回答）

### CPU/GPU 指定

`config.ini` の `[ai] device` で指定します（未指定時は **cpu**）。

```ini
[ai]
device = cpu  # cpu / gpu
```

---

## Quick start（概要）

```bash
cp config.ini.example config.ini
cp .env.tunnel.example .env.tunnel

./scripts/deploy_backend.sh user@relay-host
./watcher_manager_rt.sh rtx5090 "RTX 5090 Node"
./scripts/start-web-with-tunnel.sh
```

詳細: `docs/WEB-SETUP.md`

---

## Docs

- セットアップ: `docs/WEB-SETUP.md`
- AI エージェント仕様: `docs/LOCAL-AI-AGENT-SPEC.md`

---

## License

MIT（`LICENSE`）
