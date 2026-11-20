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

test('the main window stays on its page and opens no windows (security audit 2026-11-17)', async () => {
  const { app, shell } = await launch();
  try {
    // The bay view may finish loading after the shell; count once it is there.
    await bayPage(app, 'test-bay/index.html');
    const windows = app.windows().length;
    // What a link or URL dropped on the sidebar would do: its preload grants every shell:* channel.
    await shell.evaluate(() => {
      location.href = 'http://127.0.0.1:9/';
    });
    expect(await shell.evaluate(() => window.open('http://127.0.0.1:9/'))).toBeNull();
    await shell.waitForTimeout(500);
    expect(await shell.evaluate(() => location.href)).toContain('out/renderer/index.html');
    expect(app.windows()).toHaveLength(windows);
  } finally {
    await app.close();
  }
});
