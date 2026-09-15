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
export declare const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
/** 既定の1日の上限。プロジェクトごとに引き上げられていることがあるので、利用側の設定で上書きする前提の目安 */
export declare const DEFAULT_DAILY_QUOTA: Readonly<{
    combinedUnits: 10000;
    searchCalls: 100;
}>;
export type ApiMethod = 'search' | 'channels' | 'videos' | 'playlistItems';
/** combined 枠での1回あたりの units。search は別枠なのでここに無い */
export declare const COMBINED_UNIT_COST: Readonly<Record<Exclude<ApiMethod, 'search'>, number>>;
/** 1リクエストで指定できる ID の上限（channels.list / videos.list の id）と、1ページの最大件数 */
export declare const MAX_IDS_PER_REQUEST = 50;
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
export declare function createQuotaMeter(): QuotaMeter;
/** クライアントを通さずに API を呼んだ箇所から、手で数えるための入口。 */
export declare function countCall(meter: QuotaMeter | undefined, method: ApiMethod): void;
export type YouTubeErrorKind = 'no-api-key' | 'quota-exceeded' | 'rate-limited' | 'forbidden' | 'not-found' | 'bad-request' | 'server' | 'http' | 'timeout' | 'network' | 'invalid-json';
/**
 * 呼び出し側が理由で分岐できる形の失敗。
 * メッセージにはメソッド名・状態コード・API が返した reason だけを入れ、API キーと本文は入れない
 * （キーはクエリ文字列に載るので、URL をエラーに含めない）。
 */
export declare class YouTubeApiError extends Error {
    readonly kind: YouTubeErrorKind;
    readonly method: ApiMethod;
    readonly status: number | undefined;
    readonly reason: string | undefined;
    constructor(method: ApiMethod, kind: YouTubeErrorKind, details?: {
        status?: number;
        reason?: string;
    });
}
export type ChannelRef = {
    kind: 'id';
    value: string;
} | {
    kind: 'handle';
    value: string;
} | {
    kind: 'username';
    value: string;
}
/** 動画の URL。その動画のチャンネルを引く（videos.list を1回余分に使う） */
 | {
    kind: 'video';
    value: string;
};
/**
 * チャンネルの指定として貼られうる文字列を解釈する。表示名だけでは解決できない（null）。
 * 表示名から search.list で探す経路は、別枠の検索回数を黙って使うので持たない。
 */
export declare function parseChannelRef(raw: unknown): ChannelRef | null;
/** 動画の URL（watch?v= / youtu.be / shorts / live / embed）または動画 ID から videoId を取り出す。 */
export declare function parseVideoRef(raw: unknown, options?: {
    allowBareId?: boolean;
}): string | null;
/** ISO 8601 の再生時間（PT1M30S、P1DT2H）を秒にする。読めなければ null。 */
export declare function parseIsoDuration(iso: unknown): number | null;
/** Shorts の尺の上限（秒）。API に Shorts かどうかのフラグは無いので、尺で推定する */
export declare const SHORT_MAX_SECONDS = 180;
export declare function isShortByDuration(seconds: number | null): boolean;
export declare function chunk<T>(items: readonly T[], size?: number): T[][];
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
export declare const DEFAULT_TIMEOUT_MS = 30000;
export declare function createYouTubeClient(options: YouTubeClientOptions): {
    /** ID を指定してチャンネルを取得する。重複を除いて50件ずつに分ける。返る順は保証しない（見つからない ID は含まれない） */
    channels(ids: readonly string[]): Promise<Channel[]>;
    /** 参照からチャンネルを1件引く。見つからなければ null。動画の参照は videos.list も使う（計2回） */
    channelByRef(ref: ChannelRef): Promise<Channel | null>;
    /** 再生リスト（アップロード一覧など）の動画 ID を、先頭から limit 件まで。1ページ 1 unit */
    playlistVideoIds(playlistId: string, limit?: number): Promise<{
        ids: string[];
        pages: number;
    }>;
    /** 動画の詳細を取得する。重複を除いて50件ずつに分ける。返る順は保証しない */
    videos(ids: readonly string[]): Promise<Video[]>;
    /** 動画を検索する。search 枠を1回使う。動画 ID かチャンネル ID が無い結果は捨てる */
    searchVideos(params: SearchParams): Promise<{
        hits: SearchHit[];
        totalResults: number | null;
    }>;
};
export type YouTubeClient = ReturnType<typeof createYouTubeClient>;
