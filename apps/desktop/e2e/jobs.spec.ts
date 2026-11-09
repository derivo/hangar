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

test('a job scheduled in a session runs on demand and shows its result in the settings', async () => {
  const repo = createRepo('jobs');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in jobs' }).click();

    await bay.getByRole('button', { name: 'Job planen' }).click();
    const form = bay.getByRole('form', { name: 'Job planen' });
    const command = form.getByRole('textbox', { name: 'Befehl' });
    const schedule = form.getByRole('textbox', { name: 'Zeitplan (Cron)' });
    const alert = bay.getByRole('alert');

    // One wrong field at a time; the happy path last.
    await schedule.fill('0 3 * * *');
    await form.getByRole('button', { name: 'Job anlegen' }).click();
    await expect(alert).toHaveText('Befehl fehlt');
    // Each case changes the message, so none passes on the previous one's.
    await command.fill("echo job:'ran'");
    await schedule.fill('');
    await form.getByRole('button', { name: 'Job anlegen' }).click();
    await expect(alert).toHaveText('Zeitplan fehlt');
    await command.fill('   ');
    await schedule.fill('0 3 * * *');
    await command.press('Enter');
    await expect(alert).toHaveText('Befehl fehlt');
    await command.fill("echo job:'ran'");
    await schedule.fill('  ');
    await schedule.press('Enter');
    await expect(alert).toHaveText('Zeitplan fehlt');

    await schedule.fill('* * *');
    await schedule.press('Enter');
    await expect(alert).toHaveText(
      'Ungültiger Zeitplan „* * *“: fünf Felder (Minute Stunde Tag Monat Wochentag), z. B. 0 2 * * 1-5',
    );

    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `job form (${colorScheme})`).toEqual([]);
    }

    await schedule.fill('0 3 * * *');
    await form.getByRole('button', { name: 'Job anlegen' }).click();
    await expect(form).toBeHidden();
    await expect(bay.getByRole('status')).toHaveText(
      'Job angelegt. Alle Jobs stehen in den Einstellungen unter „Jobs“.',
    );
    // Unsent input at the prompt: the job must not mix with it (ADR 0014).
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('echo USER-');
    await expect(bay.locator('.xterm-rows')).toContainText('echo USER-');

    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    const jobs = shell.getByRole('table', { name: 'Jobs' });
    const row = jobs.getByRole('row', { name: /echo job/ });
    await expect(row).toContainText('0 3 * * *');
    await expect(row).toContainText('noch nicht gelaufen');
    await row.getByRole('button', { name: 'Jetzt ausführen' }).click();
    await expect(row).toContainText('erfolgreich');
    await expect(row).toContainText('Exit-Code 0: job:ran');

    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `job list (${colorScheme})`).toEqual([]);
    }

    // Keyboard: Tab reaches every action of the row.
    await row.getByRole('button', { name: 'Pausieren' }).focus();
    await shell.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Jetzt ausführen' })).toBeFocused();
    await shell.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Löschen' })).toBeFocused();

    // 200 % zoom: no horizontal page overflow.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await row.scrollIntoViewIfNeeded();
    const overflow = await shell.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1);
    });

    await row.getByRole('button', { name: 'Pausieren' }).click();
    await expect(row).toContainText('pausiert');
    await row.getByRole('button', { name: 'Löschen' }).click();
    await expect(shell.getByText(/Noch keine Jobs/)).toBeVisible();

    // The job ran in its own process: the terminal shows neither its command nor its output.
    await shell.getByRole('button', { name: /^Agents/ }).click();
    await expect(bay.locator('.xterm-rows')).toContainText('echo USER-');
    await expect(bay.locator('.xterm-rows')).not.toContainText('job:ran');
  } finally {
    await app.close();
  }
});
