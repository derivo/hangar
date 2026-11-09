import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type Page,
  agentsEnv,
  answerDialog,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  violations,
} from './helpers';

/** A local feed whose entries the test changes. */
async function feedServer() {
  let titles = ['Erster Beitrag'];
  const server = createServer((req, res) => {
    if (req.url !== '/feed.xml') return void res.writeHead(404).end();
    const items = titles
      .map((t, i) => `<item><title>${t}</title><link>/p/${i}</link><guid>g${i}</guid></item>`)
      .reverse()
      .join('');
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(`<rss version="2.0"><channel><title>Testblog</title>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, publish: (title: string) => void (titles = [...titles, title]) };
}

/** Has the visible session shell write `command`'s output to `file` and returns it. */
async function shellOutput(bay: Page, command: string, file: string) {
  let out = '';
  await expect(async () => {
    const terminal = bay.locator('.xterm:visible');
    await expect(terminal.locator('.xterm-rows')).toContainText('$', { timeout: 2000 });
    await terminal.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.press('Control+C');
    await bay.keyboard.type(`${command} > ${file}.tmp && mv ${file}.tmp ${file}\n`);
    await expect.poll(() => existsSync(file), { timeout: 2000 }).toBe(true);
    out = readFileSync(file, 'utf8').trim();
  }).toPass({ timeout: 20_000 });
  rmSync(file);
  return out;
}

async function mcp(token: string, url: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: `dev.hangar.feeds/${name}`, arguments: args },
    }),
  });
  const { result } = (await res.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text) as unknown;
}

test('feed entries arrive as a history, agents subscribe and read them', async () => {
  const feed = await feedServer();
  const repo = createRepo('news');
  const tmp = mkdtempSync(join(tmpdir(), 'hangar-e2e-feeds-'));
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    // feed.* is not open to agents: the first call asks once (ADR 0006).
    await answerDialog(app, 'Erlauben');
    await shell.getByRole('button', { name: 'Feeds' }).click();
    const page = await bayPage(app, 'feeds/dist/ui');
    await expect(page.getByText('Noch keine Feeds.', { exact: false })).toBeVisible();

    // Form: one wrong value at a time, then the happy path by keyboard.
    const form = page.getByRole('form', { name: 'Feed abonnieren' });
    const input = form.getByLabel('Feed-URL');
    await form.getByRole('button', { name: 'Abonnieren' }).click();
    await expect(page.getByRole('alert')).toHaveText('Ungültige Feed-URL (nur http und https)');
    await input.fill('ftp://example.org/feed.xml');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Ungültige Feed-URL (nur http und https)');
    await input.fill(`${feed.base}/feed.xml`);
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.locator('.error')).toBeEmpty();
    await input.fill(`${feed.base}/feed.xml`);
    await form.getByRole('button', { name: 'Abonnieren' }).click();
    await expect(page.getByRole('alert')).toHaveText('Feed ist schon abonniert');

    const log = page.getByRole('log', { name: 'Verlauf' });
    await expect(log.getByRole('link', { name: 'Erster Beitrag' })).toHaveAttribute(
      'href',
      `${feed.base}/p/0`,
    );
    await expect(page.getByRole('list', { name: 'Abonnements' })).toContainText('Testblog');

    feed.publish('Zweiter Beitrag');
    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(log.locator('.entry')).toHaveText([/Erster Beitrag/, /Zweiter Beitrag/]);

    // A feed that is gone shows its error on the subscription.
    await input.fill(`${feed.base}/weg.xml`);
    await input.press('Enter');
    await expect(page.getByRole('list', { name: 'Abonnements' })).toContainText('HTTP 404');

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await violations(page), `feeds (${colorScheme})`).toEqual([]);
    }

    await page.getByRole('button', { name: `${feed.base}/weg.xml abbestellen` }).click();
    await expect(page.getByRole('list', { name: 'Abonnements' })).not.toContainText('HTTP 404');

    // Settings live in the bay (ADR 0040): gear opens a modal, keyboard first.
    const gear = page.getByRole('button', { name: 'Einstellungen' });
    await page.getByRole('button', { name: 'Aktualisieren' }).focus();
    await page.keyboard.press('Tab');
    await expect(gear).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Einstellungen' });
    await expect(dialog).toBeVisible();
    const interval = dialog.getByLabel('Abruf-Intervall (Minuten)');
    await expect(interval).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(gear).toBeFocused();

    await gear.click();
    await expect(interval).toHaveValue('15');
    const max = dialog.getByLabel('Einträge im Verlauf');
    await expect(max).toHaveValue('1000');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await violations(page), `feeds settings (${colorScheme})`).toEqual([]);
    }
    await max.fill('99');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Verlauf: ganze Zahl von 100 bis 10000 Einträgen',
    );
    await max.fill('500');
    await interval.fill('0');
    await interval.press('Enter');
    await expect(dialog.getByRole('alert')).toHaveText(
      'Abruf-Intervall: ganze Zahl von 1 bis 1440 Minuten',
    );
    await interval.fill('');
    await interval.press('Enter');
    await expect(dialog.getByRole('alert')).toHaveText(
      'Abruf-Intervall: ganze Zahl von 1 bis 1440 Minuten',
    );
    await interval.fill('30');
    await max.fill('');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Verlauf: ganze Zahl von 100 bis 10000 Einträgen',
    );
    await max.fill('500');
    await interval.press('Enter');
    await expect(dialog).toBeHidden();
    await gear.click();
    await expect(interval).toHaveValue('30');
    await expect(max).toHaveValue('500');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toBeHidden();

    // An agent reads the history through MCP.
    await shell.getByRole('button', { name: 'Agents' }).click();
    const agents = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await agents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await agents.getByRole('button', { name: 'Neue Session in news' }).click();
    const line = await shellOutput(agents, 'echo "$HANGAR_TOKEN $HANGAR_MCP_URL"', join(tmp, 'a'));
    const [token, url] = line.split(' ') as [string, string];
    const items = (await mcp(token, url, 'feed.items')) as { title: string }[];
    expect(items.map((i) => i.title)).toEqual(['Erster Beitrag', 'Zweiter Beitrag']);
    await expect(mcp(token, url, 'feed.add', { url: 'file:///etc/hosts' })).rejects.toThrow(
      /Invalid arguments: url/,
    );
  } finally {
    await app.close();
    feed.server.close();
  }
});
