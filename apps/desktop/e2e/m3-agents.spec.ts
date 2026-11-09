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

test('add a project, start a session and run a command in its shell', async () => {
  const repo = createRepo('shop');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');

    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in shop' }).click();

    const terminal = bay.locator('.xterm-rows');
    await expect(terminal).toBeVisible();
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(
      'echo "hangar-$((40+2))" && git rev-parse --abbrev-ref HEAD && pwd -P\n',
    );
    await expect(terminal).toContainText('hangar-42');
    // ADR 0022: the shell starts in the project folder, on its branch, without a worktree.
    await expect(terminal).toContainText('main');
    await expect(terminal).toContainText(realpathSync(repo));
  } finally {
    await app.close();
  }
});
