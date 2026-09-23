/**
 * YouTube Data API v3 の小さなクライアント。Node 20 以上と Cloudflare Workers の両方で動く
 * （グローバルの fetch / URL / AbortSignal だけを使う）。
 *
 * ここにあるのは、チャンネル・動画の取得、ページング、ID の分割、URL などからの参照の解釈、
 * 失敗の分類、実際に投げた回数によるクォータの計測だけ。
 * 監視するチャンネル、収集履歴、候補の判定、保存先、日をまたいだクォータの上限は利用側に置く。
 *
 * ## クォータ（公式の Quota Calculator、2026-09-14 更新版で確認）
 *
 * | 枠 | 対象 | 既定の上限 |
 * |---|---|---|
 * | search | `search.list` 1回ごと | 1日 100 回 |
 * | combined | `channels.list` / `videos.list` / `playlistItems.list` などは各 1 unit | 1日 10,000 units |
 *
 * 2つの枠は別々に数え、足し合わせない。無効なリクエストも最低 1 unit を消費するので、
 * **失敗した呼び出しも送った時点で数える。** 上限は GCP プロジェクト単位で、太平洋時間の0時にリセットされる。
 */

export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/** 既定の1日の上限。プロジェクトごとに引き上げられていることがあるので、利用側の設定で上書きする前提の目安 */
export const DEFAULT_DAILY_QUOTA = Object.freeze({ combinedUnits: 10_000, searchCalls: 100 });

export type ApiMethod = 'search' | 'channels' | 'videos' | 'playlistItems';

/** combined 枠での1回あたりの units。search は別枠なのでここに無い */
export const COMBINED_UNIT_COST: Readonly<Record<Exclude<ApiMethod, 'search'>, number>> = Object.freeze({
  channels: 1,
  videos: 1,
  playlistItems: 1,
});

/** 1リクエストで指定できる ID の上限（channels.list / videos.list の id）と、1ページの最大件数 */
export const MAX_IDS_PER_REQUEST = 50;

// ---------------------------------------------------------------------------
// クォータの計測
// ---------------------------------------------------------------------------

/**
 * 実際に送ったリクエストの回数。対象数からの試算ではない（ページングや失敗を含めないと見積もりがずれるため）。
 *
 * **1つの処理の中の呼び出しカウンタで、プロセスをまたいだ上限ではない。**
 * 日次の上限を守るには、利用側がこの値を永続化し、同じキーを使う他の処理と合算して判定する。
 * Workers では同じ isolate で並ぶリクエストが混ざらないよう、処理ごとに作る。
 */
export interface QuotaMeter {
  /** combined 枠の units */
  units: number;
  /** search 枠の回数 */
  searchCalls: number;
  /** 送ったリクエストの総数（Workers ではサブリクエスト数でもある） */
  calls: number;
  /** そのうち失敗した数（失敗しても units / searchCalls には数えてある） */
  failed: number;
  /** メソッドごとの回数 */
  by: Partial<Record<ApiMethod, number>>;
}

export function createQuotaMeter(): QuotaMeter {
  return { units: 0, searchCalls: 0, calls: 0, failed: 0, by: {} };
}

