import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type Page,
  agentsEnv,
  bayPage,
  createRepo,
  expectPageError,
  launch,
  mockFolderPicker,
  repoBays,
  violations,
} from './helpers';

/** A local test site: a form, and a cookie each tab can set and read. */
function startSite(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const cookie = /who=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'keins';
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
    if (url.pathname === '/set') headers['set-cookie'] = `who=${url.searchParams.get('v')}; Path=/`;
    // Never answers: the tab waits until its 30-second limit.
    if (url.pathname === '/hang') return;
    if (url.pathname === '/redirect-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      return res.end();
    }
    // A server error with errors inside: a console error, a failing request, an exception.
    if (url.pathname === '/broken') {
      res.writeHead(500, headers);
      return res.end(`<title>Kaputt</title><p>Kaputt hier, Kaputt da</p>
        <script>
          console.error('selbst geloggt');
          fetch('/missing');
          setTimeout(() => { throw new Error('kaputt'); });
        </script>`);
    }
    if (url.pathname === '/missing') {
      res.writeHead(404, headers);
      return res.end('nicht da');
    }
    if (url.pathname === '/links') {
      res.writeHead(200, headers);
      return res.end(`<title>Links</title>
        <a id="file" href="file:///etc/passwd">Datei</a>
        <a id="popup" href="/who" target="_blank">Neues Fenster</a>
        <a id="blob">Blob</a>
        <script>
          blob.href = URL.createObjectURL(new Blob(['<title>Blob</title>'], { type: 'text/html' }));
        </script>`);
    }
    res.writeHead(200, headers);
    res.end(
      url.pathname === '/who'
        ? `<title>Cookie</title><p>Cookie: ${cookie}</p>`
        : `<title>Testseite</title><h1>Hallo Hangar</h1>
           <input id="name"><button id="go" onclick="out.textContent = 'Hallo ' + document.getElementById('name').value">Los</button>
           <p id="out"></p>`,
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** MCP client for one agent session, with the token its shell got. */
function agent(token: string, mcpUrl: string) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await fetch(mcpUrl, {
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
        params: { name: `dev.hangar.browser/${name}`, arguments: args },
      }),
    });
    const { result } = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    const text = result.content[0]!.text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown> & { text: string; id: string };
  };
}

/** Opens a session and has its shell write token and MCP address to a file. */
const tokens = new Set<string>();

async function newSession(bay: Page, project: string, file: string) {
  await bay.getByRole('button', { name: `Neue Session in ${project}` }).click();
  // The new shell may swap in after the click; type until it has written the file.
  let token = '';
  let url = '';
  await expect(async () => {
    const terminal = bay.locator('.xterm:visible');
    await expect(terminal.locator('.xterm-rows')).toContainText('$', { timeout: 2000 });
    await terminal.locator('.xterm-helper-textarea').focus();
    // Keys typed while the shell starts may get lost and leave a quote open: start a clean line.
    await bay.keyboard.press('Control+C');
    await bay.keyboard.type(`echo "$HANGAR_TOKEN $HANGAR_MCP_URL" > ${file}\n`);
    // The shell creates the file before it writes the line: wait for the whole line.
    let line = '';
    await expect
      .poll(() => (line = existsSync(file) ? readFileSync(file, 'utf8') : ''), { timeout: 2000 })
      .toMatch(/^\S+ \S+\n$/);
    [token, url] = line.trim().split(' ') as [string, string];
    // Written by the previous session's shell if that was still shown: try again.
    if (tokens.has(token)) {
      rmSync(file);
      throw new Error('token of an earlier session');
    }
  }).toPass({ timeout: 20_000 });
  tokens.add(token);
  return agent(token, url);
}

