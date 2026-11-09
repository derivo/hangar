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
  violations,
} from './helpers';

test('the project overview shows git state, closes sessions and sets env for new sessions', async () => {
  const repo = createRepo('overview');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    bay.on('dialog', (dialog) => void dialog.accept());
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in overview' }).click();
    await expect(bay.getByTestId(/^session-/)).toHaveCount(1);
    await bay.getByRole('button', { name: 'Neue Session in overview' }).click();
    await expect(bay.getByTestId(/^session-/)).toHaveCount(2);
    const name = await bay
      .getByRole('textbox', { name: 'Beschreibung' })
      .getAttribute('placeholder');

    // Both sessions work in the project folder (ADR 0022): a file of one is a change of both.
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type("echo x > x.txt && echo writ''ten\n");
    // The overview reads git once; wait for the file (the quotes keep the typed line from matching).
    await expect(bay.locator('.xterm-rows')).toContainText('written');
    await bay.getByRole('button', { name: /^overview/ }).click();
    const table = bay.getByRole('table', { name: 'Sessions' });
    await expect(table.getByRole('row')).toHaveCount(3);
    const row = table.getByRole('row', { name: new RegExp(name!) });
    await expect(row.getByRole('cell').nth(1)).toHaveText('Projektordner');
    await expect(row.getByRole('cell').nth(3)).toHaveText('1 Datei');
    await bay.getByRole('button', { name: `Session ${name} schließen` }).click();
    await expect(table.getByRole('row')).toHaveCount(2);
    // Closing leaves the folder and its files alone; no branch is left behind.
    expect(existsSync(join(repo, 'x.txt'))).toBe(true);
    await expect(bay.getByText('Keine verwaisten Branches.')).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `project overview (${colorScheme})`).toEqual([]);
    }

    await bay.getByRole('textbox', { name: 'Umgebungsvariablen für neue Sessions' }).fill('DB=dev');
    await bay.getByRole('button', { name: 'Speichern' }).click();
    await bay.getByRole('button', { name: 'Neue Session', exact: true }).click();
    await bay.getByRole('button', { name: 'Umgebungsvariablen' }).click();
    await expect(bay.getByRole('textbox', { name: /eine pro Zeile/ })).toHaveValue('DB=dev');
    await expect(bay.getByRole('alert')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the project overview reflows at 200 % zoom', async () => {
  const repo = createRepo('zoomproject');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in zoomproject' }).click();
    await expect(bay.getByTestId(/^session-/)).toHaveCount(1);
    await bay.getByRole('button', { name: /^zoomproject/ }).click();
    const width = await bay.evaluate(() => innerWidth);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await bay.waitForFunction((w) => innerWidth <= w / 2 + 1, width);
    for (const name of ['Projekt entfernen', 'Neue Session', 'Speichern']) {
      const button = bay.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button, name).toBeInViewport();
    }
    const overflow = await bay.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
  } finally {
    await app.close();
  }
});
