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

test('the hangar CLI in a session shell updates the session in the UI', async () => {
  const repo = createRepo('api');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in api' }).click();

    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('hangar describe "Login reparieren" && hangar status waiting\n');

    await expect(bay.getByRole('textbox', { name: 'Beschreibung' })).toHaveValue(
      'Login reparieren',
    );
    await expect(bay.locator('.pane-status')).toHaveText('wartet auf Eingabe');
    await expect(bay.getByRole('navigation', { name: 'Projekte und Sessions' })).toContainText(
      'Login reparieren',
    );
  } finally {
    await app.close();
  }
});
