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

test('the context menu of a session runs its main actions, by mouse and by keyboard', async () => {
  const shop = createRepo('shop');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, shop);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    for (let n = 1; n <= 2; n++) {
      await bay.getByRole('button', { name: 'Neue Session in shop' }).click();
      await expect(bay.locator('.tree-session')).toHaveCount(n);
    }
    const titles = () => bay.locator('.tree-session-title').allTextContents();
    const [first, second] = await titles();
    const item = (title: string) => bay.locator('.tree-session').filter({ hasText: title });
    const menu = bay.getByRole('menu');

    // Mouse: the menu opens at the pointer, has no violations and stays inside the window.
    await item(second!).click({ button: 'right' });
    await expect(menu).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `session menu (${colorScheme})`).toEqual([]);
    }
    await bay.getByRole('menuitem', { name: 'Nach oben' }).click();
    await expect(menu).toBeHidden();
    await expect.poll(titles).toEqual([second, first]);

    await item(first!).click({ button: 'right' });
    await bay.getByRole('menuitemradio', { name: 'Blau' }).click();
    await expect(item(first!)).toHaveAttribute('data-color', 'blue');

    // Keyboard: Shift+F10 opens it on the focused session, arrows and Enter choose.
    await item(first!).focus();
    await bay.keyboard.press('Shift+F10');
    await expect(bay.getByRole('menuitem', { name: 'Beschreibung ändern…' })).toBeFocused();
    await bay.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(item(first!)).toBeFocused();
    await bay.keyboard.press('Shift+F10');
    await bay.keyboard.press('Enter');
    const description = bay.getByRole('textbox', { name: 'Beschreibung' });
    await expect(description).toBeFocused();
    await description.fill('Login bauen');
    await description.press('Enter');
    await expect(item('Login bauen')).toBeVisible();

    await item('Login bauen').click({ button: 'right' });
    await bay.getByRole('menuitem', { name: 'Pfad kopieren' }).click();
    await expect(bay.getByRole('status')).toHaveText('In die Zwischenablage kopiert');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(shop);

    await item('Login bauen').click({ button: 'right' });
    await bay.getByRole('menuitem', { name: 'Job planen…' }).click();
    await expect(bay.getByRole('textbox', { name: 'Befehl' })).toBeFocused();

    // Opened near the bottom right corner, the menu turns inward.
    const size = await bay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await item(second!).dispatchEvent('contextmenu', {
      clientX: size.width - 5,
      clientY: size.height - 5,
    });
    const box = (await menu.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await bay.keyboard.press('Escape');

    bay.once('dialog', (dialog) => void dialog.accept());
    await item(second!).click({ button: 'right' });
    await bay.getByRole('menuitem', { name: 'Session schließen…' }).click();
    await expect(bay.locator('.tree-session')).toHaveCount(1);
  } finally {
    await app.close();
  }
});