test('agents open, read, click, fill and screenshot pages in tabs of their own', async () => {
  const site = await startSite();
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const repo = createRepo('web');
  const tmp = mkdtempSync(join(tmpdir(), 'hangar-e2e-browser-'));
  const first = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    const { app, shell } = first;
    await shell.getByRole('button', { name: 'Agents' }).click();
    const agents = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await agents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    const one = await newSession(agents, 'web', join(tmp, 'one'));
    const two = await newSession(agents, 'web', join(tmp, 'two'));
    // The functions are open to agents (ADR 0016): no permission dialog. Count any that shows.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => {
        (globalThis as { __dialogs?: number }).__dialogs =
          ((globalThis as { __dialogs?: number }).__dialogs ?? 0) + 1;
        return { response: -1, checkboxChecked: false };
      }) as never;
    });
    const dialogs = () => app.evaluate(() => (globalThis as { __dialogs?: number }).__dialogs ?? 0);

    await shell.getByRole('button', { name: 'Browser' }).click();
    const bay = await bayPage(app, 'browser/dist/ui');

    const tab = await one('tab.open', { url: base.replace('http://', '') });
    expect(tab).toMatchObject({ url: `${base}/`, title: 'Testseite' });
    await expect(bay.getByRole('button', { name: 'Agent Testseite' })).toBeVisible();

    expect((await one('page.text', { id: tab.id })).text).toContain('Hallo Hangar');
    await one('page.fill', { id: tab.id, selector: '#name', value: 'Anna' });
    await one('page.click', { id: tab.id, selector: '#go' });
    expect((await one('page.text', { id: tab.id })).text).toContain('Hallo Anna');
    await expect(one('page.click', { id: tab.id, selector: '#nope' })).rejects.toThrow(
      'No element matches "#nope"',
    );

    const { path } = (await one('page.screenshot', { id: tab.id })) as unknown as { path: string };
    const png = readFileSync(path);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeGreaterThan(1000);

    // The other agent neither sees nor reaches the tab.
    expect(await two('tab.list')).toEqual([]);
    await expect(two('page.text', { id: tab.id })).rejects.toThrow(`Unknown tab "${tab.id}"`);

    // Each agent has its own cookies, and the person's tabs have none of them.
    await one('tab.navigate', { id: tab.id, url: `${base}/set?v=eins` });
    const other = await two('tab.open', { url: `${base}/set?v=zwei` });
    await one('tab.navigate', { id: tab.id, url: `${base}/who` });
    await two('tab.navigate', { id: other.id, url: `${base}/who` });
    expect((await one('page.text', { id: tab.id })).text).toContain('Cookie: eins');
    expect((await two('page.text', { id: other.id })).text).toContain('Cookie: zwei');
    expect(await dialogs()).toBe(0);

    const address = bay.getByRole('textbox', { name: 'Adresse' });
    await bay.getByRole('button', { name: 'Neuer Tab' }).click();
    await address.fill('file:///etc/passwd');
    await address.press('Enter');
    await expect(bay.getByRole('alert')).toHaveText(
      'Nur http- und https-Adressen lassen sich öffnen.',
    );
    await address.fill('');
    await bay.getByRole('button', { name: 'Öffnen', exact: true }).click();
    await expect(bay.getByRole('alert')).toHaveText('Adresse eingeben.');
    await address.fill(`${base.replace('http://', '')}/who?person`);
    await address.press('Enter');
    const userTab = bay.getByRole('button', { name: 'Cookie', exact: true });
    await expect(userTab).toHaveAttribute('aria-current', 'page');
    const page = await bayPage(app, `${base}/who?person`);
    await expect(page.locator('body')).toContainText('Cookie: keins');

    // The shown page is visible; the agent tabs stay hidden behind it.
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');

    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `browser (${colorScheme})`).toEqual([]);
    }

    // Keyboard: Tab runs from the selected tab to its close button.
    await userTab.focus();
    await bay.keyboard.press('Tab');
    await expect(bay.getByRole('button', { name: 'Tab Cookie schließen' }).last()).toBeFocused();
    await address.focus();
    await address.press('Enter');
    await expect(bay.getByRole('alert')).toHaveCount(0);

    // 200 % zoom: no horizontal page overflow, also in a window as wide as a 1024 px screen
    // (CI runner), where the bay is under 500 CSS pixels wide.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 25, width: 1024, height: 743 }),
    );
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    expect(
      await bay.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1);
    });

    // Closing a session closes its tabs (ADR 0016); the other agent keeps its tab.
    await expect(bay.getByRole('button', { name: 'Agent Cookie' })).toHaveCount(2);
    await shell.getByRole('button', { name: 'Agents' }).click();
    await agents.evaluate(() => (window.confirm = () => true));
    await agents.getByRole('button', { name: 'Session schließen' }).click();
    await expect(bay.getByRole('button', { name: 'Agent Cookie' })).toHaveCount(1);
    expect(await one('tab.list')).toHaveLength(1);
    await expect(two('tab.list')).rejects.toThrow();
  } finally {
    await first.app.close();
  }

  // After a restart the person's tab is back, the agent tabs are not.
  const second = await launch({ userData: first.userData, bayDirs: [repoBays], env: agentsEnv() });
  try {
    await second.shell.getByRole('button', { name: 'Browser' }).click();
    const bay = await bayPage(second.app, 'browser/dist/ui');
    await expect(bay.getByRole('listitem')).toHaveCount(1);
    await expect(bay.getByRole('button', { name: 'Cookie', exact: true })).toBeVisible();
  } finally {
    await second.app.close();
    site.close();
  }
});

