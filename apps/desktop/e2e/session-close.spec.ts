import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

test('closing a session or removing the project leaves the project folder and its files', async () => {
  const repo = createRepo('close');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    bay.on('dialog', (dialog) => void dialog.accept());
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in close' }).click();
    await expect(bay.getByTestId(/^session-/)).toHaveCount(1);

    // ADR 0022: the session works in the project folder itself.
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('echo x > dirty.txt\n');
    await expect.poll(() => existsSync(join(repo, 'dirty.txt'))).toBe(true);
    await bay.getByRole('button', { name: 'Session schließen' }).click();
    await expect(bay.getByTestId(/^session-/)).toHaveCount(0);
    expect(existsSync(join(repo, 'dirty.txt'))).toBe(true);

    await bay.getByRole('button', { name: 'Neue Session in close' }).click();
    await expect(bay.getByTestId(/^session-/)).toHaveCount(1);
    await bay.getByRole('button', { name: /^close/ }).click();
    await bay.getByRole('button', { name: 'Projekt entfernen' }).click();
    await expect(bay.getByText('Noch kein Projekt.')).toBeVisible();
    expect(existsSync(join(repo, 'dirty.txt'))).toBe(true);
    await expect(bay.getByRole('alert')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
