import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, bayPage, createRepo, launch, mockFolderPicker, repoBays } from './helpers';

test.skip(!existsSync('/bin/zsh'), 'needs zsh');

test('a zsh session shows the prompt from the settings, empty keeps the own one (ADR 0025)', async () => {
  const repo = createRepo('prompt');
  const home = mkdtempSync(join(tmpdir(), 'hangar-e2e-home-'));
  writeFileSync(join(home, '.zshrc'), 'PROMPT="own-prompt> "\n');
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    env: { SHELL: '/bin/zsh', HOME: home },
  });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    const newSession = bay.getByRole('button', { name: 'Neue Session in prompt' });
    const rows = bay.locator('.xterm-rows');

    // Default: folder and git branch.
    await newSession.click();
    await expect(rows).toContainText(/prompt \(main\) %/);

    const setPrompt = async (value: string) => {
      await shell.getByRole('button', { name: 'Einstellungen' }).click();
      await shell.getByRole('textbox', { name: 'Prompt der zsh in Sessions' }).fill(value);
      await shell.getByRole('button', { name: /^Agents/ }).click();
    };

    await setPrompt('eigener-%1~ %# ');
    await newSession.click();
    await expect(rows).toContainText('eigener-prompt %');

    await setPrompt('');
    await newSession.click();
    await expect(rows).toContainText('own-prompt>');
  } finally {
    await app.close();
  }
});
