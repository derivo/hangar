import { expect, test, launch, repoBays, violations } from './helpers';

test('the settings navigation brings each section to the top and focuses its heading (mouse and Enter)', async () => {
  const { app, shell } = await launch({ bayDirs: [repoBays] });
  try {
    // Tall window: several headings are visible at once, focus() alone would not scroll.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1400, 1300),
    );
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    const nav = shell.getByRole('navigation', { name: 'Einstellungsbereiche' });
    for (const [i, name] of ['Bays', 'Workspaces', 'Allgemein', 'Berechtigungen'].entries()) {
      const link = nav.getByRole('link', { name });
      if (i % 2) {
        await link.focus();
        await link.press('Enter');
      } else {
        await link.click();
      }
      const heading = shell.getByRole('heading', { level: 2, name });
      await expect(heading).toBeFocused();
      // At the top of the scroll area, unless the page ends before (scrolled to its end).
      await expect
        .poll(() =>
          heading.evaluate((h) => {
            const content = h.closest('.content')!;
            const top = h.getBoundingClientRect().top - content.getBoundingClientRect().top;
            const atEnd = content.scrollTop + content.clientHeight >= content.scrollHeight - 1;
            // Not above the scroll area either (scrolled past the heading).
            return top > -1 && (top < 80 || atEnd);
          }),
        )
        .toBe(true);
    }
  } finally {
    await app.close();
  }
});

test('"Check for updates" shows each state of the updater, without violations', async () => {
  const { app, shell } = await launch();
  try {
    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    const check = shell.getByRole('button', { name: 'Nach Updates suchen' });
    // Not packaged: like the background check, the updater does not run.
    await expect(shell.getByText('Updates gibt es nur in der installierten App.')).toBeVisible();
    await expect(check).toBeDisabled();

    // The other states come from electron-updater in the packaged app; pushed like the main process.
    const push = (status: unknown) =>
      app.evaluate(({ BrowserWindow }, s) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send('shell:update', s);
      }, status);
    const states: [unknown, string][] = [
      [{ state: 'checking' }, 'Suche nach Updates …'],
      [{ state: 'current' }, 'Hangar ist aktuell.'],
      [{ state: 'downloading', version: '9.9.9', percent: 42 }, 'Update 9.9.9 wird geladen: 42 %'],
      [{ state: 'ready', version: '9.9.9' }, 'Update 9.9.9 ist bereit.'],
      [
        { state: 'error', message: 'Code signature invalid' },
        'Update fehlgeschlagen: Code signature invalid',
      ],
    ];
    for (const [status, text] of states) {
      await push(status);
      await expect(shell.getByText(text)).toBeVisible();
      for (const colorScheme of ['light', 'dark'] as const) {
        await shell.emulateMedia({ colorScheme });
        expect(await violations(shell), `${text} (${colorScheme})`).toEqual([]);
      }
    }
    await expect(shell.getByRole('progressbar', { name: 'Download' })).toHaveCount(0);

    await push({ state: 'ready', version: '9.9.9' });
    // Not packaged, nothing downloaded in the main process: installing does nothing.
    await shell.getByRole('button', { name: 'Neu starten und installieren' }).click();
    // A ready update installs on the next quit; a new check could only lose it.
    await expect(check).toBeDisabled();
    await push({ state: 'error', message: 'Code signature invalid' });
    // An error allows a new check; Enter on the still disabled button would do nothing.
    await expect(check).toBeEnabled();
    // The keyboard reaches the button; a check asks the main process, which answers.
    await check.focus();
    await check.press('Enter');
    await expect(shell.getByText('Updates gibt es nur in der installierten App.')).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
  }
});
