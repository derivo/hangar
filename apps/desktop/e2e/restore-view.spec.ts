import {
  expect,
  test,
  agentsEnv,
  bayPage,
  createRepo,
  fixturesBays,
  launch,
  mockFolderPicker,
  repoBays,
} from './helpers';

// Fits a 1024 × 768 screen (CI runner); macOS clamps a taller window to the screen.
const BOUNDS = { x: 120, y: 90, width: 800, height: 600 };

test('restart reopens the window where it was, with the same bay and session', async () => {
  const repo = createRepo('view');
  const env = agentsEnv();
  const bayDirs = [repoBays, fixturesBays];

  const first = await launch({ bayDirs, env });
  await first.shell.getByRole('button', { name: 'Agents' }).click();
  const bay = await bayPage(first.app, 'agents/dist/ui');
  await mockFolderPicker(first.app, repo);
  await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
  for (const description of ['Erste', 'Zweite']) {
    await bay.getByRole('button', { name: 'Neue Session in view' }).click();
    const field = bay.getByRole('textbox', { name: 'Beschreibung' });
    await expect(field).toHaveValue('');
    await field.fill(description);
    await field.press('Enter');
    await expect(bay.getByRole('button', { name: new RegExp(description) })).toBeVisible();
  }
  await bay.getByRole('button', { name: /Erste/ }).click();
  await first.app.evaluate(
    ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b),
    BOUNDS,
  );
  await first.shell.getByRole('button', { name: 'Test-Bay' }).click();
  await first.app.close();

  const second = await launch({ bayDirs, env, userData: first.userData });
  try {
    expect(
      await second.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBounds(),
      ),
    ).toEqual(BOUNDS);
    await expect(second.shell.getByRole('button', { name: 'Test-Bay' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await second.shell.getByRole('button', { name: 'Agents' }).click();
    const restored = await bayPage(second.app, 'agents/dist/ui');
    await expect(restored.getByRole('textbox', { name: 'Beschreibung' })).toHaveValue('Erste');
  } finally {
    await second.app.close();
  }
});
