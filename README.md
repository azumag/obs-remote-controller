# OBS Remote Controller

Macで起動しているOBS Studioを、同じtailnet上のスマートフォンから操作する軽量Webリモコンです。

初期実装では次の操作に対応しています。

- 配信開始・配信停止（確認ダイアログ付き）
- 現在のプログラムシーン切り替え
- 音声入力ごとのミュート・ミュート解除
- OBS接続状態、配信状態、現在シーン、ミュート状態の表示
- OBSを再起動した場合の自動再接続
- macOSログイン時の自動起動（LaunchAgent）
- スマートフォンのホーム画面へ追加できるPWA形式のUI

## 推奨構成

```text
スマートフォン
  │ HTTPS（tailnet内のみ）
  ▼
Tailscale Serve
  │ HTTP / 127.0.0.1:8787
  ▼
Node.jsゲートウェイ（このリポジトリ / Mac）
  │ OBS WebSocket v5 / 127.0.0.1:4455
  ▼
OBS Studio
```

OBS WebSocketのポート `4455` をTailscaleへ直接公開せず、OBSのパスワードもスマートフォンへ渡しません。スマートフォンは専用の操作トークンでMac側ゲートウェイへアクセスし、ゲートウェイだけがOBSへ接続します。

ランタイム依存パッケージはありません。Node.js 22標準のHTTPサーバー、WebSocket、暗号機能だけで動作します。詳細は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

## 必要環境

- macOS
- Node.js 22以降
- OBS Studio 28以降（obs-websocket v5内蔵版）
- Macとスマートフォンの両方にTailscaleが入り、同じtailnetへ接続済みであること

## セットアップ

### 1. インストール

```bash
git clone https://github.com/azumag/obs-remote-controller.git
cd obs-remote-controller
npm install
npm run setup
```

`npm run setup` はランダムな64桁の操作トークンを生成し、権限 `0600` の `.env` を作成します。既存の `.env` は上書きしません。

### 2. OBS WebSocketを設定

OBS Studioで次を開きます。

```text
ツール → WebSocketサーバー設定
```

次を設定してください。

- WebSocketサーバーを有効化
- サーバーポートを確認（標準は `4455`）
- 認証を有効化
- パスワードを設定または確認

続いて `.env` を編集します。

```dotenv
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=OBS側で設定したパスワード
```

### 3. Mac上で起動

```bash
npm start
```

Mac内での確認URLは次です。

```text
http://127.0.0.1:8787
```

OBSが起動していない場合でもWeb画面は起動します。OBSとの接続だけが未接続表示になり、バックエンドは自動再接続を続けます。

### 4. Tailscale Serveでスマートフォンへ公開

別のターミナルで実行します。

```bash
npm run tailscale:serve
```

標準設定では `127.0.0.1:8787` を、tailnet内だけのHTTPSポート `8443` に公開します。出力されたURLをスマートフォンで開いてください。形式は概ね次のとおりです。

```text
https://<MacのMagicDNS名>.<tailnet名>.ts.net:8443/
```

初回はTailscaleのHTTPS機能を有効にする確認が表示される場合があります。

画面が開いたら、Mac側 `.env` の `REMOTE_CONTROL_TOKEN` を入力します。トークンはスマートフォンのブラウザ内に保存され、URLやHTMLには含まれません。

Serveを停止する場合は次を実行します。

```bash
npm run tailscale:serve:off
```

> この用途では `tailscale funnel` を使わないでください。Funnelは公開インターネット向けです。tailnet内だけに限定するServeを使用します。

## macOSログイン時に自動起動

`.env` の設定と手動起動を確認してから実行します。

```bash
npm run install:launch-agent
```

次のLaunchAgentが作成され、直ちに起動します。

```text
~/Library/LaunchAgents/com.azumag.obs-remote-controller.plist
```

ログは次に出力されます。

```text
~/Library/Logs/obs-remote-controller.log
~/Library/Logs/obs-remote-controller.error.log
```

解除する場合は次を実行します。

```bash
npm run uninstall:launch-agent
```

Tailscale Serveは `--bg` で登録されるため、設定はバックグラウンドで維持されます。

## スマートフォンでの操作

### 配信開始・停止

現在の状態に応じて「配信を開始」「配信を停止」に変わります。実行前に確認ダイアログを表示し、バックエンドでも現在状態を確認するため、同じ開始・停止要求を重複送信しません。

### シーン切り替え

OBSのシーンをボタン表示し、現在のプログラムシーンを強調します。現在シーン以外を押すと切り替わります。

### 音声ミュート

