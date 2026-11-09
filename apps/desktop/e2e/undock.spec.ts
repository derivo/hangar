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

test('a session undocks into its own window, survives a restart and docks back', async () => {
  const repo = createRepo('undock');
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env });
  try {
    await first.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(first.app, 'agents/dist/ui/index.html');
    await mockFolderPicker(first.app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in undock' }).click();
    const branch = await bay
      .getByRole('textbox', { name: 'Beschreibung' })
      .getAttribute('placeholder');

    await bay.getByRole('button', { name: 'Abdocken' }).click();
    const own = await bayPage(first.app, 'index.html?window=');
    await expect(own.getByRole('region', { name: `Session ${branch}` })).toBeVisible();
    expect(
      await first.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.getTitle()),
      ),
    ).toContain(`${branch} – undock`);
    await expect(bay.getByText(`„${branch}“ ist abgedockt`)).toBeVisible();
    await expect(bay.getByRole('region', { name: /^Session/ })).toHaveCount(0);

    await own.locator('.xterm-helper-textarea').focus();
    await own.keyboard.type('echo UNDOCK$((1+1))\n');
    await expect(own.locator('.xterm-rows')).toContainText('UNDOCK2');
    for (const colorScheme of ['light', 'dark'] as const) {
      await own.emulateMedia({ colorScheme });
      expect(await violations(own), `own window (${colorScheme})`).toEqual([]);
    }
  } finally {
    await first.app.close();
  }

  // The window is reopened after a restart, with the session's output.
  const second = await launch({ bayDirs: [repoBays], env, userData: first.userData });
  try {
    const own = await bayPage(second.app, 'index.html?window=');
    await expect(own.locator('.xterm-rows')).toContainText('UNDOCK2');
    await own.getByRole('button', { name: 'Andocken' }).click();
    await second.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(second.app, 'agents/dist/ui/index.html');
    await expect(bay.getByRole('region', { name: /^Session/ })).toBeVisible();
    await expect(bay.locator('.xterm-rows')).toContainText('UNDOCK2');
    expect(
      await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(1);
  } finally {
    await second.app.close();
  }
});
