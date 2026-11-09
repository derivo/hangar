import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, launch, violations } from './helpers';

test('the Hangar mark opens an overview of the Hangar version, git identity and bays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-e2e-git-'));
  writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Ada Lovelace\n');
  const { app, shell } = await launch({ env: { GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') } });
  try {
    const version = await app.evaluate(({ app }) => app.getVersion());
    await shell.getByRole('button', { name: 'Hangar-Übersicht' }).click();
    await expect(shell.getByRole('heading', { name: 'Hangar-Übersicht' })).toBeVisible();
    await expect(shell.getByRole('list', { name: 'Version' })).toHaveText(`Hangar${version}`);
    const git = shell.getByRole('list', { name: 'Git' });
    await expect(git).toContainText('NameAda Lovelace');
    await expect(git).toContainText('E-Mailnicht gesetzt');
    await expect(shell.getByText('git config --global user.email "…"')).toBeVisible();
    await expect(shell.getByRole('row', { name: /Test-Bay/ })).toContainText('dev.hangar.test');
    await expect(shell.getByText(/^Kaputte Bay: /)).toBeVisible();

    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `overview (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});
