import { describe, expect, it } from 'vitest';
import {
  chunk,
  createQuotaMeter,
  createYouTubeClient,
  isShortByDuration,
  parseChannelRef,
  parseIsoDuration,
  parseVideoRef,
  YouTubeApiError,
} from './index.js';

const KEY = 'AIza-test-key-not-real';
const UC = 'UC' + 'a'.repeat(22);

type Handler = (url: URL) => Response | Promise<Response>;

function fakeApi(handler: Handler) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { impl, urls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const googleError = (status: number, reason: string) =>
  json({ error: { code: status, message: `message that mentions ${KEY}`, errors: [{ reason, message: 'x' }] } }, status);

describe('parseChannelRef', () => {
  it.each([
    [UC, { kind: 'id', value: UC }],
    [`https://www.youtube.com/channel/${UC}`, { kind: 'id', value: UC }],
    ['@example.handle', { kind: 'handle', value: '@example.handle' }],
    ['https://www.youtube.com/@example/videos', { kind: 'handle', value: '@example' }],
    ['https://youtube.com/%40example', { kind: 'handle', value: '@example' }],
    ['https://www.youtube.com/user/legacyname', { kind: 'username', value: 'legacyname' }],
    ['https://www.youtube.com/c/customname', { kind: 'handle', value: '@customname' }],
    ['https://www.youtube.com/watch?v=abcdefghijk', { kind: 'video', value: 'abcdefghijk' }],
    ['https://youtu.be/abcdefghijk?t=3', { kind: 'video', value: 'abcdefghijk' }],
    ['https://m.youtube.com/shorts/abcdefghijk', { kind: 'video', value: 'abcdefghijk' }],
    [`このチャンネル ${UC} を見て`, { kind: 'id', value: UC }],
    ['メモ: @someone が良い', { kind: 'handle', value: '@someone' }],
  ])('%s', (input, expected) => {
    expect(parseChannelRef(input)).toEqual(expected);
  });

  it('表示名や空文字は解決しない（検索で探さない）', () => {
    expect(parseChannelRef('ただの表示名')).toBeNull();
    expect(parseChannelRef('')).toBeNull();
    expect(parseChannelRef('@')).toBeNull();
    expect(parseChannelRef('https://www.youtube.com/feed/trending')).toBeNull();
  });
});

describe('parseVideoRef / parseIsoDuration / chunk', () => {
  it('動画の参照', () => {
    expect(parseVideoRef('abcdefghijk')).toBe('abcdefghijk');
    expect(parseVideoRef('https://www.youtube.com/live/abcdefghijk')).toBe('abcdefghijk');
    expect(parseVideoRef('not a video')).toBeNull();
  });

  it('再生時間', () => {
    expect(parseIsoDuration('PT1M30S')).toBe(90);
    expect(parseIsoDuration('P1DT2H')).toBe(93_600);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('PT')).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(isShortByDuration(180)).toBe(true);
    expect(isShortByDuration(181)).toBe(false);
    expect(isShortByDuration(null)).toBe(false);
  });

  it('50件ずつに分ける', () => {
    expect(chunk(Array.from({ length: 101 }, (_, i) => i)).map((group) => group.length)).toEqual([50, 50, 1]);
  });
});

