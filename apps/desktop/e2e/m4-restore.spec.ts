import { realpathSync } from 'node:fs';
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

test('restart restores the session in its project folder with scrollback', async () => {
  const repo = createRepo('blog');
  const env = agentsEnv();

  const first = await launch({ bayDirs: [repoBays], env });
  await first.shell.getByRole('button', { name: 'Agents' }).click();
  let bay = await bayPage(first.app, 'agents/dist/ui');
  await mockFolderPicker(first.app, repo);
  await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
  await bay.getByRole('button', { name: 'Neue Session in blog' }).click();
  await bay.getByRole('textbox', { name: 'Beschreibung' }).fill('Artikel schreiben');
  await bay.getByRole('textbox', { name: 'Beschreibung' }).press('Enter');
  await bay.locator('.xterm-helper-textarea').focus();
  await bay.keyboard.type('echo "vor-dem-$((1+1))-neustart"\n');
  await expect(bay.locator('.xterm-rows')).toContainText('vor-dem-2-neustart');
  await first.app.close();

  const second = await launch({ bayDirs: [repoBays], env, userData: first.userData });
  try {
    await second.shell.getByRole('button', { name: 'Agents' }).click();
    bay = await bayPage(second.app, 'agents/dist/ui');
    await bay.getByRole('button', { name: 'Artikel schreiben' }).click();
    const terminal = bay.locator('.xterm-rows');
    await expect(terminal).toContainText('vor-dem-2-neustart');
    await expect(terminal).toContainText('Hangar neu gestartet');
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('pwd -P\n');
    await expect(terminal).toContainText(realpathSync(repo));
  } finally {
    await second.app.close();
  }
});
