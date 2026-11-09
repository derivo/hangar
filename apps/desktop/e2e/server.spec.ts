import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  agentsEnv,
  answerDialog,
  bayPage,
  createRepo,
  curl,
  launch,
  repoBays,
  vaultBays,
  violations,
} from './helpers';

/** `hangar-server` from `apps/server/dist` (built by `pnpm test:e2e`), without SSH. */
async function startHangarServer(root: string, bays = [repoBays]) {
  const data = mkdtempSync(join(tmpdir(), 'hangar-e2e-server-'));
  const child = spawn(
    process.execPath,
    [
      join(__dirname, '../../server/dist/hangar-server.mjs'),
      ...['--data', data, '--root', root, ...bays.flatMap((b) => ['--bays', b])],
    ],
    { env: { ...process.env, ...agentsEnv() } },
  );
  let log = '';
  child.stdout!.on('data', (chunk) => (log += chunk));
  const value = (prefix: string) =>
    [...log.matchAll(new RegExp(`^${prefix} (\\S+)$`, 'gm'))].at(-1)?.[1];
  await expect.poll(() => value('listening on'), { timeout: 15_000 }).toBeTruthy();
  return {
    child,
    data,
    address: value('listening on')!.slice('http://'.length),
    fingerprint: value('fingerprint')!,
    code: () => value('pairing code')!,
  };
}

/** Replaces the native menu: the item with `label` is clicked at once. */
const clickMenu = (app: ElectronApplication, label: string) =>
  app.evaluate(({ Menu }, label) => {
    Menu.buildFromTemplate = ((items: { label?: string; click?(): void }[]) => ({
      popup: () => items.find((i) => i.label === label)!.click!(),
    })) as never;
  }, label);

let server: { child: ChildProcess } | undefined;
test.afterEach(() => void server?.child.kill());

