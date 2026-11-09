import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BayBrowser, BayContext, BayMain, BrowserTab, CallInfo } from '@hangar/sdk';
import { normalizeUrl } from './url';
import type { BrowserState } from './types';

/** The person's tabs: one persistent partition, restored after a restart (ADR 0015). */
const USER = 'user';
const MAX_TEXT = 100_000;

const Url = z.string().max(4000);
const Id = z.string().max(100);
const OpenArgs = z.object({ url: Url });
const NavigateArgs = z.object({ id: Id, url: Url });
const TabArgs = z.object({ id: Id });
const ClickArgs = z.object({ id: Id, selector: z.string().min(1).max(1000) });
const FillArgs = ClickArgs.extend({ value: z.string().max(100_000) });

function parse<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`Invalid arguments: ${issue.path.join('.') || 'args'}: ${issue.message}`);
  }
  return result.data;
}

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>;

function urlOf(input: string): string {
  const url = normalizeUrl(input);
  if (!url) throw new Error(`Only http and https addresses can be opened: ${input}`);
  return url;
}

/** Each agent session (and each calling bay) has its own partition and reaches only its tabs. */
const sessionPartition = (s: { bayId: string; sessionId: string }) =>
  `session-${s.bayId}-${s.sessionId}`;
/** Callers of the local server are named like their subject (ADR 0036), apart from this app's. */
const partitionOf = ({ caller }: CallInfo) => {
  const bayId = caller.kind === 'local-server' ? `local-server:${caller.bayId}` : caller.bayId;
  return (caller.kind === 'session' || caller.kind === 'local-server') && caller.sessionId
    ? sessionPartition({ bayId, sessionId: caller.sessionId })
    : `bay-${bayId}`;
};

