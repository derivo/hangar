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

test('a session hands work over to a new session, which shows and reads it (ADR 0031)', async () => {
  const repo = createRepo('shop');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in shop' }).click();
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(
      'hangar describe "Login bauen" && hangar handover create Tests schreiben --context "Formular steht"\n',
    );
    await expect(bay.locator('.xterm-rows')).toContainText('Handed over to the new session');

    // The new session starts in its own worktree and shows the handover above its terminal.
    const tree = bay.getByRole('navigation', { name: 'Projekte und Sessions' });
    await tree.getByRole('button', { name: /hangar\// }).click();
    const handover = bay.getByRole('region', { name: 'Übergabe von Login bauen' });
    await expect(handover).toContainText('AuftragTests schreiben');
    await expect(handover).toContainText('KontextFormular steht');
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `handover (${colorScheme})`).toEqual([]);
    }

    // The agent in it reads the handover with `hangar handover` (the shell speaks English).
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('hangar handover\n');
    await expect(bay.locator('.xterm-rows')).toContainText('Task: Tests schreiben');

    // At 200 % the handover wraps instead of pushing the page sideways.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await expect(handover).toBeVisible();
    const overflow = await bay.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await app.close();
  }
});
