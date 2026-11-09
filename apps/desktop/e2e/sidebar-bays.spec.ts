import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  agentsEnv,
  bayPage,
  launch,
  repoBays,
  violations,
} from './helpers';

/** Bay views in the main window that are currently shown. */
const visibleViews = (app: ElectronApplication) =>
  app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.contentView.children.filter((v) => v.getVisible()).length,
  );

test('a new Hangar starts empty; bays are added with the plus and removed by right click (ADR 0017)', async () => {
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env, seedBays: false });
  const { app, shell, userData } = first;
  try {
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    await expect(nav.getByRole('button', { name: 'Hangar-Übersicht' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.locator('[data-testid^="bay-"]')).toHaveCount(0);

    // Keyboard: the plus opens the picker, the first bay has focus, Escape closes it.
    const plus = nav.getByRole('button', { name: 'Zur Leiste hinzufügen' });
    await plus.focus();
    await shell.keyboard.press('Enter');
    const picker = shell.getByRole('dialog', { name: 'Zur Leiste hinzufügen' });
    await expect(picker.getByRole('button', { name: /^Agents/ })).toBeFocused();
    await expect(picker.getByRole('button', { name: /^Browser/ })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `picker (${colorScheme})`).toEqual([]);
    }
    await shell.keyboard.press('Escape');
    await expect(picker).toBeHidden();

    await plus.click();
    await picker.getByRole('button', { name: /^Agents/ }).click();
    await expect(picker).toBeHidden();
    await expect(nav.getByRole('button', { name: 'Agents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await bayPage(app, 'agents/dist/ui');
    await expect.poll(() => visibleViews(app)).toBe(1);

    // The open picker hides the bay view, which would cover it.
    await plus.click();
    await expect(picker.getByRole('button', { name: /^Agents/ })).toHaveCount(0);
    await expect.poll(() => visibleViews(app)).toBe(0);
    await picker.getByRole('button', { name: /^Browser/ }).click();
    await expect(nav.getByRole('button', { name: 'Browser' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect.poll(() => visibleViews(app)).toBe(1);

    for (const name of ['Board', 'Passwörter']) {
      await plus.click();
      await picker.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await expect(nav.getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
    }
    await plus.click();
    await expect(picker).toContainText('Alle Bays sind schon in der Leiste.');
    await picker.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(picker).toBeHidden();
  } finally {
    await app.close();
  }

  const second = await launch({ userData, bayDirs: [repoBays], env });
  try {
    const nav = second.shell.getByRole('navigation', { name: 'Bays' });
    await expect(nav.locator('[data-testid^="bay-"]')).toHaveCount(4);
    expect(
      await nav
        .locator('[data-testid^="bay-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
    ).toEqual([
      'bay-dev.hangar.agents',
      'bay-dev.hangar.browser',
      'bay-dev.hangar.board',
      'bay-dev.hangar.secrets',
    ]);
    await expect(nav.getByRole('button', { name: 'Passwörter' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // The native context menu is replaced: its only item is clicked at once.
    await second.app.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = ((items: { label: string; click(): void }[]) => ({
        popup: () => items.find((i) => i.label === 'Aus Leiste entfernen')!.click(),
      })) as never;
    });
    await nav.getByRole('button', { name: 'Passwörter' }).click({ button: 'right' });
    await expect(nav.getByRole('button', { name: 'Passwörter' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Hangar-Übersicht' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect
      .poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).bays)
      .toEqual(['dev.hangar.agents', 'dev.hangar.browser', 'dev.hangar.board']);
    await nav.getByRole('button', { name: 'Zur Leiste hinzufügen' }).click();
    await expect(
      second.shell.getByRole('dialog').getByRole('button', { name: /^Passwörter/ }),
    ).toBeVisible();
  } finally {
    await second.app.close();
  }
});
