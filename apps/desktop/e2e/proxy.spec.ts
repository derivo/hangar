import { expect, test, bayPage, launch, repoBays, violations } from './helpers';

// The proxy bay before step 3: its engine starts only with the first watched session (ADR 0049).
test('the proxy bay shows its engine stopped until a session is watched', async () => {
  const { app, shell } = await launch({ bayDirs: [repoBays] });
  try {
    await shell.getByRole('button', { name: 'Proxy' }).click();
    const page = await bayPage(app, 'proxy/dist/ui');
    await expect(page.getByRole('heading', { name: 'Proxy' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(
      'Proxy-Engine: Gestoppt – startet mit der ersten beobachteten Session',
    );
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await violations(page), `proxy (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});
