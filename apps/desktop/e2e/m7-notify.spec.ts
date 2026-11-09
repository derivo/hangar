import {
  expect,
  test,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
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