test('real tabs: failed load, forbidden redirect and link, popup, crash and the 30-second limit', async () => {
  test.setTimeout(150_000);
  const site = await startSite();
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  // A port nobody listens on.
  const closed = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
  const repo = createRepo('tabs');
  const tmp = mkdtempSync(join(tmpdir(), 'hangar-e2e-tabs-'));
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const agents = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await agents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    const one = await newSession(agents, 'tabs', join(tmp, 'one'));
    await shell.getByRole('button', { name: 'Browser' }).click();
    const bay = await bayPage(app, 'browser/dist/ui');

    // Nobody listens: the tab names the error, here and in the bay.
    const failed = await one('tab.open', { url: `127.0.0.1:${closed}` });
    expect(failed.error).toBe('ERR_CONNECTION_REFUSED');
    expect(failed.errors).toBe(1);
    await bay.getByRole('button', { name: /^Agent .* \(Laden fehlgeschlagen\)$/ }).click();
    await expect(bay.getByRole('alert')).toContainText('Seite konnte nicht geladen werden');
    await expect(bay.getByRole('alert')).toContainText('ERR_CONNECTION_REFUSED');

    // A broken page: the agent gets the status with the tab and the errors on request.
    expectPageError(/\/broken: kaputt$/);
    const broken = await one('tab.open', { url: `${base}/broken` });
    expect(broken).toMatchObject({ status: 500, title: 'Kaputt' });
    const messages = async () =>
      ((await one('page.errors', { id: broken.id })).errors as { kind: string; message: string }[])
        .map((e) => `${e.kind}: ${e.message}`)
        .join('\n');
    await expect.poll(messages).toContain('load: HTTP 500');
    await expect.poll(messages).toContain('console: selbst geloggt');
    await expect.poll(messages).toContain('request: HTTP 404');
    await expect.poll(messages).toMatch(/console: Uncaught Error: kaputt/);
    const all = (await one('page.errors', { id: broken.id })).errors as { time: number }[];
    expect((await one('page.errors', { id: broken.id, since: all.at(-1)!.time })).errors).toEqual(
      [],
    );
    // A failed load replaces the broken page: only its own error, no status of the old page.
    const gone = await one('tab.navigate', { id: broken.id, url: `127.0.0.1:${closed}` });
    expect(gone).toMatchObject({ error: 'ERR_CONNECTION_REFUSED', errors: 1 });
    expect(gone).not.toHaveProperty('status');
    await one('tab.close', { id: broken.id });

    // A redirect to a file and a link to a file are stopped; the page stays.
    const tab = await one('tab.navigate', { id: failed.id, url: `${base}/redirect-file` });
    expect(tab.url).not.toMatch(/^file:/);
    await one('tab.navigate', { id: tab.id, url: `${base}/links` });
    await one('page.click', { id: tab.id, selector: '#file' });
    // Chromium itself stops http → file; a same-origin blob: only Hangar stops (allowedUrl).
    await one('page.click', { id: tab.id, selector: '#blob' });
    await bay.waitForTimeout(500);
    const [stayed] = (await one('tab.list')) as unknown as { url: string }[];
    expect(stayed!.url).toBe(`${base}/links`);
    const urls = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((wc) => wc.getURL()),
    );
    expect(urls.filter((u) => /^(file:\/\/\/etc|blob:)/.test(u))).toEqual([]);

    // A popup becomes a tab of the same agent, with its opener.
    await one('page.click', { id: tab.id, selector: '#popup' });
    await expect
      .poll(async () => ((await one('tab.list')) as unknown as Record<string, string>[])[1])
      .toMatchObject({ url: `${base}/who`, openerId: tab.id });

    // A crashed page is named; loading again brings it back.
    await app.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === url)!
        .forcefullyCrashRenderer();
    }, `${base}/links`);
    await expect
      .poll(async () => ((await one('tab.list')) as unknown as { error?: string }[])[0]!.error)
      .toMatch(/^Page crashed \(/);
    const back = await one('tab.navigate', { id: tab.id, url: `${base}/who` });
    expect(back).not.toHaveProperty('error');
    expect((await one('page.text', { id: tab.id })).text).toContain('Cookie: keins');

    // A page that never answers: the call returns after 30 seconds, the tab still loading.
    const start = Date.now();
    const slow = await one('tab.open', { url: `${base}/hang` });
    const waited = Date.now() - start;
    expect(waited).toBeGreaterThanOrEqual(29_500);
    expect(waited).toBeLessThan(40_000);
    expect(slow.loading).toBe(true);
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});

