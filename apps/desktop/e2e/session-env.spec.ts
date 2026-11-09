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

// Error matrix for the environment editor: exactly one wrong line, the others valid.
const INVALID: [string, string][] = [
  ['OK=1\nFOO', 'Zeile ohne "=": FOO'],
  ['OK=1\n1X=a', 'Ungültiger Variablenname: 1X'],
  ['OK=1\nHANGAR_X=a', 'Variable ist reserviert: HANGAR_X'],
];

test('the environment editor rejects each invalid line, then restarts the shell with valid ones', async () => {
  const repo = createRepo('env');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in env' }).click();
    await bay.getByRole('button', { name: 'Umgebungsvariablen' }).click();
    const editor = bay.getByRole('textbox', { name: /Umgebungsvariablen/ });
    const save = bay.getByRole('button', { name: 'Speichern und Shell neu starten' });

    for (const [text, message] of INVALID) {
      await editor.fill(text);
      await save.click();
      await expect(bay.getByRole('alert')).toHaveText(message);
      await expect(editor).toHaveValue(text); // input is kept for correction
      await bay.getByRole('button', { name: 'Meldung schließen' }).click();
    }

    // Happy path last, submitted by keyboard: Tab from the editor to the button, Enter.
    await editor.fill('OK=1\nFOO=hangar-env');
    await editor.press('Tab');
    await expect(save).toBeFocused();
    await bay.keyboard.press('Enter');
    await expect(editor).toBeHidden();
    await expect(bay.getByRole('alert')).toHaveCount(0);

    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('echo "[$FOO]"\n');
    await expect(bay.locator('.xterm-rows')).toContainText('[hangar-env]');
  } finally {
    await app.close();
  }
});
