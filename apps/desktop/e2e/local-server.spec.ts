import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { localServerLabel } from '../src/main/local-server';
import {
  expect,
  test,
  agentsEnv,
  answerDialog,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  startRelay,
} from './helpers';

test.skip(process.platform !== 'darwin', 'LaunchAgents only on macOS (ADR 0036)');

const health = async (data: string) => {
  const { port } = JSON.parse(readFileSync(join(data, 'listen.json'), 'utf8')) as { port: number };
  return fetch(`http://127.0.0.1:${port}/health`).then(
    (r) => r.status,
    () => 0,
  );
};

test('starts the local server as a LaunchAgent, pairs without a code and outlives the app (ADR 0036)', async () => {
  // The plist goes to a temporary folder; launchd runs it under its own label and forgets it at the end.
  const env = {
    ...agentsEnv(),
    HANGAR_LOCAL_SERVER: '1',
    HANGAR_LAUNCH_AGENTS: mkdtempSync(join(tmpdir(), 'hangar-e2e-agents-')),
  };
  const first = await launch({ bayDirs: [repoBays], env });
  const data = join(first.userData, 'local-server', 'data');
  const service = `gui/${process.getuid!()}/${localServerLabel(first.userData)}`;
  try {
    const nav = first.shell.getByRole('navigation', { name: 'Bays' });
    // Its bays by their name, no server entry of its own (step 4).
    await expect(nav.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(nav.getByRole('button', { name: /^Server / })).toHaveCount(0);

    // Stopped from outside: the bay says so; restarting brings it back.
    spawnSync('launchctl', ['bootout', service]);
    await nav.getByRole('button', { name: 'Agents (Lokaler Server läuft nicht)' }).click({
      timeout: 30_000,
    });
    const content = first.shell.getByRole('main');
    await expect(
      content.getByRole('heading', { name: 'Lokaler Server läuft nicht' }),
    ).toBeVisible();
    // Its log follows on the page, and the app says which reconnect attempt runs.
    await expect(content.getByRole('log', { name: 'Log des lokalen Servers' })).toContainText(
      'fingerprint SHA256:',
    );
    await expect(content.getByRole('status')).toHaveText(/^Verbinde erneut … \(Versuch \d+\)$/, {
      timeout: 30_000,
    });
    // Down, the count of shells is unknown: it asks first.
    await answerDialog(first.app, 'Neu starten');
    await content.getByRole('button', { name: 'Neu starten' }).click();
    await expect(nav.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(content.getByRole('heading')).toHaveCount(0);
    expect(await health(data)).toBe(200);
    await first.app.close();

    // Quitting Hangar leaves the server running.
    expect(await health(data)).toBe(200);

    const second = await launch({ bayDirs: [repoBays], env, userData: first.userData });
    try {
      await expect(
        second.shell
          .getByRole('navigation', { name: 'Bays' })
          .getByRole('button', { name: 'Agents', exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      const servers = JSON.parse(readFileSync(join(first.userData, 'servers.json'), 'utf8'));
      expect(servers).toEqual([expect.objectContaining({ name: 'Lokaler Server', local: data })]);
    } finally {
      await second.app.close();
    }
  } finally {
    spawnSync('launchctl', ['bootout', service]);
  }
  await expect.poll(() => health(data)).toBe(0);
});

/** A web page on the loopback, for the agent's browser tab. */
async function page(html: string) {
  const server = createServer((_req, res) => res.end(html));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/** Types `echo <tag>=$$` into the session's shell and returns the PID it prints. */
async function shellPid(bay: Page, tag: string): Promise<string> {
  await bay.locator('.xterm-helper-textarea').first().focus();
  await bay.keyboard.type(`echo ${tag}=$$\n`);
  const rows = bay.locator('.xterm-rows').first();
  const pid = new RegExp(`${tag}=(\\d+)`);
  // Read once per try: xterm may redraw the rows between two reads.
  let found: string | undefined;
  await expect
    .poll(async () => (found = pid.exec((await rows.textContent()) ?? '')?.[1]))
    .toBeDefined();
  return found!;
}

/** The agent bay of the local server, once the app has paired with it. */
async function serverBay(app: ElectronApplication, shell: Page): Promise<Page> {
  await shell
    .getByRole('navigation', { name: 'Bays' })
    .getByRole('button', { name: 'Agents', exact: true })
    .click({ timeout: 30_000 });
  return bayPage(app, 'agents/dist/ui');
}

/** An MCP call from the shell, as an agent of the session makes it. */
const mcpCall = (name: string, args: Record<string, string>) =>
  `curl -s -o /dev/null -H "Authorization: Bearer $HANGAR_TOKEN" -H 'content-type: application/json'` +
  ` -H 'accept: application/json, text/event-stream' "$HANGAR_MCP_URL"` +
  ` -d '${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}'\n`;

test('the agent bay moves into the local server; its shells outlive quit, kill -9 and a new bundle (ADR 0036)', async () => {
  test.setTimeout(180_000);
  const [shop, blog] = [createRepo('shop'), createRepo('blog')];
  const site = await page('<title>Vom Server</title>');
  const plain = agentsEnv();
  // Before: the agent bay runs in the app and knows a project.
  const before = await launch({ bayDirs: [repoBays], env: plain });
  try {
    await before.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(before.app, 'agents/dist/ui');
    await mockFolderPicker(before.app, shop);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await expect(bay.getByText(shop)).toBeVisible();
  } finally {
    await before.app.close();
  }

  const { userData } = before;
  const env = {
    ...plain,
    HANGAR_LOCAL_SERVER: '1',
    HANGAR_LAUNCH_AGENTS: mkdtempSync(join(tmpdir(), 'hangar-e2e-agents-')),
    HANGAR_LOCAL_SERVER_ROOT: realpathSync(tmpdir()),
  };
  const again = () => launch({ bayDirs: [repoBays], env, userData });
  const service = `gui/${process.getuid!()}/${localServerLabel(userData)}`;
  try {
    const first = await again();
    let pid: string;
    try {
      const nav = first.shell.getByRole('navigation', { name: 'Bays' });
      const bay = await serverBay(first.app, first.shell);
      // Moved with its data; no agent bay of its own in the app any more.
      await expect(bay.getByText(shop)).toBeVisible();
      await expect(nav.getByRole('button', { name: 'Agents', exact: true })).toHaveCount(1);
      // The folder dialog of this Mac, not the path form of a remote server.
      await mockFolderPicker(first.app, blog);
      await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
      await expect(bay.getByText(blog)).toBeVisible();
      await bay.getByRole('button', { name: 'Neue Session in shop' }).click();
      pid = await shellPid(bay, 'FIRST');
      // Not inherited from the LaunchAgent.
      await bay.keyboard.type('echo "RUN_AS_NODE=[$ELECTRON_RUN_AS_NODE]"\n');
      await expect(bay.locator('.xterm-rows').first()).toContainText('RUN_AS_NODE=[]');
    } finally {
      await first.app.close();
    }

    // Quit: the same shell, and it still reaches MCP.
    const second = await again();
    const bay = await serverBay(second.app, second.shell);
    expect(await shellPid(bay, 'AFTERQUIT')).toBe(pid);
    await bay.keyboard.type(
      mcpCall('dev.hangar.agents/session.setDescription', { description: 'nach-neustart' }),
    );
    await expect(bay.getByRole('navigation')).toContainText('nach-neustart');
    // A bay only the app runs, for the agent in the server: the browser opens its tab here.
    await bay.keyboard.type(mcpCall('dev.hangar.browser/tab.open', { url: site.url }));
    await second.shell
      .getByRole('navigation', { name: 'Bays' })
      .getByRole('button', { name: 'Browser' })
      .click();
    const browser = await bayPage(second.app, 'browser/dist/ui');
    await expect(browser.getByRole('button', { name: 'Agent Vom Server' })).toBeVisible();
    // Killed hard: no quit handler runs.
    second.app.process().kill('SIGKILL');
    await new Promise((r) => second.app.process().once('exit', r));

    const executable = process.env.HANGAR_E2E_EXECUTABLE;
    if (executable) {
      // An update replaces the bundle; the server runs from its own copy.
      const bundle = resolve(executable, '../../..');
      const keep = join(mkdtempSync(join(tmpdir(), 'hangar-e2e-bundle-')), 'Hangar.app');
      execFileSync('ditto', [bundle, keep]);
      rmSync(bundle, { recursive: true, force: true });
      execFileSync('ditto', [keep, bundle]);
    } else {
      test
        .info()
        .annotations.push({ type: 'skipped', description: 'bundle replaced only packaged' });
    }

    const third = await again();
    try {
      const bay = await serverBay(third.app, third.shell);
      expect(await shellPid(bay, 'AFTERKILL')).toBe(pid);
    } finally {
      await third.app.close();
    }
  } finally {
    spawnSync('launchctl', ['bootout', service]);
    site.close();
  }
});

test('the switch in the settings moves the agent bay into the server and back, and the service goes (ADR 0036, step 4b)', async () => {
  test.setTimeout(150_000);
  const shop = createRepo('shop');
  const launchAgents = mkdtempSync(join(tmpdir(), 'hangar-e2e-agents-'));
  // Without the variable the setting decides; a build from the repository starts with it off.
  const env = {
    ...agentsEnv(),
    HANGAR_LOCAL_SERVER: '',
    HANGAR_LAUNCH_AGENTS: launchAgents,
    HANGAR_LOCAL_SERVER_ROOT: realpathSync(tmpdir()),
  };
  const box = (shell: Page) =>
    shell.getByRole('checkbox', { name: 'Agents im lokalen Server ausführen' });
  // Off to begin with: the packaged app would start with the server on (its default).
  const userData = mkdtempSync(join(tmpdir(), 'hangar-e2e-'));
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ bays: ['dev.hangar.agents', 'dev.hangar.browser'], localServer: false }),
  );
  const first = await launch({ bayDirs: [repoBays], env, userData });
  const label = localServerLabel(userData);
  const service = `gui/${process.getuid!()}/${label}`;
  try {
    await first.shell.getByRole('button', { name: 'Agents', exact: true }).click();
    const own = await bayPage(first.app, 'agents/dist/ui');
    await mockFolderPicker(first.app, shop);
    await own.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await expect(own.getByText(shop)).toBeVisible();
    await first.shell.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(box(first.shell)).not.toBeChecked();
    await box(first.shell).check();
    await expect(first.shell.getByText('Gilt nach dem Neustart von Hangar.')).toBeVisible();
    await expect(first.shell.getByRole('button', { name: 'Hangar neu starten' })).toBeVisible();
    await first.app.close();

    const on = await launch({ bayDirs: [repoBays], userData, env });
    try {
      const bay = await serverBay(on.app, on.shell);
      await expect(bay.getByText(shop)).toBeVisible();
      expect(spawnSync('launchctl', ['print', service]).status).toBe(0);
      await on.shell.getByRole('button', { name: 'Einstellungen' }).click();
      on.shell.once('dialog', (d) => void d.accept());
      await box(on.shell).uncheck();
      await expect(on.shell.getByText('Gilt nach dem Neustart von Hangar.')).toBeVisible();
    } finally {
      await on.app.close();
    }

    const off = await launch({ bayDirs: [repoBays], userData, env });
    try {
      await off.shell.getByRole('button', { name: 'Agents', exact: true }).click();
      const back = await bayPage(off.app, 'agents/dist/ui');
      await expect(back.getByText(shop)).toBeVisible();
      expect(spawnSync('launchctl', ['print', service]).status).not.toBe(0);
      expect(existsSync(join(launchAgents, `${label}.plist`))).toBe(false);
      expect(existsSync(join(userData, 'local-server', 'migrated'))).toBe(false);
      const servers = JSON.parse(readFileSync(join(userData, 'servers.json'), 'utf8'));
      expect(servers).toEqual([]);
      await off.shell.getByRole('button', { name: 'Einstellungen' }).click();
      await expect(box(off.shell)).not.toBeChecked();
      await expect(off.shell.getByRole('button', { name: 'Hangar neu starten' })).toHaveCount(0);
    } finally {
      await off.app.close();
    }
  } finally {
    spawnSync('launchctl', ['bootout', service]);
  }
});

test('the workspaces move into the local server with the same fingerprint, and the server holds the relay (ADR 0036, point 11)', async () => {
  test.setTimeout(120_000);
  const relay = await startRelay();
  const env = {
    ...agentsEnv(),
    HANGAR_LOCAL_SERVER: '0',
    HANGAR_LAUNCH_AGENTS: mkdtempSync(join(tmpdir(), 'hangar-e2e-agents-')),
    HANGAR_LOCAL_SERVER_ROOT: realpathSync(tmpdir()),
  };
  const status = (shell: Page) => shell.getByRole('status');
  const fingerprint = (shell: Page) => shell.locator('.facts b').nth(1);
  const first = await launch({ bayDirs: [repoBays], env });
  const { userData } = first;
  const service = `gui/${process.getuid!()}/${localServerLabel(userData)}`;
  try {
    await first.shell.getByRole('button', { name: 'Einstellungen' }).click();
    const address = first.shell.getByRole('textbox', { name: 'Relay-Adresse' });
    await address.fill(relay.url);
    await address.press('Enter');
    await expect(status(first.shell)).toHaveText('Verbunden');
    const own = await fingerprint(first.shell).innerText();
    expect(own).toMatch(/^[0-9a-f]{64}$/);
    await first.app.close();

    const on = await launch({
      bayDirs: [repoBays],
      userData,
      env: { ...env, HANGAR_LOCAL_SERVER: '1' },
    });
    try {
      await on.shell.getByRole('button', { name: 'Einstellungen' }).click();
      // The server connects to the relay; the page shows its workspaces.
      await expect(status(on.shell)).toHaveText('Verbunden', { timeout: 30_000 });
      await expect(fingerprint(on.shell)).toHaveText(own);
      expect(existsSync(join(userData, 'workspaces'))).toBe(false);
      const identity = JSON.parse(
        readFileSync(
          join(userData, 'local-server', 'data', 'workspaces', 'relay-identity.json'),
          'utf8',
        ),
      ) as { keys: string };
      expect(identity.keys).toMatch(/^plain:/);
    } finally {
      await on.app.close();
    }
  } finally {
    spawnSync('launchctl', ['bootout', service]);
    relay.child.kill();
  }
});

test('a server from an older copy shows „Neue Version bereit“ until it restarts in this version (ADR 0036, step 4a)', async () => {
  test.skip(!process.env.HANGAR_E2E_EXECUTABLE, 'runtime copies exist only packaged');
  test.setTimeout(180_000);
  const launchAgents = mkdtempSync(join(tmpdir(), 'hangar-e2e-agents-'));
  const env = { ...agentsEnv(), HANGAR_LOCAL_SERVER: '1', HANGAR_LAUNCH_AGENTS: launchAgents };
  const first = await launch({ bayDirs: [repoBays], env });
  const { userData } = first;
  const runtime = join(userData, 'local-server', 'runtime');
  const label = localServerLabel(userData);
  const service = `gui/${process.getuid!()}/${label}`;
  const plistFile = join(launchAgents, `${label}.plist`);
  try {
    await serverBay(first.app, first.shell);
    await first.app.close();
    // The server of an update before: its own copy under an older version, loaded from there.
    // The copy is named `<version>+<build id>`; the hint names plain versions when they differ.
    const [version] = readdirSync(runtime);
    spawnSync('launchctl', ['bootout', service]);
    execFileSync('ditto', [join(runtime, version!), join(runtime, '0.0.1')]);
    writeFileSync(
      plistFile,
      readFileSync(plistFile, 'utf8').replaceAll(`/runtime/${version}/`, '/runtime/0.0.1/'),
    );
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistFile]);

    const second = await launch({ bayDirs: [repoBays], env, userData });
    try {
      await serverBay(second.app, second.shell);
      const hint = second.shell.getByRole('main').getByRole('region', { name: 'Neue Version' });
      await expect(hint).toContainText(
        `Im lokalen Server läuft Hangar 0.0.1, installiert ist ${version!.split('+')[0]}.`,
      );
      await answerDialog(second.app, 'Neu starten');
      await hint.getByRole('button', { name: 'Lokalen Server neu starten' }).click();
      await expect(hint).toHaveCount(0, { timeout: 60_000 });
      expect(readFileSync(plistFile, 'utf8')).not.toContain('/runtime/0.0.1/');
      // The old copy goes once no plist names it.
      expect(readdirSync(runtime)).toEqual([version]);
    } finally {
      await second.app.close();
    }
  } finally {
    spawnSync('launchctl', ['bootout', service]);
  }
});

test('with the local server, a password still reaches the shell and the agent shares the board (ADR 0021, 0037)', async () => {
  test.setTimeout(120_000);
  const repo = createRepo('shop');
  const env = {
    ...agentsEnv(),
    HANGAR_LOCAL_SERVER: '1',
    HANGAR_LAUNCH_AGENTS: mkdtempSync(join(tmpdir(), 'hangar-e2e-agents-')),
    HANGAR_LOCAL_SERVER_ROOT: realpathSync(tmpdir()),
  };
  const { app, shell, userData } = await launch({ bayDirs: [repoBays], env });
  const service = `gui/${process.getuid!()}/${localServerLabel(userData)}`;
  try {
    // The vault stays in the app; only reading a value asks (ADR 0032).
    await answerDialog(app, 'Dauerhaft erlauben');
    const bay = await serverBay(app, shell);
    await shell.getByRole('button', { name: 'Passwörter' }).click();
    const vault = await bayPage(app, 'secrets/dist/ui');
    const form = vault.getByRole('form', { name: 'Neues Passwort' });
    await form.getByLabel('Name').fill('GH_TOKEN');
    await form.getByLabel('Wert').fill('geheim-123');
    await form.getByLabel('Wert').press('Enter');
    await expect(vault.getByRole('status')).toHaveText('GH_TOKEN gespeichert');

    // The agent bay runs in the server and asks the vault of the app.
    await serverBay(app, shell);
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: /^shop / }).click();
    const vars = bay.getByRole('textbox', { name: 'Umgebungsvariablen für neue Sessions' });
    await expect(vars).toHaveAccessibleDescription(/Gespeichert: GH_TOKEN/);
    await vars.fill('GH=@secret:GH_TOKEN');
    await bay.getByRole('button', { name: 'Speichern' }).click();
    await bay.getByRole('button', { name: 'Neue Session in shop' }).click();
    const rows = bay.locator('.xterm:visible .xterm-rows');
    await expect(rows).toContainText('$');
    await bay.locator('.xterm:visible .xterm-helper-textarea').focus();
    await bay.keyboard.type('echo "v=$GH"\n');
    await expect(rows).toContainText('v=geheim-123');

    // The board runs in the server too and sees the agent of the session.
    await bay.keyboard.type(mcpCall('dev.hangar.board/task.add', { title: 'Vom Agent' }));
    await shell.getByRole('button', { name: 'Board' }).click();
    const board = await bayPage(app, 'board/dist/ui');
    await expect(board.getByLabel('Projekt')).toHaveValue(/.+/);
    const open = board.getByRole('region', { name: 'Offen' });
    await expect(open).toContainText('Vom Agent');
    await expect(open).toContainText('von Agent');
    await board.getByRole('button', { name: 'Aufgabe hinzufügen' }).click();
    const add = board.getByRole('form', { name: 'Neue Aufgabe' });
    await add.getByLabel('Titel').fill('Login testen');
    await add.getByLabel('Titel').press('Enter');
    await expect(open).toContainText('Login testen');

    // The bays of the server sort among those of the app (ADR 0038).
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    const ids = () =>
      nav
        .locator('.sidebar-list [data-testid^="bay-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    const before = await ids();
    expect(before[0]).not.toBe('Board');
    await nav
      .getByRole('button', { name: 'Board' })
      .dragTo(nav.getByRole('button', { name: before[0]! }));
    await expect.poll(ids).toEqual(['Board', ...before.filter((n) => n !== 'Board')]);

    expect(
      await app.evaluate(
        () => (globalThis as { __hangarDialogs?: string[] }).__hangarDialogs ?? [],
      ),
    ).toEqual([expect.stringContaining('„dev.hangar.secrets/secret.resolve“')]);
    expect(
      readFileSync(join(userData, 'bays', 'dev.hangar.secrets', 'vault.json'), 'utf8'),
    ).not.toContain('geheim-123');
  } finally {
    await app.close();
    spawnSync('launchctl', ['bootout', service]);
  }
});
