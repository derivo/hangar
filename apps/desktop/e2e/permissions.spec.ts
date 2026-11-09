import {
  expect,
  test,
  agentsEnv,
  answerDialog,
  bayPage,
  createRepo,
  curl,
  launch,
  mockFolderPicker,
  repoBays,
  vaultBays,
  violations,
} from './helpers';

test('grants from an agent session show up by caller, with the session name, and can be changed', async () => {
  const repo = createRepo('rechte');
  const { app, shell } = await launch({ bayDirs: [repoBays, vaultBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in rechte' }).click();
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('hangar describe "Login reparieren"\n');
    await expect(bay.getByRole('textbox', { name: 'Beschreibung' })).toHaveValue(
      'Login reparieren',
    );

    await answerDialog(app, 'Für diese Session');
    await bay.keyboard.type(curl('secret.read'));
    await expect(bay.locator('.xterm-rows')).toContainText('secret.read:ok');
    await answerDialog(app, 'Erlauben');
    await bay.keyboard.type(curl('entry.count'));
    await expect(bay.locator('.xterm-rows')).toContainText('entry.count:ok');

    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    const agents = shell.getByRole('table', { name: 'Agents' });
    const secret = agents.getByRole('row', { name: /secret\.read/ });
    await expect(secret).toContainText('nur Session „Login reparieren“');
    await expect(secret).toContainText('Reads a secret');
    const count = agents.getByRole('row', { name: /entry\.count/ });
    await expect(count.getByRole('combobox')).toHaveValue('allow');
    await expect(count).not.toContainText('seit dem Start nicht');

    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `permissions (${colorScheme})`).toEqual([]);
    }

    // Keyboard: Tab runs from the search through every row to the rule form.
    await shell.getByRole('searchbox', { name: 'Funktion suchen' }).focus();
    const stops: string[] = [];
    for (let i = 0; i < 12 && stops.at(-1) !== 'Festlegen'; i++) {
      await shell.keyboard.press('Tab');
      stops.push(
        await shell.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '';
        }),
      );
    }
    expect(stops.filter((s) => s === 'Widerrufen')).toHaveLength(2);
    expect(stops.at(-1)).toBe('Festlegen');

    // 200 % zoom: no horizontal page overflow, the rule form stays reachable.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    const setRule = shell.getByRole('button', { name: 'Festlegen' });
    await setRule.scrollIntoViewIfNeeded();
    await expect(setRule).toBeInViewport();
    const overflow = await shell.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1);
    });

    await count.getByRole('combobox').selectOption('deny');
    await expect(count.getByRole('combobox')).toHaveValue('deny');
    await shell.getByRole('button', { name: /^Agents/ }).click();
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(curl('entry.count'));
    await expect(bay.locator('.xterm-rows')).toContainText('entry.count:denied');
  } finally {
    await app.close();
  }
});