test('pairs with a server and works with its agent bay as if it ran here (ADR 0019)', async () => {
  const repo = createRepo('remote-shop');
  const s = await startHangarServer(dirname(repo), [repoBays, vaultBays]);
  server = s;
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays, vaultBays], env, seedBays: false });
  try {
    const nav = first.shell.getByRole('navigation', { name: 'Bays' });
    await nav.getByRole('button', { name: 'Zur Leiste hinzufügen' }).click();
    const dialog = first.shell.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Mit Server verbinden' }).click();
    await expect(dialog).toHaveAccessibleName('Mit Server verbinden');
    await dialog.getByLabel('Name').fill('Testserver');
    await dialog.getByLabel('Adresse').fill(s.address);
    await dialog.getByLabel('Adresse').press('Enter');
    await expect(dialog).toContainText(s.fingerprint);
    for (const colorScheme of ['light', 'dark'] as const) {
      await first.shell.emulateMedia({ colorScheme });
      expect(await violations(first.shell), `pairing (${colorScheme})`).toEqual([]);
    }
    await dialog.getByLabel('Kopplungscode').fill(s.code());
    await dialog.getByLabel('Kopplungscode').press('Enter');
    await expect(dialog).toBeHidden();

    await expect(nav.getByRole('button', { name: 'Server Testserver: verbunden' })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await first.shell.emulateMedia({ colorScheme });
      expect(await violations(first.shell), `sidebar (${colorScheme})`).toEqual([]);
    }
    await nav.getByRole('button', { name: 'Agents (Testserver)' }).click();
    const bay = await bayPage(first.app, 'agents/dist/ui');
    // A server has no folder dialog: the path form, one wrong input per run, happy path last.
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    const form = bay.getByRole('form', { name: 'Projekt hinzufügen' });
    const path = form.getByRole('textbox', { name: 'Pfad auf Testserver' });
    await expect(path).toBeFocused();
    const plain = join(dirname(repo), 'plain');
    mkdirSync(plain);
    const outside = mkdtempSync(join(tmpdir(), 'hangar-e2e-outside-'));
    for (const [value, message, submit] of [
      ['', 'Pfad eingeben', 'click'],
      [outside, `Ordner außerhalb der erlaubten Wurzeln (--root): ${outside}`, 'click'],
      [plain, `Kein Git-Repository: ${realpathSync(plain)}`, 'click'],
      [
        join(dirname(repo), 'nope'),
        `Ordner nicht gefunden: ${join(dirname(repo), 'nope')}`,
        'Enter',
      ],
    ] as const) {
      await path.fill(value);
      if (submit === 'Enter') await path.press('Enter');
      else await form.getByRole('button', { name: 'Hinzufügen' }).click();
      await expect(form.getByRole('alert')).toHaveText(message, { useInnerText: true });
      await expect(path).toHaveAttribute('aria-invalid', 'true');
      await expect(path).toHaveValue(value);
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `path form (${colorScheme})`).toEqual([]);
    }
    await path.fill(repo);
    await path.press('Enter');
    await expect(form).toBeHidden();
    await bay.getByRole('button', { name: 'Neue Session in remote-shop' }).click();
    const terminal = bay.locator('.xterm-rows');
    await expect(terminal).toBeVisible();
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('echo "remote-$((40+2))" && pwd -P\n');
    await expect(terminal).toContainText('remote-42');
    // The shell starts in the project folder on the server (ADR 0022).
    await expect(terminal).toContainText(realpathSync(repo));

    // A sensitive call on the server asks here, naming the server; "Ablehnen" counts there.
    await answerDialog(first.app, 'Ablehnen');
    await bay.keyboard.type(curl('secret.read'));
    await expect(terminal).toContainText('secret.read:denied');
    expect(
      await first.app.evaluate(
        () => (globalThis as { __hangarDialogs?: string[] }).__hangarDialogs,
      ),
    ).toEqual([
      'Auf dem Server „Testserver“: Ein Agent in einer Session von „dev.hangar.agents“ möchte „dev.hangar.vault/secret.read“ aufrufen.',
    ]);
    expect(JSON.parse(readFileSync(join(s.data, 'permissions.json'), 'utf8'))).toMatchObject([
      { subject: 'dev.hangar.agents', target: 'dev.hangar.vault/secret.read', mode: 'deny' },
    ]);

    // Disconnect and connect again from the server menu.
    await clickMenu(first.app, 'Verbindung trennen');
    await nav.getByRole('button', { name: 'Server Testserver: verbunden' }).click();
    await expect(nav.getByRole('button', { name: 'Server Testserver: getrennt' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Agents (Testserver)' })).toHaveCount(0);
    await clickMenu(first.app, 'Verbinden');
    await nav.getByRole('button', { name: 'Server Testserver: getrennt' }).click();
    await expect(nav.getByRole('button', { name: 'Agents (Testserver)' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  } finally {
    await first.app.close();
  }

  // After a restart the desktop connects again and shows the server's session.
  const second = await launch({
    userData: first.userData,
    bayDirs: [repoBays, vaultBays],
    env,
    seedBays: false,
  });
  try {
    const nav = second.shell.getByRole('navigation', { name: 'Bays' });
    await expect(nav.getByRole('button', { name: 'Server Testserver: verbunden' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Agents (Testserver)' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const bay = await bayPage(second.app, 'agents/dist/ui');
    await expect(bay.locator('.xterm-rows')).toContainText('remote-42');
  } finally {
    await second.app.close();
  }
});

test('pairs over SSH by keyboard alone and stays usable at 200 % zoom (ADR 0019)', async () => {
  const s = await startHangarServer(tmpdir());
  server = s;
  const port = s.address.split(':')[1];
  // Forwards like `ssh -L`, without an SSH server (packages/bridge/fixtures).
  const fakeSsh = join(__dirname, '../../../packages/bridge/fixtures/fake-ssh.mjs');
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    env: { ...agentsEnv(), HANGAR_SSH: fakeSsh },
    seedBays: false,
  });
  const focused = () =>
    shell.evaluate(
      () =>
        document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent,
    );
  const tabTo = async (name: string) => {
    for (let i = 0; i < 10 && (await focused()) !== name; i++) await shell.keyboard.press('Tab');
    expect(await focused()).toBe(name);
    const outline = await shell.evaluate(
      () => getComputedStyle(document.activeElement!).outlineStyle,
    );
    expect(outline, `visible focus on ${name}`).not.toBe('none');
  };
  try {
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    await tabTo('Zur Leiste hinzufügen');
    await shell.keyboard.press('Enter');
    await tabTo('Mit Server verbinden');
    await shell.keyboard.press('Enter');
    const dialog = shell.getByRole('dialog', { name: 'Mit Server verbinden' });
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await shell.keyboard.type('Testserver');
    await shell.keyboard.press('Tab');
    await expect(dialog.getByLabel('Adresse')).toBeFocused();
    await shell.keyboard.type(`anna@heimserver:${port}`);
    await shell.keyboard.press('Enter');
    await expect(dialog).toContainText(s.fingerprint);
    await expect(dialog.getByLabel('Kopplungscode')).toBeFocused();
    await shell.keyboard.type(s.code());
    await shell.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(nav.getByRole('button', { name: 'Server Testserver: verbunden' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Agents (Testserver)' })).toBeVisible();

    // The server menu opens from the keyboard too.
    await clickMenu(app, 'Verbindung trennen');
    await tabTo('Server Testserver: verbunden');
    await shell.keyboard.press('Enter');
    await expect(nav.getByRole('button', { name: 'Server Testserver: getrennt' })).toBeVisible();
    await clickMenu(app, 'Verbinden');
    await shell.keyboard.press('Enter');
    await expect(nav.getByRole('button', { name: 'Server Testserver: verbunden' })).toBeVisible();

    // 200 % zoom: sidebar and pairing dialog keep every control reachable, no sideways scroll.
    const width = await shell.evaluate(() => innerWidth);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await shell.waitForFunction((w) => innerWidth <= w / 2 + 1, width);
    for (const name of [
      'Server Testserver: verbunden',
      'Agents (Testserver)',
      'Zur Leiste hinzufügen',
    ]) {
      const button = nav.getByRole('button', { name });
      await button.scrollIntoViewIfNeeded();
      await expect(button, name).toBeInViewport();
    }
    await nav.getByRole('button', { name: 'Zur Leiste hinzufügen' }).click();
    await shell.getByRole('button', { name: 'Mit Server verbinden' }).click();
    for (const control of [
      dialog.getByLabel('Name'),
      dialog.getByLabel('Adresse'),
      dialog.getByRole('button', { name: 'Weiter' }),
      dialog.getByRole('button', { name: 'Abbrechen' }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }
    const overflow = await shell.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
  } finally {
    await app.close();
  }
});

test('a job that runs while the desktop is away notifies, badges and shows its result after connecting (phase 11c, 11d)', async () => {
  // The job waits for the next full minute (cron), so this test may take up to two.
  test.setTimeout(180_000);
  const repo = createRepo('remote-jobs');
  const s = await startHangarServer(dirname(repo));
  server = s;
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv(), seedBays: false });
  try {
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    await nav.getByRole('button', { name: 'Zur Leiste hinzufügen' }).click();
    const dialog = shell.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Mit Server verbinden' }).click();
    await dialog.getByLabel('Name').fill('Testserver');
    await dialog.getByLabel('Adresse').fill(s.address);
    await dialog.getByLabel('Adresse').press('Enter');
    await dialog.getByLabel('Kopplungscode').fill(s.code());
    await dialog.getByLabel('Kopplungscode').press('Enter');
    await nav.getByRole('button', { name: 'Agents (Testserver)' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    const path = bay.getByRole('textbox', { name: 'Pfad auf Testserver' });
    await path.fill(repo);
    await path.press('Enter');
    await bay.getByRole('button', { name: 'Neue Session in remote-jobs' }).click();
    await bay.getByRole('button', { name: 'Job planen' }).click();
    const form = bay.getByRole('form', { name: 'Job planen' });
    await form.getByRole('textbox', { name: 'Befehl' }).fill('hangar status waiting');
    await form.getByRole('textbox', { name: 'Zeitplan (Cron)' }).fill('* * * * *');
    await form.getByRole('button', { name: 'Job anlegen' }).click();
    await expect(form).toBeHidden();

    await clickMenu(app, 'Verbindung trennen');
    await nav.getByRole('button', { name: 'Server Testserver: verbunden' }).click();
    await expect(nav.getByRole('button', { name: 'Server Testserver: getrennt' })).toBeVisible();
    // The job runs on the server while this desktop is away.
    const jobsFile = join(s.data, 'jobs.json');
    await expect
      .poll(
        () => (JSON.parse(readFileSync(jobsFile, 'utf8')) as { lastRun?: unknown }[])[0]?.lastRun,
        {
          timeout: 90_000,
        },
      )
      .toMatchObject({ ok: true });
    expect(await app.evaluate(() => globalThis.__hangarNotifications ?? [])).toEqual([]);

    await clickMenu(app, 'Verbinden');
    await nav.getByRole('button', { name: 'Server Testserver: getrennt' }).click();
    await expect(shell.locator('[data-testid^="badge-remote:"]')).toHaveText('1');
    expect(
      await app.evaluate(() =>
        (globalThis.__hangarNotifications ?? []).map(({ bayId, title, body }) => ({
          bayId,
          title,
          body,
        })),
      ),
    ).toEqual([
      {
        bayId: expect.stringMatching(/^remote:\w+:dev\.hangar\.agents$/),
        // In the desktop's language, named after the server (ADR 0019).
        title: 'Testserver: Session wartet auf Eingabe',
        body: expect.stringContaining('remote-jobs: '),
      },
    ]);
    expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(1);

    // The result is in the settings, under the server (phase 11d).
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(shell.getByRole('heading', { name: 'Auf diesem Rechner' })).toBeVisible();
    const jobs = shell.getByRole('table', { name: 'Auf dem Server „Testserver“' });
    const row = jobs.getByRole('row', { name: /hangar status waiting/ });
    await expect(row).toContainText('Agents');
    await expect(row).toContainText('erfolgreich');
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `server jobs (${colorScheme})`).toEqual([]);
    }
    // Keyboard: Tab reaches every action of the row.
    await row.getByRole('button', { name: 'Pausieren' }).focus();
    await shell.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Jetzt ausführen' })).toBeFocused();
    await shell.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Löschen' })).toBeFocused();
    // 200 % zoom: no horizontal page overflow.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await row.scrollIntoViewIfNeeded();
    const overflow = await shell.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1);
    });

    // Actions go to the server; its change reloads the list here.
    await row.getByRole('button', { name: 'Pausieren' }).click();
    await expect(row).toContainText('pausiert');
    expect(JSON.parse(readFileSync(jobsFile, 'utf8'))[0]).toMatchObject({ paused: true });
    await row.getByRole('button', { name: 'Jetzt ausführen' }).click();
    await expect(row).not.toContainText('läuft');
    await row.getByRole('button', { name: 'Löschen' }).click();
    await expect(shell.getByText('Keine Jobs.')).toHaveCount(2);
    expect(JSON.parse(readFileSync(jobsFile, 'utf8'))).toEqual([]);

    // Disconnected, the server's group goes away.
    await clickMenu(app, 'Verbindung trennen');
    await nav.getByRole('button', { name: 'Server Testserver: verbunden' }).click();
    await expect(shell.getByRole('heading', { name: 'Auf dem Server „Testserver“' })).toHaveCount(
      0,
    );
    await expect(shell.getByText(/Noch keine Jobs/)).toBeVisible();
  } finally {
    await app.close();
  }
});
