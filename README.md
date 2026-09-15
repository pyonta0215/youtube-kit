# youtube-kit

YouTube Data API v3 を呼ぶ小さなクライアントです。Node 20 以上と Cloudflare Workers の両方で動きます（グローバルの `fetch` / `URL` / `AbortSignal` だけを使い、依存パッケージはありません）。

- チャンネル・動画の取得（ID の重複除去と50件ずつの分割）
- 再生リストのページング
- URL / `@ハンドル` / チャンネル ID / 動画 URL の解釈
- 失敗の分類（クォータ超過・レート制限・見つからない・タイムアウトなど）
- 実際に送った回数によるクォータの計測（検索枠と合算枠を分け、失敗も数える）

npm には公開していません。git タグで参照します。

```bash
npm install github:pyonta0215/youtube-kit#v0.1.0
```

## 使い方

```js
import { createQuotaMeter, createYouTubeClient, parseChannelRef } from '@pyonta0215/youtube-kit';

const meter = createQuotaMeter();
const yt = createYouTubeClient({ apiKey: env.YOUTUBE_API_KEY, meter });

const ref = parseChannelRef('https://www.youtube.com/@example');
const channel = ref && (await yt.channelByRef(ref));
const { ids } = await yt.playlistVideoIds(channel.uploadsPlaylistId, 50);
const videos = await yt.videos(ids);

console.log(meter); // { units: 3, searchCalls: 0, calls: 3, failed: 0, by: { channels: 1, playlistItems: 1, videos: 1 } }
```

返す値はプロダクトの保存形式に合わせていません（`publishedAt` は ISO 8601 のまま、再生時間は秒）。列名や日付の切り方は利用側で変換してください。

## クォータ

公式の Quota Calculator（2026-09-14 更新版）で確認した既定値です。

| 枠 | 対象 | 既定の上限 |
|---|---|---|
| search | `search.list` 1回ごと | 1日 100 回 |
| combined | `channels.list` / `videos.list` / `playlistItems.list` はそれぞれ 1 unit | 1日 10,000 units |

- 2つの枠は別々に数えます。`search.list` を「100 units」として合算枠に足すのは旧来の数え方です
- 無効なリクエストも最低 1 unit を消費するので、`QuotaMeter` は**送る前に数え**、失敗した回数を `failed` に別に持ちます
- 上限は GCP プロジェクト単位で、太平洋時間の0時にリセットされます

**`QuotaMeter` は1つの処理の中の呼び出しカウンタです。** 日をまたいだ上限や、同じキーを使う複数のプロセスを合わせた上限は守りません。それが必要なら、利用側でメーターの値を永続化して合算し、呼ぶ前に判定してください。

## 失敗

`YouTubeApiError` は `kind`・`method`・`status`・`reason` を持ちます。

| kind | 状況 |
|---|---|
| `quota-exceeded` | `quotaExceeded` / `dailyLimitExceeded` |
| `rate-limited` | 429、`rateLimitExceeded` |
| `forbidden` / `not-found` / `bad-request` / `server` / `http` | 状態コードによる |
| `timeout` / `network` / `invalid-json` | 応答を得られなかった・読めなかった |
| `no-api-key` | キーが無い（送らず、数えない） |

API キーはクエリ文字列に載るため、メッセージに URL・本文・API のメッセージは入れません。

## 参照の解釈

`parseChannelRef` は次を解釈します。表示名だけの文字列は解決しません（`search.list` で探すと、別枠の検索回数を黙って使うため）。

| 入力 | 結果 |
|---|---|
| `UC…`（24文字）、`/channel/UC…` | `{ kind: 'id' }` |
| `@handle`、`/@handle` | `{ kind: 'handle' }` |
| `/user/name` | `{ kind: 'username' }` |
| `/c/name` | `{ kind: 'handle', value: '@name' }`（ハンドルと同じことが多いので試す） |
| 動画 URL（`watch?v=` / `youtu.be` / `shorts` / `live` / `embed`） | `{ kind: 'video' }`（`channelByRef` は videos.list も使う） |

## ここに入れないもの

- 監視するチャンネル、収集履歴、候補の判定、保存先（D1 など）、MCP のツール定義
- API キーや収集したデータ

## 開発

```bash
npm ci
npm run check   # typecheck → test → build → dist に差分が無いことを確認
```

`dist/` はコミットします。

## License

MIT
