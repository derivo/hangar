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

const recorded = (app: Awaited<ReturnType<typeof launch>>['app']) =>
  app.evaluate(() =>
    (globalThis.__hangarNotifications ?? []).map(({ bayId, title, body }) => ({
      bayId,
      title,
      body,
    })),
  );

test('waiting notifies and badges; the status bar shows all four segment types', async () => {
  const repo = createRepo('web');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in web' }).click();

    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(
      [
        'hangar statusbar set modell opus --type text',
        'hangar statusbar set ordner "$PWD" --type path',
        'hangar statusbar set kontingent 42 --type bar --max 100',
        'hangar statusbar set pr offen --type badge',
        'hangar describe "Checkout bauen"',
      ].join(' && ') + '\n',
    );
    const statusbar = bay.getByRole('group', { name: 'Statusleiste' });
    await expect(statusbar).toContainText('opus');
    await expect(statusbar.getByTitle(/\/web$/)).toBeVisible();
    await expect(statusbar.getByRole('meter', { name: 'kontingent' })).toHaveAttribute(
      'aria-valuenow',
      '42',
    );
    await expect(statusbar).toContainText('42 / 100');
    await expect(statusbar.locator('.segment-badge')).toHaveText('offen');
    expect(await recorded(app)).toEqual([]);

    await bay.keyboard.type('hangar status waiting\n');
    await expect(shell.getByTestId('badge-dev.hangar.agents')).toHaveText('1');
    await expect(shell.getByRole('button', { name: 'Agents, 1 Hinweis' })).toBeVisible();
    expect(await recorded(app)).toEqual([
      {
        bayId: 'dev.hangar.agents',
        title: 'Session wartet auf Eingabe',
        body: 'web: Checkout bauen',
      },
    ]);
    if (process.platform === 'darwin') {
      expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(1);
    }

    // Clicking the notification brings the bay back to the front.
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    ).toBe(false);
    await app.evaluate(() => globalThis.__hangarNotifications![0]!.click());
    await expect(shell.getByRole('button', { name: 'Agents, 1 Hinweis' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    ).toBe(true);

    await bay.keyboard.type('hangar status working\n');
    await expect(shell.getByTestId('badge-dev.hangar.agents')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the settings check notifications and open the place to switch them on (ADR 0044)', async () => {
  const { app, shell } = await launch({ bayDirs: [repoBays] });
  try {
    await app.evaluate(({ shell }) => {
      (globalThis as { __opened?: string[] }).__opened = [];
      shell.openExternal = (async (url: string) =>
        void (globalThis as { __opened?: string[] }).__opened!.push(url)) as never;
    });
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(shell.getByRole('heading', { name: 'Mitteilungen' })).toBeVisible();

    // Keyboard: focus the button and press Enter.
    const test = shell.getByRole('button', { name: 'Testmitteilung senden' });
    await test.focus();
    await expect(test).toBeFocused();
    await shell.keyboard.press('Enter');
    await expect(shell.getByTestId('notification-answer')).toHaveText(
      /^Das System hat die Testmitteilung angenommen\./,
    );
    expect(await recorded(app)).toEqual([
      { bayId: '', title: 'Hangar: Testmitteilung', body: 'Mitteilungen von Hangar kommen an.' },
    ]);

    const page = {
      darwin: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
      win32: 'ms-settings:notifications',
    }[process.platform as string];
    const open = shell.getByRole('button', { name: 'Mitteilungen im System einschalten' });
    if (page) {
      await open.click();
      await expect
        .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
        .toEqual([page]);
    } else await expect(open).toHaveCount(0);

    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `notifications (${colorScheme})`).toEqual([]);
    }
    // 200 % zoom: no horizontal overflow.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2),
    );
    expect(
      await shell.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
