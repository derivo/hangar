import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type ElectronApplication, launch, violations } from './helpers';

declare global {
  // Calls recorded by the stubs below.
  var __opened: string[];
  var __missing: string | undefined;
}

/** File dialog answers with `paths[kind]`; opening and warnings are recorded, nothing opens. */
async function stubSystem(app: ElectronApplication, paths: { file: string; folder: string }) {
  await app.evaluate(({ dialog, shell, Menu }, paths) => {
    globalThis.__opened = [];
    dialog.showOpenDialog = (async (_win: unknown, options: { properties: string[] }) => ({
      canceled: false,
      filePaths: [options.properties.includes('openDirectory') ? paths.folder : paths.file],
    })) as never;
    shell.openPath = (async (path: string) => {
      globalThis.__opened.push(`path ${path}`);
      return path === globalThis.__missing ? 'Datei fehlt' : '';
    }) as never;
    shell.openExternal = (async (url: string) => {
      globalThis.__opened.push(`url ${url}`);
    }) as never;
    dialog.showMessageBox = (async (
      _win: unknown,
      options: { message: string; detail: string },
    ) => {
      globalThis.__opened.push(`warning ${options.message} ${options.detail}`);
      return { response: 0 };
    }) as never;
    Menu.buildFromTemplate = ((items: { label: string; click(): void }[]) => ({
      popup: () => items.find((i) => i.label === 'Aus Leiste entfernen')!.click(),
    })) as never;
  }, paths);
}

const opened = (app: ElectronApplication) => app.evaluate(() => globalThis.__opened);

test('programs, folders, files and websites as shortcuts in the sidebar (ADR 0027)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-shortcut-'));
  const file = join(dir, 'notizen.txt');
  writeFileSync(file, 'x');
  const first = await launch();
  const { app, shell, userData } = first;
  try {
    await stubSystem(app, { file, folder: dir });
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    const plus = nav.getByRole('button', { name: 'Zur Leiste hinzufügen' });
    const picker = shell.getByRole('dialog', { name: 'Zur Leiste hinzufügen' });
    const shortcuts = nav.getByRole('list', { name: 'Verknüpfungen' });
    await expect(shortcuts).toHaveCount(0);

    await plus.click();
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `picker (${colorScheme})`).toEqual([]);
    }
    await picker.getByRole('button', { name: 'Ordner …' }).click();
    await expect(picker).toBeHidden();
    await plus.click();
    await picker.getByRole('button', { name: 'Datei oder Programm …' }).click();
    await expect(picker).toBeHidden();

    // Website: one wrong value at a time, by button and by Enter.
    await plus.click();
    const field = picker.getByLabel('Webseite');
    const submit = picker.getByRole('button', { name: 'Webseite hinzufügen' });
    await submit.click();
    await expect(picker.getByRole('alert')).toHaveText('Adresse fehlt.');
    for (const wrong of [
      '   ',
      'example.com',
      'ftp://example.com',
      'javascript:alert(1)',
      'http://',
    ]) {
      await field.fill(wrong);
      await field.press('Enter');
      await expect(picker.getByRole('alert')).toHaveText(
        wrong.trim() ? 'Nur Adressen mit http:// oder https:// gehen.' : 'Adresse fehlt.',
      );
    }
    await field.fill('  https://example.com  ');
    await submit.click();
    await expect(picker).toBeHidden();
    // The same site again does not add a second entry.
    await plus.click();
    await field.fill('https://example.com/');
    await field.press('Enter');
    await expect(picker).toBeHidden();

    const buttons = shortcuts.getByRole('button');
    await expect(buttons).toHaveCount(3);
    expect(
      await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
    ).toEqual([`${basename(dir)} öffnen`, 'notizen.txt öffnen', 'example.com öffnen']);
    await expect(buttons.nth(2)).toHaveAttribute('title', 'example.com\nhttps://example.com/');
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `sidebar (${colorScheme})`).toEqual([]);
    }

    // Open by click and keyboard; a file that is gone shows a warning.
    await buttons.nth(0).click();
    await buttons.nth(2).focus();
    await shell.keyboard.press('Enter');
    await app.evaluate((_e, path) => (globalThis.__missing = path), file);
    await buttons.nth(1).click();
    await expect
      .poll(() => opened(app))
      .toEqual([
        `path ${dir}`,
        'url https://example.com/',
        `path ${file}`,
        `warning „notizen.txt“ lässt sich nicht öffnen. Datei fehlt`,
      ]);

    // Right click removes it; nothing is opened.
    await buttons.nth(1).click({ button: 'right' });
    await expect(buttons).toHaveCount(2);
    expect(await opened(app)).toHaveLength(4);
  } finally {
    await app.close();
  }

  const second = await launch({ userData });
  try {
    const shortcuts = second.shell.getByRole('list', { name: 'Verknüpfungen' });
    await expect(shortcuts.getByRole('button')).toHaveText(['', '']);
    expect(
      await shortcuts
        .getByRole('button')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
    ).toEqual([`${basename(dir)} öffnen`, 'example.com öffnen']);
    // The folder shows its system icon, the website the globe.
    await expect(shortcuts.getByRole('button').nth(0).locator('img')).toHaveCount(1);
    await expect(shortcuts.getByRole('button').nth(1).locator('svg')).toHaveCount(1);
  } finally {
    await second.app.close();
  }
});
