# Browser Overlay

`obs-remote-controller` には、OBS Browser Source 用の軽量な文字オーバーレイが含まれています。

## OBS側の設定

1. `obs-remote-controller` を通常どおり起動します。
2. OBSで「ソースを追加」→「ブラウザ」を選びます。
3. URLに次を設定します。

```text
http://127.0.0.1:8787/overlay/
```

4. 配信解像度が1920x1080なら、Browser Sourceの幅を `1920`、高さを `1080` にします。
5. Browser Source自体は常時表示したままにします。表示・非表示はHTML内部で切り替えるため、OBS側でソースを毎回ON/OFFする必要はありません。

複数シーンで共通利用する場合は、Browser Sourceを置いた専用シーン（例: `Remote Overlay`）を作り、そのシーンを各配信シーンへ追加すると管理しやすくなります。

## スマートフォンからできること

操作画面の「文字オーバーレイ」から以下を変更できます。

- 500文字までの自由テキスト
- 表示 / 非表示
- 上 / 中央 / 下の位置
- 18〜180pxの文字サイズ
- 文字色
- 半透明の黒背景のON/OFF
- フェード / アニメーションなし
- 無期限 / 5秒 / 10秒 / 30秒 / 60秒表示

表示時間を指定した場合、自動非表示はMac側サーバーで処理されます。操作後にスマートフォンの画面を閉じてもタイマーは継続します。

## 仕組み

```text
スマートフォン
  ↓ Bearer認証付き PUT /api/overlay
obs-remote-controller
  ↓ overlay state
SSE /overlay/events
  ↓
OBS Browser Source /overlay/
```

Browser SourceはSSEを使って状態変更を受け取るため、テキスト更新や表示切り替えのたびにページを再読み込みしません。接続が一時的に切れてもブラウザの `EventSource` が自動再接続します。

`/api/overlay` への書き込みは既存の `REMOTE_CONTROL_TOKEN` が必須です。Browser Sourceが読む `/overlay/` と `/overlay/events` は読み取り専用で、OBSからlocalhost経由で利用することを想定しています。

## API

### 状態取得

```http
GET /api/overlay
Authorization: Bearer <REMOTE_CONTROL_TOKEN>
```

### 状態更新

```http
PUT /api/overlay
Authorization: Bearer <REMOTE_CONTROL_TOKEN>
Content-Type: application/json
```

例:

```json
{
  "text": "ただいま準備中です",
  "visible": true,
  "position": "center",
  "fontSize": 72,
  "color": "#ffffff",
  "background": true,
  "animation": "fade",
  "durationMs": 10000
}
```

すべてのフィールドを毎回送る必要はなく、`{ "visible": false }` のような部分更新もできます。

## 現在の制約

初期実装は自由テキスト1枠です。画像、QRコード、複数スロット、名前＋サブタイトル形式、プリセット保存などは同じBrowser Source基盤の上へ追加できます。
