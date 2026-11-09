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

test('selecting text in a session terminal copies it to the clipboard on release', async () => {
  const repo = createRepo('kopie');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in kopie' }).click();
    await app.evaluate(({ clipboard }) => clipboard.writeText('vorher'));
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('echo kopier$((1+1))test\n');
    const line = bay.locator('.xterm-rows > div').filter({ hasText: /^kopier2test\s*$/ });
    await expect(line).toHaveCount(1);

    // Double-click selects the word; xterm's screen lies over the rows, so click by position.
    const box = (await line.boundingBox())!;
    await bay.mouse.dblclick(box.x + 20, box.y + box.height / 2);
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('kopier2test');

    // A brief notice says so, then goes away.
    const note = bay.getByRole('status').filter({ hasText: 'In die Zwischenablage kopiert' });
    await expect(note).toBeVisible();
    await expect(note).toBeHidden({ timeout: 3000 });
    // Shown again for axe, which needs longer than the notice stays.
    await bay
      .locator('.copy-note')
      .evaluate((n) => (n.textContent = 'In die Zwischenablage kopiert'));
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `copy notice (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});

test('the header switch turns copying off for that session', async () => {
  const repo = createRepo('schalter');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in schalter' }).click();
    const toggle = bay.getByRole('checkbox', { name: 'Markieren kopiert' });
    await expect(toggle).toBeChecked();
    await toggle.focus();
    await bay.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();

    await app.evaluate(({ clipboard }) => clipboard.writeText('vorher'));
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('echo aus$((1+1))test\n');
    const line = bay.locator('.xterm-rows > div').filter({ hasText: /^aus2test\s*$/ });
    await expect(line).toHaveCount(1);
    const box = (await line.boundingBox())!;
    await bay.mouse.dblclick(box.x + 15, box.y + box.height / 2);
    await bay.waitForTimeout(500);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('vorher');
  } finally {
    await app.close();
  }
});

test('the default in the settings applies to new sessions, which start in the project folder', async () => {
  const repo = createRepo('standard');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    const setting = shell.getByRole('checkbox', {
      name: 'Markieren kopiert in die Zwischenablage',
    });
    await expect(setting).toBeChecked();
    await setting.uncheck();
    await expect(setting).not.toBeChecked();

    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in standard' }).click();
    await expect(bay.getByRole('checkbox', { name: 'Markieren kopiert' })).not.toBeChecked();

    // The shell starts in the project itself, not in a worktree of Hangar.
    await bay.locator('.xterm-helper-textarea').focus();
    // Compared in the shell: the long temporary path wraps across terminal rows.
    const real = (await import('node:fs')).realpathSync(repo);
    await bay.keyboard.type(`test "$(pwd -P)" = '${real}' && echo in-pro''ject\n`);
    await expect(
      bay.locator('.xterm-rows > div').filter({ hasText: /^in-project\s*$/ }),
    ).not.toHaveCount(0);
  } finally {
    await app.close();
  }
});
