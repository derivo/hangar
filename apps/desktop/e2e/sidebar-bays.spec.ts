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

test('a new Hangar starts with the agent bay; bays are added with the plus and removed by right click (ADR 0017, 0050)', async () => {
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env, seedBays: false });
  const { app, shell, userData } = first;
  try {
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    await expect(nav.getByRole('button', { name: 'Hangar-Übersicht' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Only the agent bay; the other bundled bays wait in the picker.
    expect(
      await nav
        .locator('[data-testid^="bay-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
    ).toEqual(['bay-dev.hangar.agents']);

    // Keyboard: the plus opens the picker, the first bay has focus, Escape closes it.
    const plus = nav.getByRole('button', { name: 'Zur Leiste hinzufügen' });
    await plus.focus();
    await shell.keyboard.press('Enter');
    const picker = shell.getByRole('dialog', { name: 'Zur Leiste hinzufügen' });
    await expect(picker.getByRole('button', { name: /^Board/ })).toBeFocused();
    await expect(picker.getByRole('button', { name: /^Agents/ })).toHaveCount(0);
    await expect(picker.getByRole('button', { name: /^Browser/ })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `picker (${colorScheme})`).toEqual([]);
    }
    // The dialog itself may hold the focus (a click on its background): no ring around it.
    const cdp = await shell.context().newCDPSession(shell);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: 'dialog.picker',
    });
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] });
    await expect(picker).toHaveCSS('outline-style', 'none');
    await cdp.detach();
    // The address and its button share a row; Cancel stands alone at the bottom right.
    const field = await picker.getByRole('textbox', { name: 'Webseite' }).boundingBox();
    const add = await picker.getByRole('button', { name: 'Webseite hinzufügen' }).boundingBox();
    expect(Math.abs(field!.y + field!.height / 2 - (add!.y + add!.height / 2))).toBeLessThan(2);
    const cancel = await picker.getByRole('button', { name: 'Abbrechen' }).boundingBox();
    const connect = await picker
      .getByRole('button', { name: 'Mit Server verbinden' })
      .boundingBox();
    expect(cancel!.y).toBeGreaterThan(connect!.y + connect!.height);
    // Right edge of the content, like the button next to the address.
    expect(Math.abs(cancel!.x + cancel!.width - (add!.x + add!.width))).toBeLessThan(2);
    await shell.keyboard.press('Escape');
    await expect(picker).toBeHidden();

    await nav.getByRole('button', { name: 'Agents' }).click();
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

    for (const name of ['Board', 'Feeds', 'Proxy', 'Passwörter']) {
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
    await expect(nav.locator('[data-testid^="bay-"]')).toHaveCount(6);
    expect(
      await nav
        .locator('[data-testid^="bay-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
    ).toEqual([
      'bay-dev.hangar.agents',
      'bay-dev.hangar.browser',
      'bay-dev.hangar.board',
      'bay-dev.hangar.feeds',
      'bay-dev.hangar.proxy',
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
      .toEqual([
        'dev.hangar.agents',
        'dev.hangar.browser',
        'dev.hangar.board',
        'dev.hangar.feeds',
        'dev.hangar.proxy',
      ]);
    await nav.getByRole('button', { name: 'Zur Leiste hinzufügen' }).click();
    await expect(
      second.shell.getByRole('dialog').getByRole('button', { name: /^Passwörter/ }),
    ).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test('the settings switch bays into and out of the sidebar, by mouse and keyboard (ADR 0050)', async () => {
  const { app, shell, userData } = await launch({
    bayDirs: [repoBays],
    env: agentsEnv(),
    seedBays: false,
  });
  try {
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    const sidebar = () =>
      nav
        .locator('[data-testid^="bay-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    const agents = shell.getByRole('switch', { name: 'Agents' });
    const browser = shell.getByRole('switch', { name: 'Browser' });
    await expect(agents).toHaveAttribute('aria-checked', 'true');
    await expect(browser).toHaveAttribute('aria-checked', 'false');
    await expect(shell.getByRole('switch')).toHaveCount(6);

    // Mouse: on puts the bay at the end of the sidebar; the settings stay open.
    await browser.click();
    await expect(browser).toHaveAttribute('aria-checked', 'true');
    await expect.poll(sidebar).toEqual(['bay-dev.hangar.agents', 'bay-dev.hangar.browser']);
    await expect(nav.getByRole('button', { name: 'Einstellungen' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect.poll(() => visibleViews(app)).toBe(0);
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `bay switches (${colorScheme})`).toEqual([]);
    }

    // Keyboard: Space switches off, Enter on again.
    await agents.focus();
    await shell.keyboard.press('Space');
    await expect(agents).toHaveAttribute('aria-checked', 'false');
    await expect.poll(sidebar).toEqual(['bay-dev.hangar.browser']);
    await expect(agents).toBeFocused();
    await shell.keyboard.press('Enter');
    await expect(agents).toHaveAttribute('aria-checked', 'true');
    await expect.poll(sidebar).toEqual(['bay-dev.hangar.browser', 'bay-dev.hangar.agents']);
    await expect
      .poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).bays)
      .toEqual(['dev.hangar.browser', 'dev.hangar.agents']);

    // Removed by right click: the switch follows.
    await app.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = ((items: { label: string; click(): void }[]) => ({
        popup: () => items.find((i) => i.label === 'Aus Leiste entfernen')!.click(),
      })) as never;
    });
    await nav.getByRole('button', { name: 'Browser' }).click({ button: 'right' });
    await expect(browser).toHaveAttribute('aria-checked', 'false');
  } finally {
    await app.close();
  }
});
