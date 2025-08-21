# SSH & rsync セットアップ（最短ルート）

この手順は、メール等のコメントを付けずに **`ssh-keygen -t ed25519` だけ** で鍵を作成し、`user@xxx.xxx...` なサーバーへ登録する最短ルートです。

---

## 1) 鍵を作る（コメントなし）

```bash
ssh-keygen -t ed25519
```

* `Enter file in which to save the key`: そのまま Enter → 既定の `~/.ssh/id_ed25519`
* `Passphrase`: 任意（推奨）

## 2) 公開鍵をサーバーへ配布

### ssh-copy-id が使える場合（推奨）

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@xxx.xxx...
```

### ssh-copy-id が無い場合（手動）

```bash
cat ~/.ssh/id_ed25519.pub | ssh user@xxx.xxx... 'mkdir -p ~/.ssh \
  && chmod 700 ~/.ssh \
  && cat >> ~/.ssh/authorized_keys \
  && chmod 600 ~/.ssh/authorized_keys'
```

## 3) 接続テスト

```bash
ssh user@xxx.xxx...
```

## 4) （任意）\~/.ssh/config を作る

毎回ユーザー名やホスト名を打たないためのショートカットです。

```conf
Host devbox
  HostName xxx.xxx...
  User user
  IdentityFile ~/.ssh/id_ed25519
```

以後は次のように使えます：

```bash
ssh devbox
# rsync の例（アップロード / ダウンロード）
rsync -az ./local_dir/ devbox:/remote/dir/
rsync -az devbox:/remote/dir/ ./local_dir/
```

> 権限に関するヒント

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```
