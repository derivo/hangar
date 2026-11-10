import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** A subscribed feed; `title` is the URL until the first fetch names it. */
export interface Feed {
  url: string;
  title: string;
  fetchedAt?: string;
  /** Message of the last failed fetch, gone after the next success. */
  error?: string;
}

/** An entry as the UI parsed it from the feed. */
export interface ParsedItem {
  id: string;
  title: string;
  link: string;
  summary: string;
  published?: string;
}

export interface ParsedFeed {
  title: string;
  items: ParsedItem[];
}

/** An entry in the history, in the order it arrived. */
export interface Item extends ParsedItem {
  feedUrl: string;
  feedTitle: string;
  receivedAt: string;
}

/** Set by the person in the bay's settings dialog (ADR 0040). */
export interface FeedSettings {
  intervalMinutes: number;
  maxItems: number;
}

export interface FeedState {
  feeds: Feed[];
  items: Item[];
  settings: FeedSettings;
}

const DEFAULTS: FeedSettings = { intervalMinutes: 15, maxItems: 1000 };

/** Subscriptions and history in `feeds.json`; every change is written at once. */
export class Feeds {
  private state: FeedState;
  /** Ids each feed listed last time: entries that dropped out of the history stay out. */
  private seen: Record<string, string[]>;

  constructor(
    private readonly file: string,
    private readonly changed: (state: FeedState) => void,
    private readonly now = () => new Date().toISOString(),
  ) {
    const saved = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as FeedState & { seen?: Record<string, string[]> })
      : undefined;
    this.state = {
      feeds: saved?.feeds ?? [],
      items: saved?.items ?? [],
      settings: { ...DEFAULTS, ...saved?.settings },
    };
    this.seen = saved?.seen ?? {};
  }

  get(): FeedState {
    return this.state;
  }

  has(url: string): boolean {
    return this.state.feeds.some((f) => f.url === url);
  }

  feed(url: string): Feed {
    const feed = this.state.feeds.find((f) => f.url === url);
    if (!feed) throw new Error('Unknown feed');
    return feed;
  }

  add(url: string): Feed {
    if (this.has(url)) throw new Error('Feed already exists');
    const feed: Feed = { url, title: url };
    this.state.feeds.push(feed);
    this.write();
    return feed;
  }

  remove(url: string): void {
    this.state.feeds = this.state.feeds.filter((f) => f.url !== url);
    this.state.items = this.state.items.filter((i) => i.feedUrl !== url);
    delete this.seen[url];
    this.write();
  }

  /** Appends the entries not seen yet, oldest first; returns them. */
  ingest(url: string, parsed: ParsedFeed): Item[] {
    const feed = this.feed(url);
    if (parsed.title) feed.title = parsed.title;
    feed.fetchedAt = this.now();
    delete feed.error;
    const known = new Set([
      ...(this.seen[url] ?? []),
      ...this.state.items.filter((i) => i.feedUrl === url).map((i) => i.id),
    ]);
    this.seen[url] = parsed.items.map((i) => i.id);
    const fresh = parsed.items
      .filter((i) => !known.has(i.id))
      // Feeds list the newest first; without a date that order counts.
      .reverse()
      .sort((a, b) => (a.published ?? '').localeCompare(b.published ?? ''))
      .map((i) => ({ ...i, feedUrl: url, feedTitle: feed.title, receivedAt: feed.fetchedAt! }));
    this.state.items = [...this.state.items, ...fresh].slice(-this.state.settings.maxItems);
    this.write();
    return fresh;
  }

  /** Stores the settings; a smaller history drops its oldest entries at once. */
  configure(settings: FeedSettings): void {
    this.state.settings = settings;
    this.state.items = this.state.items.slice(-settings.maxItems);
    this.write();
  }

  failed(url: string, message: string): void {
    const feed = this.feed(url);
    feed.fetchedAt = this.now();
    feed.error = message;
    this.write();
  }

  private write(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...this.state, seen: this.seen }, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    this.changed(this.state);
  }
}