const clickScript = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`;

// Sets the value like typing does, so frameworks that listen to input events see it.
const fillScript = (selector: string, value: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.focus();
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, ${JSON.stringify(value)});
  else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

class BrowserBay {
  /** Last known URL per user tab; a tab still loading has none yet. */
  private readonly userUrls = new Map<string, string>();
  private readonly file: string;

  constructor(
    ctx: BayContext,
    private readonly browser: BayBrowser,
  ) {
    this.file = join(ctx.dataDir, 'tabs.json');
    browser.onChange((tabs) => {
      this.save(tabs);
      ctx.ui.send('state', this.state(tabs));
    });
  }

  restore(): void {
    let urls: string[] = [];
    try {
      urls = (JSON.parse(readFileSync(this.file, 'utf8')) as { tabs: string[] }).tabs;
    } catch {
      // No tabs yet, or an unreadable file: start empty.
    }
    for (const url of urls) void this.browser.open(url, { partition: USER, persist: true });
  }

  state(tabs = this.browser.list()): BrowserState {
    return {
      tabs: tabs.map((t) => ({ ...t, owner: t.partition === USER ? 'user' : 'agent' })),
    };
  }

  openForUser(input: string) {
    return this.browser.open(urlOf(input), { partition: USER, persist: true });
  }

  navigate(id: string, input: string) {
    return this.browser.navigate(id, urlOf(input));
  }

  async open(input: string, info: CallInfo): Promise<BrowserTab> {
    const id = await this.browser.open(urlOf(input), { partition: partitionOf(info) });
    return this.tab(id, info);
  }

  /** A tab of the caller's partition; any other is unknown to it. */
  tab(id: string, info: CallInfo): BrowserTab {
    const tab = this.own(info).find((t) => t.id === id);
    if (!tab) throw new Error(`Unknown tab "${id}"`);
    return tab;
  }

  own(info: CallInfo): BrowserTab[] {
    const partition = partitionOf(info);
    return this.browser.list().filter((t) => t.partition === partition);
  }

  /** Writes the user tabs once each has a URL, so a restore in progress does not lose any. */
  private save(tabs: BrowserTab[]): void {
    const user = tabs.filter((t) => t.partition === USER);
    for (const id of this.userUrls.keys()) {
      if (!user.some((t) => t.id === id)) this.userUrls.delete(id);
    }
    for (const t of user) if (t.url) this.userUrls.set(t.id, t.url);
    if (user.some((t) => !this.userUrls.has(t.id))) return;
    writeFileSync(this.file, JSON.stringify({ tabs: user.map((t) => this.userUrls.get(t.id)) }));
  }
}

function provideFunctions(ctx: BayContext, bay: BrowserBay, browser: BayBrowser): void {
  const evaluate = async (id: string, info: CallInfo, script: string) => {
    bay.tab(id, info);
    return browser.evaluate(id, script);
  };
  ctx.provide(
    'tab.open',
    (args, info) => bay.open(parse(OpenArgs, args).url, info),
    schema(OpenArgs),
  );
  ctx.provide(
    'tab.navigate',
    async (args, info) => {
      const { id, url } = parse(NavigateArgs, args);
      bay.tab(id, info);
      await bay.navigate(id, url);
      return bay.tab(id, info);
    },
    schema(NavigateArgs),
  );
  ctx.provide('tab.list', (_args, info) => bay.own(info), schema(z.object({})));
  ctx.provide(
    'tab.close',
    (args, info) => {
      const { id } = parse(TabArgs, args);
      bay.tab(id, info);
      browser.close(id);
      return { ok: true };
    },
    schema(TabArgs),
  );
  ctx.provide(
    'page.text',
    async (args, info) => {
      const { id } = parse(TabArgs, args);
      const text = String(await evaluate(id, info, 'document.body ? document.body.innerText : ""'));
      return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
    },
    schema(TabArgs),
  );
  ctx.provide(
    'page.click',
    async (args, info) => {
      const { id, selector } = parse(ClickArgs, args);
      if (!(await evaluate(id, info, clickScript(selector))))
        throw new Error(`No element matches "${selector}"`);
      return { ok: true };
    },
    schema(ClickArgs),
  );
  ctx.provide(
    'page.fill',
    async (args, info) => {
      const { id, selector, value } = parse(FillArgs, args);
      if (!(await evaluate(id, info, fillScript(selector, value))))
        throw new Error(`No element matches "${selector}"`);
      return { ok: true };
    },
    schema(FillArgs),
  );
  ctx.provide(
    'page.screenshot',
    async (args, info) => {
      const { id } = parse(TabArgs, args);
      bay.tab(id, info);
      const dir = join(ctx.dataDir, 'screenshots');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${id}-${Date.now()}.png`);
      writeFileSync(path, await browser.screenshot(id));
      return { path };
    },
    schema(TabArgs),
  );
}

const bay: BayMain = {
  activate(ctx) {
    const browser = ctx.browser;
    if (!browser) throw new Error('manifest.json needs "hostModules": ["browser"]');
    const browserBay = new BrowserBay(ctx, browser);
    provideFunctions(ctx, browserBay, browser);
    const ui = ctx.ui;
    ui.handle('state', () => browserBay.state());
    ui.handle('tab.open', (url) => browserBay.openForUser(url as string));
    ui.handle('tab.navigate', (id, url) => browserBay.navigate(id as string, url as string));
    ui.handle('tab.back', (id) => browser.back(id as string));
    ui.handle('tab.forward', (id) => browser.forward(id as string));
    ui.handle('tab.reload', (id) => browser.reload(id as string));
    ui.handle('tab.resetZoom', (id) => browser.resetZoom(id as string));
    ui.handle('tab.close', (id) => browser.close(id as string));
    // A session's tabs go with it (ADR 0016).
    ctx.onAgentSessionEnded((session) => {
      const partition = sessionPartition(session);
      for (const tab of browser.list()) if (tab.partition === partition) browser.close(tab.id);
    });
    browserBay.restore();
  },
};

export default bay;
