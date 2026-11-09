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

test('a tab color picked with the keyboard survives a restart', async () => {
  const repo = createRepo('farben');
  const env = agentsEnv();

  const first = await launch({ bayDirs: [repoBays], env });
  let bay;
  try {
    await first.shell.getByRole('button', { name: 'Agents' }).click();
    bay = await bayPage(first.app, 'agents/dist/ui');
    await mockFolderPicker(first.app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in farben' }).click();
    const select = bay.getByRole('combobox', { name: 'Farbe' });
    await expect(select).toHaveValue('');

    // Reachable with Tab from the description; type-ahead picks an option without a popup.
    await bay.getByRole('textbox', { name: 'Beschreibung' }).focus();
    for (
      let i = 0;
      i < 10 && !(await select.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await bay.keyboard.press('Tab');
    }
    await expect(select).toBeFocused();
    await bay.keyboard.type('v');
    await expect(select).toHaveValue('violet');
    await expect(bay.locator('.tree-session[data-color="violet"]')).toHaveCount(1);
  } finally {
    await first.app.close();
  }

  const second = await launch({ bayDirs: [repoBays], env, userData: first.userData });
  try {
    await second.shell.getByRole('button', { name: 'Agents' }).click();
    bay = await bayPage(second.app, 'agents/dist/ui');
    const tab = bay.locator('.tree-session[data-color="violet"]');
    await expect(tab).toHaveCount(1);
    await tab.click();
    await expect(bay.getByRole('combobox', { name: 'Farbe' })).toHaveValue('violet');
  } finally {
    await second.app.close();
  }
});
