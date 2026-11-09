import { expect, test, bayPage, launch } from './helpers';

test('app starts, bay appears in the sidebar and opens', async () => {
  const { app, shell } = await launch();
  try {
    const entry = shell.getByRole('button', { name: 'Test-Bay' });
    await expect(entry).toBeVisible();
    await expect(shell.getByRole('img', { name: /Kaputte Bay: / })).toBeVisible();

    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(shell.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();

    await entry.click();
    await expect(entry).toHaveAttribute('aria-current', 'page');
    const bay = await bayPage(app, 'test-bay');
    await expect(bay.getByTestId('test-bay')).toHaveText('Test-Bay geladen');
    await expect(bay.getByTestId('has-api')).toHaveText('hangar-api');
    // Theme tokens are injected into every bay.
    const accent = await bay.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--hangar-color-accent').trim(),
    );
    expect(accent).not.toBe('');
  } finally {
    await app.close();
  }
});
