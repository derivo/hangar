import {
  expect,
  test,
  type Page,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  violations,
} from './helpers';

/** Columns the shell sees in the focused field, read with `stty size`. */
async function columns(bay: Page): Promise<number> {
  let cols = 0;
  await expect(async () => {
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('clear; stty size\n');
    const text = (await bay.locator('.xterm-rows').innerText()).trim();
    cols = Number(text.split(/\s+/)[1]);
    expect(cols).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
  return cols;
}

test('the project bar collapses to status lights as wide as the bay bar and stays so', async () => {
  const repo = createRepo('fold');
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env });
  const { app, shell } = first;
  await shell.getByRole('button', { name: 'Agents' }).click();
  const bay = await bayPage(app, 'agents/dist/ui');
  await mockFolderPicker(app, repo);
  await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
  for (const description of ['Erste', 'Zweite']) {
    await bay.getByRole('button', { name: 'Neue Session in fold' }).click();
    const field = bay.getByRole('textbox', { name: 'Beschreibung' });
    await expect(field).toHaveValue('');
    await field.fill(description);
    await field.press('Enter');
    await expect(bay.getByRole('button', { name: new RegExp(description) })).toBeVisible();
  }

  const before = await columns(bay);
  // By keyboard: the toggle keeps the focus in both directions.
  const fold = bay.getByRole('button', { name: 'Projektleiste einklappen' });
  await fold.focus();
  await bay.keyboard.press('Enter');
  const unfold = bay.getByRole('button', { name: 'Projektleiste ausklappen' });
  await expect(unfold).toBeFocused();
  const tree = bay.getByRole('navigation', { name: 'Projekte und Sessions' });
  const dock = (await shell.locator('.sidebar').boundingBox())!.width;
  expect((await tree.boundingBox())!.width).toBe(dock);
  await expect.poll(() => columns(bay)).toBeGreaterThan(before);
  await unfold.focus();
  await bay.keyboard.press('Space');
  await expect(fold).toBeFocused();
  await expect.poll(() => columns(bay)).toBe(before);
  await fold.click();

  await bay.getByRole('button', { name: /^Erste \(\w{8}\) – fold/ }).click();
  await expect(bay.getByRole('textbox', { name: 'Beschreibung' })).toHaveValue('Erste');
  await expect(bay.getByRole('button', { name: /^Erste \(\w{8}\) – fold/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  for (const colorScheme of ['light', 'dark'] as const) {
    await bay.emulateMedia({ colorScheme });
    expect(await violations(bay), `collapsed tree (${colorScheme})`).toEqual([]);
  }
  await app.close();

  const second = await launch({ bayDirs: [repoBays], env, userData: first.userData });
  try {
    await second.shell.getByRole('button', { name: 'Agents' }).click();
    const restored = await bayPage(second.app, 'agents/dist/ui');
    await restored.getByRole('button', { name: 'Projektleiste ausklappen' }).click();
    await expect(restored.getByText(repo)).toBeVisible();
  } finally {
    await second.app.close();
  }
});