describe('createYouTubeClient', () => {
  it('ID を重複除去して50件ずつ取得し、combined 枠だけを数える', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `UC${String(i).padStart(22, '0')}`);
    const { impl, urls } = fakeApi((url) =>
      json({ items: url.searchParams.get('id')!.split(',').map((id) => ({ id, snippet: { title: 't' }, statistics: { subscriberCount: '10', hiddenSubscriberCount: false } })) }),
    );
    const meter = createQuotaMeter();
    const channels = await createYouTubeClient({ apiKey: KEY, meter, fetch: impl }).channels([...ids, ids[0]!]);
    expect(channels).toHaveLength(51);
    expect(channels[0]).toMatchObject({ subscribers: 10, views: null, handle: null, uploadsPlaylistId: null });
    expect(urls.map((url) => url.searchParams.get('id')!.split(',').length)).toEqual([50, 1]);
    expect(meter).toEqual({ units: 2, searchCalls: 0, calls: 2, failed: 0, by: { channels: 2 } });
  });

  it('再生リストを limit まで、ページごとに1回ずつ数えて読む', async () => {
    const pages: Record<string, unknown> = {
      '': { items: Array.from({ length: 50 }, (_, i) => ({ contentDetails: { videoId: `v${i}` } })), nextPageToken: 'p2' },
      p2: { items: Array.from({ length: 50 }, (_, i) => ({ contentDetails: { videoId: `w${i}` } })), nextPageToken: 'p3' },
    };
    const { impl, urls } = fakeApi((url) => json(pages[url.searchParams.get('pageToken') ?? '']));
    const meter = createQuotaMeter();
    const result = await createYouTubeClient({ apiKey: KEY, meter, fetch: impl }).playlistVideoIds('UUx', 70);
    expect(result.ids).toHaveLength(70);
    expect(result.pages).toBe(2);
    expect(urls.map((url) => url.searchParams.get('maxResults'))).toEqual(['50', '20']);
    expect(meter.by).toEqual({ playlistItems: 2 });
  });

  it('検索は search 枠で数え、units と混ぜない。totalResults を返す', async () => {
    const { impl } = fakeApi(() =>
      json({ pageInfo: { totalResults: 1234 }, items: [{ id: { videoId: 'v1' }, snippet: { channelId: 'c1', title: 'x' } }, { id: { channelId: 'c2' }, snippet: {} }] }),
    );
    const meter = createQuotaMeter();
    const result = await createYouTubeClient({ apiKey: KEY, meter, fetch: impl }).searchVideos({ q: 'q', videoDuration: 'any' });
    expect(result).toEqual({ totalResults: 1234, hits: [{ videoId: 'v1', channelId: 'c1', title: 'x', channelTitle: '', publishedAt: '' }] });
    expect(meter).toEqual({ units: 0, searchCalls: 1, calls: 1, failed: 0, by: { search: 1 } });
  });

  it('動画の参照からチャンネルを引く（videos + channels の2回）', async () => {
    const { impl, urls } = fakeApi((url) =>
      url.pathname.endsWith('/videos')
        ? json({ items: [{ id: 'abcdefghijk', snippet: { channelId: UC } }] })
        : json({ items: [{ id: UC, snippet: { title: 'found', customUrl: '@found', publishedAt: '2020-01-02T03:04:05Z' } }] }),
    );
    const meter = createQuotaMeter();
    const channel = await createYouTubeClient({ apiKey: KEY, meter, fetch: impl }).channelByRef({ kind: 'video', value: 'abcdefghijk' });
    expect(channel).toMatchObject({ channelId: UC, handle: '@found', publishedAt: '2020-01-02T03:04:05Z' });
    expect(urls[1]?.searchParams.get('id')).toBe(UC);
    expect(meter.units).toBe(2);
  });

  it('見つからないハンドルは null', async () => {
    const { impl, urls } = fakeApi(() => json({ pageInfo: { totalResults: 0 } }));
    expect(await createYouTubeClient({ apiKey: KEY, fetch: impl }).channelByRef({ kind: 'handle', value: '@none' })).toBeNull();
    expect(urls[0]?.searchParams.get('forHandle')).toBe('@none');
  });

  it.each([
    [403, 'quotaExceeded', 'quota-exceeded'],
    [403, 'rateLimitExceeded', 'rate-limited'],
    [403, 'forbidden', 'forbidden'],
    [404, 'playlistNotFound', 'not-found'],
    [400, 'badRequest', 'bad-request'],
    [503, 'backendError', 'server'],
  ])('%s %s を %s に分類し、失敗も数える。キーや本文をエラーに入れない', async (status, reason, kind) => {
    const { impl } = fakeApi(() => googleError(status, reason));
    const meter = createQuotaMeter();
    const error = await createYouTubeClient({ apiKey: KEY, meter, fetch: impl }).videos(["v1"]).then(() => { throw new Error("expected failure"); }, (e: unknown) => e as YouTubeApiError);
    expect(error).toBeInstanceOf(YouTubeApiError);
    expect(error).toMatchObject({ kind, status, reason, method: 'videos' });
    expect(`${error.message} ${error.stack}`).not.toContain(KEY);
    expect(meter).toMatchObject({ units: 1, calls: 1, failed: 1 });
  });

  it('ページングの途中で失敗しても、それまでのページと失敗した1回を数える', async () => {
    let n = 0;
    const { impl } = fakeApi(() => (++n === 1 ? json({ items: [{ contentDetails: { videoId: 'v' } }], nextPageToken: 'p2' }) : googleError(500, 'backendError')));
    const meter = createQuotaMeter();
    await expect(createYouTubeClient({ apiKey: KEY, meter, fetch: impl }).playlistVideoIds('UUx', 100)).rejects.toMatchObject({ kind: 'server' });
    expect(meter).toMatchObject({ units: 2, calls: 2, failed: 1 });
  });

  it('送れなかった・時間切れも失敗として数える', async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    const meter = createQuotaMeter();
    await expect(createYouTubeClient({ apiKey: KEY, meter, fetch: hanging, timeoutMs: 10 }).channels([UC])).rejects.toMatchObject({ kind: 'timeout' });
    const broken = (async () => {
      throw new TypeError(`request to https://www.googleapis.com/youtube/v3/videos?key=${KEY} failed`);
    }) as typeof fetch;
    const error = await createYouTubeClient({ apiKey: KEY, meter, fetch: broken }).videos(["v"]).then(() => { throw new Error("expected failure"); }, (e: unknown) => e as Error);
    expect(error).toMatchObject({ kind: 'network' });
    expect(error.message).not.toContain(KEY);
    expect(meter).toMatchObject({ units: 2, calls: 2, failed: 2 });
  });

  it('API キーが無ければ送らず、数えない', async () => {
    const { impl, urls } = fakeApi(() => json({}));
    const meter = createQuotaMeter();
    await expect(createYouTubeClient({ apiKey: '', meter, fetch: impl }).channels([UC])).rejects.toMatchObject({ kind: 'no-api-key' });
    expect(urls).toHaveLength(0);
    expect(meter.calls).toBe(0);
  });

  it('空の ID 一覧では呼ばない', async () => {
    const { impl, urls } = fakeApi(() => json({}));
    expect(await createYouTubeClient({ apiKey: KEY, fetch: impl }).videos([])).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