test('the page zoom shows next to the address and resets to 100 %', async () => {
  const site = await startSite();
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const { app, shell } = await launch({ bayDirs: [repoBays] });
  try {
    await shell.getByRole('button', { name: 'Browser' }).click();
    const bay = await bayPage(app, 'browser/dist/ui');
    const address = bay.getByRole('textbox', { name: 'Adresse' });
    await address.fill(`${base}/who`);
    await address.press('Enter');
    const page = await bayPage(app, `${base}/who`);
    await expect(page.locator('body')).toContainText('Cookie');
    // Native key events like a real keyboard; Playwright's CDP keys skip `before-input-event`.
    const press = (keyCode: string) =>
      app.evaluate(
        ({ webContents }, [keyCode, url]) => {
          const tab = webContents.getAllWebContents().find((w) => w.getURL() === url)!;
          const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'] as 'meta'[];
          tab.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        },
        [keyCode, `${base}/who`],
      );
    await press('=');
    await press('=');
    const zoom = bay.getByRole('button', { name: '120 % – Zoom auf 100 % zurücksetzen' });
    await expect(zoom).toHaveText('120 %');
    await press('-');
    await expect(bay.getByRole('button', { name: /^110 %/ })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `zoom (${colorScheme})`).toEqual([]);
    }
    // Zoom belongs to the host: another host shows 100 %, going back shows 110 % again.
    const other = `${base.replace('127.0.0.1', 'localhost')}/who`;
    await address.fill(other);
    await address.press('Enter');
    await expect(address).toHaveValue(other);
    await expect(bay.getByRole('button', { name: /Zoom/ })).toHaveCount(0);
    await bay.getByRole('button', { name: 'Zurück' }).click();
    await expect(bay.getByRole('button', { name: /^110 %/ })).toBeVisible();
    await bay.getByRole('button', { name: /^110 %/ }).click();
    await expect(bay.getByRole('button', { name: /Zoom/ })).toHaveCount(0);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(
      await bay.evaluate(() => window.devicePixelRatio),
    );
  } finally {
    await app.close();
    site.close();
  }
});