OBSの入力一覧のうち、ミュート状態を取得できる入力だけを表示します。カメラなど音声を持たない入力は自動的に除外されます。

### ホーム画面へ追加

SafariまたはChromeの共有・メニューから「ホーム画面に追加」を選ぶと、アプリ風に起動できます。

## 環境変数

| 変数 | 標準値 | 説明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP待受アドレス。Tailscale Serve利用時は変更しないことを推奨 |
| `PORT` | `8787` | Mac内のHTTPポート |
| `REMOTE_CONTROL_TOKEN` | 必須 | API操作用の32文字以上のトークン |
| `OBS_WEBSOCKET_URL` | `ws://127.0.0.1:4455` | OBS WebSocket v5のURL |
| `OBS_WEBSOCKET_PASSWORD` | 空 | OBS WebSocketのパスワード |
| `OBS_RECONNECT_INTERVAL_MS` | `3000` | OBS再接続間隔（500〜60000ミリ秒） |
| `TAILSCALE_HTTPS_PORT` | `8443` | Tailscale Serve側のHTTPSポート |
| `TAILSCALE_BIN` | 自動検出 | Tailscale CLIを検出できない場合の実行パス |
| `ENV_FILE` | `.env` | 別の環境設定ファイルを使う場合のパス |

## セキュリティ方針

- HTTPサーバーは標準で `127.0.0.1` にだけバインドします。
- OBS WebSocketも `127.0.0.1:4455` のまま使います。
- Tailscale Serveによりtailnet内だけへHTTPS公開します。
- 状態取得を含む操作APIはBearerトークン認証を必須にします。
- トークン比較はSHA-256ダイジェストを定時間比較します。
- OBSパスワードと操作トークンをログへ出力しません。
- CORSを許可せず、厳格なContent Security Policyを送ります。
- API本文は16 KiBに制限します。
- 配信開始・停止はUI確認とサーバー側の冪等制御を併用します。
- Tailnetのアクセスポリシーでも、Serveポート `8443` へ到達できるユーザー・端末を絞ることを推奨します。

`HOST=0.0.0.0` にするとWi-Fiや有線LANからも到達可能になるため、通常は使わないでください。

## API

静的ファイルと `/api/health` を除き、次のヘッダーが必要です。

```http
Authorization: Bearer <REMOTE_CONTROL_TOKEN>
```

| Method | Path | JSON本文 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | なし | ゲートウェイの死活確認（認証不要） |
| `GET` | `/api/state` | なし | OBS・配信・シーン・音声状態 |
| `POST` | `/api/stream` | `{ "active": true }` | 配信開始・停止 |
| `POST` | `/api/scene` | `{ "sceneName": "Main" }` | プログラムシーン切り替え |
| `POST` | `/api/input-mute` | `{ "inputName": "Mic/Aux", "muted": true }` | ミュート状態設定 |
| `POST` | `/api/obs/reconnect` | `{}` | OBSへ直ちに再接続 |

## 開発・テスト

```bash
npm run check
npm test
```

開発時の自動再起動は次です。

```bash
npm run dev
```

GitHub ActionsでもNode.js 22で構文検査とテストを実行します。

## トラブルシューティング

### スマートフォンからURLを開けない

- MacとスマートフォンのTailscaleが接続中か確認
- `npm start` が起動中か確認
- `npm run tailscale:serve` の出力URLとポートを確認
- `tailscale serve status` でServe設定を確認
- Tailnetのアクセスポリシーを確認

### 画面は開くがOBS未接続になる

- OBS Studioが起動しているか確認
- OBSの「WebSocketサーバー設定」でサーバーが有効か確認
- `.env` のポートとパスワードを確認
- 自動起動利用時は `~/Library/Logs/obs-remote-controller.error.log` を確認
- 画面下部の「OBSへ再接続」を押す

### 操作トークンが通らない

- `.env` の `REMOTE_CONTROL_TOKEN` を改行なしでコピー
- 画面右上の設定から保存済みトークンを削除し、再入力
- `.env` を変更した場合はNode.jsプロセスを再起動

### 音声入力が表示されない

バックエンドはOBSの `GetInputMute` が成功する入力だけを表示します。対象ソースがOBSの音声ミキサーに存在するか確認してください。

## 初期実装に含めていないもの

- 映像プレビュー、音声モニタリング
- 録画、リプレイバッファ、スタジオモード、トランジション操作
- シーン・音声入力の固定や並べ替え
- Tailscaleユーザーごとの権限制御
- 操作履歴、Discord通知

これらはAPIとUIを拡張して追加できます。

## License

MIT
