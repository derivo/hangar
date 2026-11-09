import { expect, test, bayPage, launch, violations } from './helpers';

type Page = import('@playwright/test').Page;

/** What the page sees; Playwright's own color-scheme emulation is switched off first. */
const dark = async (page: Page) => {
  await page.emulateMedia({ colorScheme: null });
  return page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
};

test('the color scheme toggle above the settings switches shell and bays and is kept', async () => {
  const first = await launch();
  const toggle = first.shell.getByRole('button', { name: /^Farbschema/ });
  await first.shell.getByRole('button', { name: 'Test-Bay' }).click();
  const bay = await bayPage(first.app, 'test-bay');
  await expect(toggle).toHaveAccessibleName('Farbschema: System (wechseln zu Hell)');
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('Farbschema: Hell (wechseln zu Dunkel)');
  expect(await dark(first.shell)).toBe(false);
  expect(await dark(bay)).toBe(false);
  expect(await violations(first.shell), 'shell (light)').toEqual([]);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('Farbschema: Dunkel (wechseln zu System)');
  await expect.poll(() => dark(first.shell)).toBe(true);
  expect(await dark(bay)).toBe(true);
  expect(await violations(first.shell), 'shell (dark)').toEqual([]);
  await first.app.close();

  const second = await launch({ userData: first.userData });
  try {
    await expect(
      second.shell.getByRole('button', { name: 'Farbschema: Dunkel (wechseln zu System)' }),
    ).toBeVisible();
    expect(await dark(second.shell)).toBe(true);
  } finally {
    await second.app.close();
  }
});