test('errors of a page, find in page and opening outside Hangar (ADR 0042)', async () => {
  const site = await startSite();
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const closed = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
  const { app, shell } = await launch({ bayDirs: [repoBays] });
  try {
    await app.evaluate(({ shell }) => {
      (globalThis as { __opened?: string[] }).__opened = [];
      shell.openExternal = (async (url: string) =>
        void (globalThis as { __opened?: string[] }).__opened!.push(url)) as never;
    });
    await shell.getByRole('button', { name: 'Browser' }).click();
    const bay = await bayPage(app, 'browser/dist/ui');
    const address = bay.getByRole('textbox', { name: 'Adresse' });
    const axe = async (what: string) => {
      for (const colorScheme of ['light', 'dark'] as const) {
        await bay.emulateMedia({ colorScheme });
        expect(await violations(bay), `${what} (${colorScheme})`).toEqual([]);
      }
    };

    // The broken page stays visible; the status and the error count say what is wrong.
    expectPageError(/\/broken: kaputt$/);
    await address.fill(`${base}/broken`);
    await address.press('Enter');
    await expect(bay.getByText('Die Seite antwortet mit HTTP 500.')).toBeVisible();
    await expect(bay.getByRole('button', { name: /^Kaputt \(\d+ Fehler\)$/ })).toBeVisible();
    const toggle = bay.getByRole('button', { name: /^Fehler \(\d+\)$/ });
    await toggle.click();
    const panel = bay.getByRole('region', { name: 'Fehler der Seite' });
    await expect(panel).toContainText('HTTP 404');
    await expect(panel).toContainText(`${base}/missing`);
    await expect(panel).toContainText('Uncaught Error: kaputt');
    await axe('error panel');

    // Find: Cmd/Ctrl+F in the page itself opens the find bar of the bay.
    const page = await bayPage(app, `${base}/broken`);
    await app.evaluate(({ webContents }, url) => {
      const tab = webContents.getAllWebContents().find((w) => w.getURL() === url)!;
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'] as 'meta'[];
      tab.focus();
      tab.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers });
    }, `${base}/broken`);
    const find = bay.getByRole('searchbox', { name: 'Auf der Seite suchen' });
    await expect(find).toBeFocused();
    await find.fill('Kaputt');
    await expect(bay.getByText('1/2')).toBeVisible();
    await find.press('Enter');
    await expect(bay.getByText('2/2')).toBeVisible();
    await find.press('Shift+Enter');
    await expect(bay.getByText('1/2')).toBeVisible();
    await find.fill('gibtsnicht');
    await expect(bay.getByText('Keine Treffer')).toBeVisible();
    await axe('find bar');
    // 200 % zoom with find bar and error panel open: no horizontal overflow.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    expect(
      await bay.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1);
    });
    await find.press('Escape');
    await expect(find).toHaveCount(0);
    await expect(page.locator('body')).toContainText('Kaputt hier');

    // Open outside Hangar.
    await bay.getByRole('button', { name: 'Im Browser öffnen' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
      .toEqual([`${base}/broken`]);

    // A page that does not load gives way to an error page.
    await bay.getByRole('button', { name: 'Neuer Tab' }).click();
    await address.fill(`127.0.0.1:${closed}`);
    await address.press('Enter');
    const alert = bay.getByRole('alert');
    await expect(alert).toContainText('Seite konnte nicht geladen werden');
    await expect(alert).toContainText('ERR_CONNECTION_REFUSED');
    await expect(alert.getByRole('button', { name: 'Neu laden' })).toBeVisible();
    await axe('error page');
  } finally {
    await app.close();
    site.close();
  }
});

test('the person trusts a self-signed certificate, in agent tabs too (ADR 0043)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-e2e-cert-'));
  const [key, cert] = [join(dir, 'key.pem'), join(dir, 'cert.pem')];
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
    ].concat(['-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']),
    { stdio: 'ignore' },
  );
  // A page with a script of its own host: trusted, both load.
  const site = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end("document.getElementById('out').textContent = 'Skript geladen';");
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Eigenes Zertifikat</title><p id="out"></p><script src="/app.js"></script>');
    },
  );
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const url = `https://localhost:${(site.address() as AddressInfo).port}/`;
  const repo = createRepo('web');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const agents = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await agents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    const one = await newSession(agents, 'web', join(dir, 'one'));

    // The agent's tab is refused, and the agent has no way to trust.
    const refused = await one('tab.open', { url });
    expect(refused).toMatchObject({
      error: 'ERR_CERT_AUTHORITY_INVALID',
      certificate: { host: 'localhost', fingerprint: expect.stringMatching(/^sha256\//) },
    });

    await shell.getByRole('button', { name: 'Browser' }).click();
    const bay = await bayPage(app, 'browser/dist/ui');
    await bay.getByRole('button', { name: 'Neuer Tab' }).click();
    const address = bay.getByRole('textbox', { name: 'Adresse' });
    await address.fill(url);
    await address.press('Enter');
    const alert = bay.getByRole('alert');
    await expect(alert).toContainText('ERR_CERT_AUTHORITY_INVALID');
    await expect(alert).toContainText('Zertifikat von localhost: sha256/');
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `trust (${colorScheme})`).toEqual([]);
    }
    await alert.getByRole('button', { name: 'Diesem Host vertrauen' }).click();
    await expect(alert).toHaveCount(0);
    const page = await bayPage(app, url);
    await expect(page.locator('#out')).toHaveText('Skript geladen');

    // The agent's tab lives in a partition of its own: Hangar's trust reaches it there.
    expect(await one('tab.navigate', { id: refused.id, url })).toMatchObject({
      title: 'Eigenes Zertifikat',
    });
    expect((await one('page.text', { id: refused.id })).text).toContain('Skript geladen');
  } finally {
    await app.close();
    site.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
