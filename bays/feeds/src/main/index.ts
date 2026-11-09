import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { BayContext, BayMain } from '@hangar/sdk';
import { Feeds, type FeedSettings, type ParsedFeed } from './feeds';
import { messages } from './messages';

const MAX_BYTES = 5 * 1024 * 1024;
const FeedUrl = z.url({ protocol: /^https?$/ }).max(4000);
// Agents must not reach the own machine or private networks through the host (SSRF). Only the
// literal host is checked; a public name that resolves inward or a redirect still passes (ADR 0040).
const inward = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  inward.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  inward.addSubnet(net, prefix, 'ipv6');
// BlockList checks IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules itself.
const isInward = (url: string) => {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const type = isIP(host);
  if (type) return inward.check(host, type === 4 ? 'ipv4' : 'ipv6');
  return host === 'localhost' || /\.(localhost|local|internal)$/.test(host);
};
const Add = z.object({
  url: FeedUrl.refine((url) => !isInward(url), 'local and private addresses are not allowed'),
});
const ItemsArgs = z.object({
  feedUrl: z.string().optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
// Parsed from remote content by the UI: bounded before it is stored and handed to agents.
const Parsed = z.object({
  title: z.string().max(500),
  items: z
    .array(
      z.object({
        id: z.string().max(4000),
        title: z.string().max(1000),
        link: z.string().max(4000),
        summary: z.string().max(2000),
        published: z.string().max(100).optional(),
      }),
    )
    .max(1000),
});

function parse<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`Invalid arguments: ${issue.path.join('.') || 'args'}: ${issue.message}`);
  }
  return result.data;
}

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>;

/** RSS and Atom subscriptions; their entries as one history. The UI fetches and parses. */
const bay: BayMain = {
  activate(ctx: BayContext) {
    const t = messages(ctx.locale);
    const feeds = new Feeds(join(ctx.dataDir, 'feeds.json'), (state) =>
      ctx.ui.send('state', state),
    );

    ctx.provide('feed.list', () => feeds.get().feeds, schema(z.object({})));
    ctx.provide('feed.add', (args) => feeds.add(parse(Add, args).url), schema(Add));
    ctx.provide(
      'feed.items',
      (args) => {
        const { feedUrl, since, limit = 50 } = parse(ItemsArgs, args);
        return feeds
          .get()
          .items.filter(
            (i) =>
              (!feedUrl || i.feedUrl === feedUrl) &&
              (!since || Date.parse(i.receivedAt) > Date.parse(since)),
          )
          .slice(-limit);
      },
      schema(ItemsArgs),
    );

    const ui = ctx.ui;
    ui.handle('state', () => feeds.get());
    // Bays cannot write Hangar settings, so the bay keeps its own (ADR 0040).
    ui.handle('settings', (input) => {
      const { intervalMinutes, maxItems } = (input ?? {}) as Record<string, unknown>;
      const whole = (n: unknown, min: number, max: number) =>
        Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
      if (!whole(intervalMinutes, 1, 1440)) throw new Error(t.interval);
      if (!whole(maxItems, 100, 10_000)) throw new Error(t.maxItems);
      feeds.configure({ intervalMinutes, maxItems } as FeedSettings);
    });
    ui.handle('add', (input) => {
      const url = FeedUrl.safeParse(String(input).trim());
      if (!url.success) throw new Error(t.invalidUrl);
      if (feeds.has(url.data)) throw new Error(t.exists);
      return feeds.add(url.data);
    });
    ui.handle('remove', (url) => feeds.remove(url as string));
    // Main fetches: a bay page may not read other origins (CORS).
    ui.handle('fetch', async (url) => {
      const res = await fetch(feeds.feed(url as string).url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Read in pieces: a feed must not fill the memory of the host.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('Feed too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    });
    ui.handle('ingest', (url, parsed) =>
      feeds.ingest(url as string, parse(Parsed, parsed) as ParsedFeed),
    );
    ui.handle('failed', (url, message) =>
      feeds.failed(url as string, String(message).slice(0, 500)),
    );
  },
};

export default bay;
