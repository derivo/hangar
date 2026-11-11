import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  violations,
} from './helpers';

test('shell, settings, agent bay and board have no WCAG 2.2 AA violations in light and dark', async () => {
  const repo = createRepo('a11y');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in a11y' }).click();
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(
      'hangar statusbar set modell opus --type text && hangar statusbar set wt "$PWD" --type path' +
        ' && hangar statusbar set k 3 --type bar --max 10 && hangar statusbar set pr offen --type badge' +
        ' && hangar status waiting\n',
    );
    await expect(bay.getByRole('group', { name: 'Statusleiste' }).locator('.segment')).toHaveCount(
      4,
    );
    await bay.getByRole('combobox', { name: 'Farbe' }).selectOption('yellow');
    await bay.getByRole('button', { name: 'Umgebungsvariablen' }).click();

    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `agents bay (${colorScheme})`).toEqual([]);
      expect(await violations(shell), `shell (${colorScheme})`).toEqual([]);
      await shell.getByRole('button', { name: 'Einstellungen' }).click();
      expect(await violations(shell), `settings (${colorScheme})`).toEqual([]);
      await shell.getByRole('button', { name: /^Agents/ }).click();
    }

    await shell.getByRole('button', { name: 'Board' }).click();
    const board = await bayPage(app, 'board/dist/ui');
    await board.getByRole('button', { name: 'Aufgabe hinzufügen' }).click();
    const form = board.getByRole('form', { name: 'Neue Aufgabe' });
    await form.getByLabel('Titel').fill('Login testen');
    await form.getByLabel('Titel').press('Enter');
    await expect(board.getByRole('region', { name: 'Offen' })).toContainText('Login testen');
    for (const colorScheme of ['light', 'dark'] as const) {
      await board.emulateMedia({ colorScheme });
      expect(await violations(board), `board (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});

test('the pages of the local server without violations: down, starting, new version, switch (ADR 0036)', async () => {
  // Without the variable the switch is not locked; off by setting, or the packaged app would
  // start the server (its default).
  const userData = mkdtempSync(join(tmpdir(), 'hangar-e2e-'));
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ bays: ['dev.hangar.agents', 'dev.hangar.browser'], localServer: false }),
  );
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    userData,
    env: { ...agentsEnv(), HANGAR_LOCAL_SERVER: '' },
  });
  try {
    // Pushed like the host does; a real down server needs a LaunchAgent (local-server.spec.ts).
    const show = async (localServer: unknown) => {
      const state = await shell.evaluate(() => window.hangarShell.getState());
      const key = 'remote:loc:dev.hangar.agents';
      await app.evaluate(
        ({ BrowserWindow }, s) => {
          BrowserWindow.getAllWindows()[0]!.webContents.send('shell:state', s);
        },
        {
          ...state,
          selected: key,
          localServer: {
            ...(localServer as object),
            bays: [{ id: key, name: 'Agents', icon: state.bays[0]!.icon, badge: 0 }],
          },
        },
      );
    };
    const content = shell.getByRole('main');
    const pages = [
      [
        { status: 'failed', error: 'Cannot reach ws://127.0.0.1:1/connect' },
        'Lokaler Server läuft nicht',
      ],
      [{ status: 'connecting' }, 'Lokaler Server startet …'],
      [
        {
          status: 'connecting',
          retry: 3,
          log: ['listening on 127.0.0.1:4711', `fingerprint SHA256:${'x'.repeat(200)}`],
        },
        'Lokaler Server startet …',
      ],
      [
        {
          status: 'connected',
          update: { running: '0.1.0', ready: '0.2.0' },
          restarting: true,
        },
        undefined,
      ],
      [{ status: 'connected', update: { running: '0.1.0', ready: '0.2.0' } }, undefined],
    ] as const;
    for (const [localServer, heading] of pages) {
      // The host may still push its own state while bays start; push again until ours shows.
      await expect(async () => {
        await show(localServer);
        await expect(
          heading
            ? content.getByRole('heading', { name: heading })
            : content.getByRole('region', { name: 'Neue Version' }),
        ).toBeVisible({ timeout: 1000 });
      }).toPass();
      for (const colorScheme of ['light', 'dark'] as const) {
        await shell.emulateMedia({ colorScheme });
        expect(await violations(shell), `${localServer.status} (${colorScheme})`).toEqual([]);
      }
    }
    // At 200 % zoom the hint wraps its text instead of cutting it off.
    const hint = content.getByRole('region', { name: 'Neue Version' });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2),
    );
    await expect
      .poll(() => hint.locator('p').evaluate((p) => p.scrollWidth - p.clientWidth))
      .toBeLessThanOrEqual(0);
    expect((await hint.boundingBox())!.height).toBeGreaterThan(48);
    await expect(hint.getByRole('button', { name: 'Lokalen Server neu starten' })).toBeInViewport();
    // The log of the restart page wraps long lines at 200 % zoom too.
    await expect(async () => {
      await show({
        status: 'connecting',
        retry: 3,
        log: [`fingerprint SHA256:${'x'.repeat(200)}`],
      });
      await expect(content.getByRole('log')).toBeVisible({ timeout: 1000 });
    }).toPass();
    await expect
      .poll(() => content.getByRole('log').evaluate((l) => l.scrollWidth - l.clientWidth))
      .toBeLessThanOrEqual(0);
    expect(
      await shell.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
    );
    // The log takes the whole width of its page; only the text keeps a readable measure
    // (60ch), so the window is wider than that.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 900));
    await expect
      .poll(() =>
        content.getByRole('log').evaluate((l) => {
          const page = l.closest('section')!;
          const style = getComputedStyle(page);
          const inner =
            page.parentElement!.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight);
          return Math.round(l.getBoundingClientRect().width - inner);
        }),
      )
      .toBe(0);
    const text = await content.locator('.local-server-down p').first().boundingBox();
    expect(text!.width).toBeLessThan((await content.getByRole('log').boundingBox())!.width / 2);
    // The log paused (WCAG 2.2.2): the pressed button without violations too.
    const pause = content.getByRole('button', { name: 'Log anhalten' });
    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `log paused (${colorScheme})`).toEqual([]);
    }
    // The switch in the settings, with the hint of a pending change (step 4b; macOS only).
    if (process.platform !== 'darwin') return;
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    await shell.getByRole('checkbox', { name: 'Agents im lokalen Server ausführen' }).check();
    await expect(shell.getByRole('button', { name: 'Hangar neu starten' })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `switch (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});

test('agent bay states without violations: empty tree, error message, ended shell', async () => {
  const repo = createRepo('states');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    const check = async (state: string) => {
      for (const colorScheme of ['light', 'dark'] as const) {
        await bay.emulateMedia({ colorScheme });
        expect(await violations(bay), `${state} (${colorScheme})`).toEqual([]);
      }
    };

    await expect(bay.getByText('Noch kein Projekt.', { exact: false })).toBeVisible();
    await check('empty tree');

    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in states' }).click();
    await bay.getByRole('button', { name: 'Umgebungsvariablen' }).click();
    await bay.getByRole('textbox', { name: /Umgebungsvariablen/ }).fill('HANGAR_X=1');
    await bay.getByRole('button', { name: 'Speichern und Shell neu starten' }).click();
    await expect(bay.getByRole('alert')).toBeVisible();
    await check('error message');
    await bay.getByRole('button', { name: 'Meldung schließen' }).click();
    await bay.getByRole('button', { name: 'Abbrechen' }).click();

    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('exit\n');
    await expect(bay.getByRole('status')).toContainText('Shell beendet.');
    await check('ended shell');
  } finally {
    await app.close();
  }
});

test('the agent bay reflows at 200 % zoom without hiding content', async () => {
  const repo = createRepo('zoom');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in zoom' }).click();
    const width = await bay.evaluate(() => innerWidth);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await bay.waitForFunction((w) => innerWidth <= w / 2 + 1, width);
    for (const name of [
      'Projekt hinzufügen',
      'Umgebungsvariablen',
      'Session schließen',
      'Neue Session in zoom',
    ]) {
      const button = bay.getByRole('button', { name });
      await button.scrollIntoViewIfNeeded();
      await expect(button, name).toBeInViewport();
    }
    const overflow = await bay.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
    // The context menu of a session stays inside the window; its last entry is reachable.
    await bay.locator('.tree-session').first().click({ button: 'right' });
    const size = await bay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const box = (await bay.getByRole('menu').boundingBox())!;
    expect(box.y + box.height, 'menu bottom').toBeLessThanOrEqual(size.height);
    expect(box.x + box.width, 'menu right').toBeLessThanOrEqual(size.width);
    await bay.keyboard.press('End');
    await expect(bay.getByRole('menuitem', { name: 'Session schließen…' })).toBeInViewport();
  } finally {
    await app.close();
  }
});
