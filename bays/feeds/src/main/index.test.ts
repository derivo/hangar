import { afterEach, describe, expect, it, vi } from 'vitest';
import bay from './index';
import type { Feed, FeedState, Item } from './feeds';
import { fakeContext } from './test-ctx';

const URL_A = 'https://example.org/a.xml';
const URL_B = 'https://example.org/b.xml';

const parsed = (ids: string[], title = 'Blog A') => ({
  title,
  items: ids.map((id, i) => ({
    id,
    title: `Post ${id}`,
    link: `https://example.org/${id}`,
    summary: `Text ${id}`,
    // Newest first, as feeds list them.
    published: `2026-11-0${ids.length - i}T10:00:00.000Z`,
  })),
});

function start() {
  const f = fakeContext();
  bay.activate(f.ctx);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe('feeds bay', () => {
  it('subscribes, ingests new items oldest first and skips known ones', async () => {
    const { invoke, ctx } = start();
    await invoke('add', URL_A);
    // A feed lists the newest entry first; the history shows it last.
    const first = (await invoke('ingest', URL_A, parsed(['2', '1']))) as Item[];
    expect(first.map((i) => i.id)).toEqual(['1', '2']);
    const again = (await invoke('ingest', URL_A, parsed(['3', '2', '1']))) as Item[];
    expect(again.map((i) => i.id)).toEqual(['3']);

    const state = (await invoke('state')) as FeedState;
    expect(state.items.map((i) => i.title)).toEqual(['Post 1', 'Post 2', 'Post 3']);
    expect(state.items[0]).toMatchObject({ feedUrl: URL_A, feedTitle: 'Blog A' });
    expect(state.feeds).toEqual([
      expect.objectContaining({ url: URL_A, title: 'Blog A', fetchedAt: expect.any(String) }),
    ]);
    expect(ctx.ui.send).toHaveBeenLastCalledWith('state', state);
  });

  it('keeps its state across restarts', async () => {
    const { invoke, dataDir } = start();
    await invoke('add', URL_A);
    await invoke('ingest', URL_A, parsed(['1']));
    const next = fakeContext(dataDir);
    bay.activate(next.ctx);
    const state = (await next.invoke('state')) as FeedState;
    expect(state.feeds).toHaveLength(1);
    expect(state.items).toHaveLength(1);
  });

  it('rejects invalid and duplicate URLs with readable messages', async () => {
    const { invoke } = start();
    await expect(invoke('add', 'ftp://example.org/x')).rejects.toThrow('Ungültige Feed-URL');
    await expect(invoke('add', 'kein link')).rejects.toThrow('Ungültige Feed-URL');
    await invoke('add', ` ${URL_A} `);
    await expect(invoke('add', URL_A)).rejects.toThrow('Feed ist schon abonniert');
  });

  it('removes a feed together with its items', async () => {
    const { invoke } = start();
    await invoke('add', URL_A);
    await invoke('add', URL_B);
    await invoke('ingest', URL_A, parsed(['1']));
    await invoke('ingest', URL_B, parsed(['x'], 'Blog B'));
    await invoke('remove', URL_A);
    const state = (await invoke('state')) as FeedState;
    expect(state.feeds.map((f) => f.url)).toEqual([URL_B]);
    expect(state.items.map((i) => i.feedTitle)).toEqual(['Blog B']);
  });

  it('records a failed fetch and clears it on the next success', async () => {
    const { invoke } = start();
    await invoke('add', URL_A);
    await invoke('failed', URL_A, 'HTTP 404');
    expect(((await invoke('state')) as FeedState).feeds[0]!.error).toBe('HTTP 404');
    await invoke('ingest', URL_A, parsed(['1']));
    expect(((await invoke('state')) as FeedState).feeds[0]!.error).toBeUndefined();
  });

  it('keeps the feed title when the feed names none', async () => {
    const { invoke } = start();
    await invoke('add', URL_A);
    await invoke('ingest', URL_A, parsed(['1'], ''));
    const [feed] = ((await invoke('state')) as FeedState).feeds as [Feed];
    expect(feed.title).toBe(URL_A);
  });

  it('rejects items for an unknown feed', async () => {
    const { invoke } = start();
    await expect(invoke('ingest', URL_A, parsed(['1']))).rejects.toThrow('Unknown feed');
    await expect(invoke('failed', URL_A, 'x')).rejects.toThrow('Unknown feed');
    await expect(invoke('fetch', URL_A)).rejects.toThrow('Unknown feed');
  });

  it('keeps only the newest items once the history is full', async () => {
    const { invoke } = start();
    await invoke('add', URL_A);
    // Newest first and undated: the feed order counts. Two fetches, one feed holds at most 1000.
    const batch = (from: number, to: number) => ({
      title: 'A',
      items: Array.from({ length: to - from + 1 }, (_, i) => String(to - i)).map((id) => ({
        ...parsed([id]).items[0]!,
        published: undefined,
      })),
    });
    await invoke('ingest', URL_A, batch(1, 600));
    await invoke('ingest', URL_A, batch(601, 1001));
    const { items } = (await invoke('state')) as FeedState;
    expect(items).toHaveLength(1000);
    expect(items[0]!.id).toBe('2');
    expect(items.at(-1)!.id).toBe('1001');
  });

  it('fetches the text of a subscribed feed and reports HTTP errors', async () => {
    const fetch = vi.fn(async () => new Response('<rss/>', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { invoke } = start();
    await invoke('add', URL_A);
    expect(await invoke('fetch', URL_A)).toBe('<rss/>');
    expect(fetch).toHaveBeenCalledWith(
      URL_A,
      expect.objectContaining({ signal: expect.anything() }),
    );
    fetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(invoke('fetch', URL_A)).rejects.toThrow('HTTP 404');
  });

  it('does not bring back entries that dropped out of the history while the feed lists them', async () => {
    const { invoke } = start();
    await invoke('add', URL_A);
    await invoke('add', URL_B);
    const many = (prefix: string) => ({
      title: prefix,
      items: Array.from({ length: 600 }, (_, i) => ({
        id: `${prefix}${i}`,
        title: `${prefix}${i}`,
        link: '',
        summary: '',
      })),
    });
    await invoke('ingest', URL_A, many('a'));
    await invoke('ingest', URL_B, many('b'));
    expect(await invoke('ingest', URL_A, many('a'))).toEqual([]);
  });

  it('stops reading a feed larger than 5 MB', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(5 * 1024 * 1024 + 1), { status: 200 })),
    );
    const { invoke } = start();
    await invoke('add', URL_A);
    await expect(invoke('fetch', URL_A)).rejects.toThrow('Feed too large');
  });

  describe('settings', () => {
    it('start with 15 minutes and 1000 entries and survive a restart', async () => {
      const { invoke, dataDir } = start();
      expect(((await invoke('state')) as FeedState).settings).toEqual({
        intervalMinutes: 15,
        maxItems: 1000,
      });
      await invoke('settings', { intervalMinutes: 5, maxItems: 200 });
      const next = fakeContext(dataDir);
      bay.activate(next.ctx);
      expect(((await next.invoke('state')) as FeedState).settings).toEqual({
        intervalMinutes: 5,
        maxItems: 200,
      });
    });

    it('a smaller history drops the oldest entries at once', async () => {
      const { invoke, ctx } = start();
      await invoke('add', URL_A);
      // Newest first and undated, so the feed order counts.
      const ids = Array.from({ length: 200 }, (_, i) => String(200 - i));
      const undated = parsed(ids).items.map((i) => ({ ...i, published: undefined }));
      await invoke('ingest', URL_A, { title: 'A', items: undated });
      await invoke('settings', { intervalMinutes: 15, maxItems: 150 });
      const state = (await invoke('state')) as FeedState;
      expect(state.items).toHaveLength(150);
      expect(state.items[0]!.id).toBe('51');
      expect(ctx.ui.send).toHaveBeenLastCalledWith('state', state);
    });

    it('rejects values out of range with readable messages, the limits pass', async () => {
      const { invoke } = start();
      const set = (intervalMinutes: unknown, maxItems: unknown) =>
        invoke('settings', { intervalMinutes, maxItems });
      for (const bad of [0, 1441, 2.5, 'oft'])
        await expect(set(bad, 1000), String(bad)).rejects.toThrow(
          'Abruf-Intervall: ganze Zahl von 1 bis 1440 Minuten',
        );
      for (const bad of [99, 10_001, 150.5, null])
        await expect(set(15, bad), String(bad)).rejects.toThrow(
          'Verlauf: ganze Zahl von 100 bis 10000 Einträgen',
        );
      await set(1, 100);
      await set(1440, 10_000);
      expect(((await invoke('state')) as FeedState).settings).toEqual({
        intervalMinutes: 1440,
        maxItems: 10_000,
      });
    });
  });

  describe('functions for agents', () => {
    it('feed.add and feed.list share the subscriptions with the UI', async () => {
      const { call, invoke } = start();
      await call('feed.add', { url: URL_A });
      expect(await call('feed.list')).toEqual([expect.objectContaining({ url: URL_A })]);
      await expect(call('feed.add', { url: URL_A })).rejects.toThrow('Feed already exists');
      await expect(call('feed.add', { url: 'file:///etc/passwd' })).rejects.toThrow(
        'Invalid arguments: url',
      );
      expect(((await invoke('state')) as FeedState).feeds).toHaveLength(1);
    });

    it('feed.add keeps agents away from the own machine and private networks', async () => {
      const { call, invoke } = start();
      for (const url of [
        'http://localhost:3000/feed',
        'http://api.localhost/feed',
        'http://printer.local/feed',
        'http://127.0.0.1/feed',
        'http://2130706433/feed', // 127.0.0.1 as a number
        'http://10.1.2.3/feed',
        'http://172.20.0.1/feed',
        'http://192.168.1.1/feed',
        'http://169.254.169.254/latest/meta-data',
        'http://100.64.0.1/feed',
        'http://0.0.0.0/feed',
        'http://[::1]/feed',
        'http://[fd00::1]/feed',
        'http://[fe80::1]/feed',
        'http://[::ffff:127.0.0.1]/feed',
      ]) {
        await expect(call('feed.add', { url }), url).rejects.toThrow(
          'Invalid arguments: url: local and private addresses are not allowed',
        );
      }
      await call('feed.add', { url: 'https://172.32.0.1/feed' });
      // The person may subscribe to a local feed in the UI.
      await invoke('add', 'http://localhost:3000/feed');
    });

    it('feed.items returns the newest items, filtered by feed and time', async () => {
      const { call, invoke } = start();
      await invoke('add', URL_A);
      await invoke('add', URL_B);
      await invoke('ingest', URL_A, parsed(['2', '1']));
      await invoke('ingest', URL_B, parsed(['x'], 'Blog B'));
      const all = (await call('feed.items')) as Item[];
      expect(all.map((i) => i.id)).toEqual(['1', '2', 'x']);
      expect(((await call('feed.items', { limit: 1 })) as Item[]).map((i) => i.id)).toEqual(['x']);
      expect(((await call('feed.items', { feedUrl: URL_A })) as Item[]).map((i) => i.id)).toEqual([
        '1',
        '2',
      ]);
      const since = all.at(-1)!.receivedAt;
      expect(await call('feed.items', { since })).toEqual([]);
      // The same instant one hour east: still nothing newer; an hour earlier: everything.
      const at = new Date(since);
      const east = new Date(at.getTime() + 3600_000).toISOString().replace('Z', '+01:00');
      expect(await call('feed.items', { since: east })).toEqual([]);
      const before = new Date(at.getTime() - 1000).toISOString().replace('Z', '+00:00');
      expect(await call('feed.items', { since: before })).toHaveLength(3);
      await expect(call('feed.items', { since: 'gestern' })).rejects.toThrow(
        'Invalid arguments: since',
      );
      await expect(call('feed.items', { limit: 0 })).rejects.toThrow('Invalid arguments: limit');
    });
  });
});