/** クライアントを通さずに API を呼んだ箇所から、手で数えるための入口。 */
export function countCall(meter: QuotaMeter | undefined, method: ApiMethod): void {
  if (!meter) return;
  if (method === 'search') meter.searchCalls += 1;
  else meter.units += COMBINED_UNIT_COST[method];
  meter.calls += 1;
  meter.by[method] = (meter.by[method] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// 失敗
// ---------------------------------------------------------------------------

export type YouTubeErrorKind =
  | 'no-api-key'
  | 'quota-exceeded'
  | 'rate-limited'
  | 'forbidden'
  | 'not-found'
  | 'bad-request'
  | 'server'
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid-json';

/**
 * 呼び出し側が理由で分岐できる形の失敗。
 * メッセージにはメソッド名・状態コード・API が返した reason だけを入れ、API キーと本文は入れない
 * （キーはクエリ文字列に載るので、URL をエラーに含めない）。
 */
export class YouTubeApiError extends Error {
  readonly kind: YouTubeErrorKind;
  readonly method: ApiMethod;
  readonly status: number | undefined;
  readonly reason: string | undefined;

  constructor(method: ApiMethod, kind: YouTubeErrorKind, details: { status?: number; reason?: string } = {}) {
    const parts = [`YouTube API ${method}`, kind, details.status, details.reason].filter((part) => part !== undefined);
    super(parts.join(' '));
    this.name = 'YouTubeApiError';
    this.kind = kind;
    this.method = method;
    this.status = details.status;
    this.reason = details.reason;
  }
}

function classify(status: number, reason: string | undefined): YouTubeErrorKind {
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return 'quota-exceeded';
  if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') return 'rate-limited';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 400) return 'bad-request';
  if (status >= 500) return 'server';
  return 'http';
}

// ---------------------------------------------------------------------------
// 参照（URL / ハンドル / ID）の解釈
// ---------------------------------------------------------------------------

export type ChannelRef =
  | { kind: 'id'; value: string }
  | { kind: 'handle'; value: string }
  | { kind: 'username'; value: string }
  /** 動画の URL。その動画のチャンネルを引く（videos.list を1回余分に使う） */
  | { kind: 'video'; value: string };

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;

/**
 * チャンネルの指定として貼られうる文字列を解釈する。表示名だけでは解決できない（null）。
 * 表示名から search.list で探す経路は、別枠の検索回数を黙って使うので持たない。
 */
export function parseChannelRef(raw: unknown): ChannelRef | null {
  let s = String(raw ?? '').trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // 不正な % エンコードはそのまま扱う
  }
  if (!s) return null;
  if (CHANNEL_ID.test(s)) return { kind: 'id', value: s };
  if (s.startsWith('@')) {
    const handle = s.split(/[/?#\s]/)[0] ?? '';
    return handle.length > 1 ? { kind: 'handle', value: handle } : null;
  }

  const video = parseVideoRef(s, { allowBareId: false });
  const path = s.replace(/^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/?/i, '');
  if (path !== s) {
    const segments = path.split(/[/?#]/).filter(Boolean);
    const [first, second] = segments;
    if (first === 'channel' && second && CHANNEL_ID.test(second)) return { kind: 'id', value: second };
    if (first === 'user' && second) return { kind: 'username', value: second };
    if (first?.startsWith('@')) return { kind: 'handle', value: first };
    if (video) return { kind: 'video', value: video };
    // 旧カスタム URL（/c/xxx）は、ハンドルと同じ文字列であることが多いので、ハンドルとして引いてみる
    if (first === 'c' && second) return { kind: 'handle', value: `@${second}` };
    return null;
  }

  // 文章に紛れた ID・動画 URL・ハンドル
  const embeddedId = /(?:^|[^\w-])(UC[\w-]{22})(?![\w-])/.exec(s)?.[1];
  if (embeddedId) return { kind: 'id', value: embeddedId };
  if (video) return { kind: 'video', value: video };
  const handle = /@([\w.-]+)/.exec(s)?.[1];
  if (handle) return { kind: 'handle', value: `@${handle}` };
  return null;
}

/** 動画の URL（watch?v= / youtu.be / shorts / live / embed）または動画 ID から videoId を取り出す。 */
export function parseVideoRef(raw: unknown, options: { allowBareId?: boolean } = {}): string | null {
  const s = String(raw ?? '').trim();
  if ((options.allowBareId ?? true) && VIDEO_ID.test(s)) return s;
  const match =
    /[?&]v=([\w-]{11})(?![\w-])/.exec(s) ??
    /youtu\.be\/([\w-]{11})(?![\w-])/.exec(s) ??
    /\/(?:shorts|live|embed|v)\/([\w-]{11})(?![\w-])/.exec(s);
  return match?.[1] ?? null;
}

/** ISO 8601 の再生時間（PT1M30S、P1DT2H）を秒にする。読めなければ null。 */
export function parseIsoDuration(iso: unknown): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso ?? ''));
  if (!match || iso === 'P' || iso === 'PT') return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((v) => (v ? Number(v) : 0)) as [number, number, number, number];
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/** Shorts の尺の上限（秒）。API に Shorts かどうかのフラグは無いので、尺で推定する */
export const SHORT_MAX_SECONDS = 180;

/**
 * 尺が 0 秒の動画。配信中・配信予定のライブや 24 時間配信は contentDetails.duration が P0D で返る。
 * 尺が短いわけではないので、Shorts とも通常動画とも別に扱う
 */
export function isLiveByDuration(seconds: number | null): boolean {
  return seconds === 0;
}

/** 0 秒（ライブ）は Shorts に含めない。尺が読めないときも false */
export function isShortByDuration(seconds: number | null): boolean {
  return seconds !== null && seconds > 0 && seconds <= SHORT_MAX_SECONDS;
}

export type VideoFormat = 'short' | 'long' | 'live' | 'unknown';

/** 尺から形式を推定する。中央値を形式ごとに分けて取るとき、live と unknown をどちらにも混ぜないために使う */
export function videoFormatByDuration(seconds: number | null): VideoFormat {
  if (seconds === null) return 'unknown';
  if (isLiveByDuration(seconds)) return 'live';
  return isShortByDuration(seconds) ? 'short' : 'long';
}

export function chunk<T>(items: readonly T[], size = MAX_IDS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// クライアント
// ---------------------------------------------------------------------------

export interface Channel {
  channelId: string;
  title: string;
  /** snippet.customUrl（`@handle`）。無ければ null */
  handle: string | null;
  description: string;
  country: string | null;
  /** snippet.publishedAt（ISO 8601）。無ければ空文字 */
  publishedAt: string;
  subscribers: number | null;
  hiddenSubscriberCount: boolean;
  views: number | null;
  videoCount: number | null;
  uploadsPlaylistId: string | null;
}

export interface Video {
  videoId: string;
  channelId: string | null;
  channelTitle: string;
  title: string;
  description: string;
  tags: string[];
  /** snippet.publishedAt（ISO 8601）。無ければ空文字 */
  publishedAt: string;
  durationSeconds: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface SearchHit {
  videoId: string;
  channelId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
}

export interface SearchParams {
  q: string;
  order?: 'date' | 'rating' | 'relevance' | 'title' | 'videoCount' | 'viewCount';
  publishedAfter?: string;
  maxResults?: number;
  regionCode?: string;
  relevanceLanguage?: string;
  /** any | short（4分未満）| medium（4〜20分）| long（20分超） */
  videoDuration?: 'any' | 'short' | 'medium' | 'long';
}

export interface YouTubeClientOptions {
  apiKey: string | undefined;
  /** 渡すと、送ったリクエストを数える（失敗を含む） */
  meter?: QuotaMeter;
  /** 1リクエストの上限。既定 30 秒 */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {});
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asItems = (json: Json): Json[] => (Array.isArray(json.items) ? json.items.map(asRecord) : []);
const toNumber = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function createYouTubeClient(options: YouTubeClientOptions) {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(method: ApiMethod, params: Record<string, string | number | undefined>): Promise<Json> {
    if (!options.apiKey) throw new YouTubeApiError(method, 'no-api-key');
    const url = new URL(`${YOUTUBE_API_BASE}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('key', options.apiKey);

    // 送る前に数える。無効なリクエストでも最低 1 unit を消費するため
    countCall(options.meter, method);
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await request(url.toString(), { signal });
      text = await response.text();
    } catch (error) {
      if (options.meter) options.meter.failed += 1;
      const timedOut = signal.aborted || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
      throw new YouTubeApiError(method, timedOut ? 'timeout' : 'network');
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      if (options.meter) options.meter.failed += 1;
      const error = asRecord(asRecord(body).error);
      const first = asRecord(Array.isArray(error.errors) ? error.errors[0] : undefined);
      const reason = asString(first.reason) ?? asString(error.status);
      throw new YouTubeApiError(method, classify(response.status, reason), { status: response.status, ...(reason ? { reason } : {}) });
    }
    if (body === undefined) {
      if (options.meter) options.meter.failed += 1;
      throw new YouTubeApiError(method, 'invalid-json', { status: response.status });
    }
    return asRecord(body);
  }

  function toChannel(item: Json): Channel {
    const snippet = asRecord(item.snippet);
    const statistics = asRecord(item.statistics);
    return {
      channelId: asString(item.id) ?? '',
      title: asString(snippet.title) ?? '',
      handle: asString(snippet.customUrl) ?? null,
      description: asString(snippet.description) ?? '',
      country: asString(snippet.country) ?? null,
      publishedAt: asString(snippet.publishedAt) ?? '',
      subscribers: toNumber(statistics.subscriberCount),
      hiddenSubscriberCount: statistics.hiddenSubscriberCount === true,
      views: toNumber(statistics.viewCount),
      videoCount: toNumber(statistics.videoCount),
      uploadsPlaylistId: asString(asRecord(asRecord(item.contentDetails).relatedPlaylists).uploads) ?? null,
    };
  }

  const CHANNEL_PARTS = 'snippet,statistics,contentDetails';

  return {
    /** ID を指定してチャンネルを取得する。重複を除いて50件ずつに分ける。返る順は保証しない（見つからない ID は含まれない） */
    async channels(ids: readonly string[]): Promise<Channel[]> {
      const out: Channel[] = [];
      for (const group of chunk([...new Set(ids)])) {
        const json = await call('channels', { part: CHANNEL_PARTS, id: group.join(','), maxResults: MAX_IDS_PER_REQUEST });
        out.push(...asItems(json).map(toChannel));
      }
      return out;
    },

    /** 参照からチャンネルを1件引く。見つからなければ null。動画の参照は videos.list も使う（計2回） */
    async channelByRef(ref: ChannelRef): Promise<Channel | null> {
      let key: 'id' | 'forHandle' | 'forUsername';
      let value = ref.value;
      if (ref.kind === 'video') {
        const json = await call('videos', { part: 'snippet', id: ref.value });
        const channelId = asString(asRecord(asItems(json)[0]?.snippet).channelId);
        if (!channelId) return null;
        key = 'id';
        value = channelId;
      } else {
        key = ref.kind === 'id' ? 'id' : ref.kind === 'handle' ? 'forHandle' : 'forUsername';
      }
      const json = await call('channels', { part: CHANNEL_PARTS, [key]: value, maxResults: 1 });
      const item = asItems(json)[0];
      return item ? toChannel(item) : null;
    },

    /** 再生リスト（アップロード一覧など）の動画 ID を、先頭から limit 件まで。1ページ 1 unit */
    async playlistVideoIds(playlistId: string, limit = MAX_IDS_PER_REQUEST): Promise<{ ids: string[]; pages: number }> {
      const ids: string[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      while (ids.length < limit) {
        const json = await call('playlistItems', {
          part: 'contentDetails',
          playlistId,
          maxResults: Math.min(MAX_IDS_PER_REQUEST, limit - ids.length),
          pageToken,
        });
        pages += 1;
        for (const item of asItems(json)) {
          const id = asString(asRecord(item.contentDetails).videoId);
          if (id) ids.push(id);
        }
        pageToken = asString(json.nextPageToken);
        if (!pageToken) break;
      }
      return { ids: ids.slice(0, limit), pages };
    },

    /** 動画の詳細を取得する。重複を除いて50件ずつに分ける。返る順は保証しない */
    async videos(ids: readonly string[]): Promise<Video[]> {
      const out: Video[] = [];
      for (const group of chunk([...new Set(ids)])) {
        const json = await call('videos', { part: 'snippet,statistics,contentDetails', id: group.join(','), maxResults: MAX_IDS_PER_REQUEST });
        for (const item of asItems(json)) {
          const snippet = asRecord(item.snippet);
          const statistics = asRecord(item.statistics);
          out.push({
            videoId: asString(item.id) ?? '',
            channelId: asString(snippet.channelId) ?? null,
            channelTitle: asString(snippet.channelTitle) ?? '',
            title: asString(snippet.title) ?? '',
            description: asString(snippet.description) ?? '',
            tags: Array.isArray(snippet.tags) ? snippet.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            publishedAt: asString(snippet.publishedAt) ?? '',
            durationSeconds: parseIsoDuration(asRecord(item.contentDetails).duration),
            views: toNumber(statistics.viewCount),
            likes: toNumber(statistics.likeCount),
            comments: toNumber(statistics.commentCount),
          });
        }
      }
      return out;
    },

    /** 動画を検索する。search 枠を1回使う。動画 ID かチャンネル ID が無い結果は捨てる */
    async searchVideos(params: SearchParams): Promise<{ hits: SearchHit[]; totalResults: number | null }> {
      const json = await call('search', {
        part: 'snippet',
        type: 'video',
        q: params.q,
        order: params.order ?? 'relevance',
        publishedAfter: params.publishedAfter,
        maxResults: params.maxResults,
        regionCode: params.regionCode,
        relevanceLanguage: params.relevanceLanguage,
        videoDuration: params.videoDuration && params.videoDuration !== 'any' ? params.videoDuration : undefined,
      });
      const hits = asItems(json).flatMap((item): SearchHit[] => {
        const snippet = asRecord(item.snippet);
        const videoId = asString(asRecord(item.id).videoId);
        const channelId = asString(snippet.channelId);
        if (!videoId || !channelId) return [];
        return [{
          videoId,
          channelId,
          title: asString(snippet.title) ?? '',
          channelTitle: asString(snippet.channelTitle) ?? '',
          publishedAt: asString(snippet.publishedAt) ?? '',
        }];
      });
      return { hits, totalResults: toNumber(asRecord(json.pageInfo).totalResults) };
    },
  };
}

export type YouTubeClient = ReturnType<typeof createYouTubeClient>;
