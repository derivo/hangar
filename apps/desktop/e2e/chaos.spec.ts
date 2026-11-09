import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type Locator,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  slowBays,
} from './helpers';

declare global {
  var __slowActivations: number | undefined;
  var __opened: string[];
}

// The same action many times in a row, faster than its answer: it happens once, nothing throws
// (the page-error gate in helpers.ts fails a test on any uncaught error).

/** Presses `button` `times` times as one quick multi-click, as a person hammering it does. */
const burst = (button: Locator, times = 5) => button.click({ clickCount: times });

/** The agent bay with a project `name` and its first session. */
async function agentsWithSession(name: string) {
  const repo = createRepo(name);
  const launched = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  const { app, shell } = launched;
  // Large enough for several fields.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 0, width: 2400, height: 1400 }),
  );
  await shell.getByRole('button', { name: 'Agents' }).click();
  const bay = await bayPage(app, 'agents/dist/ui');
  bay.on('dialog', (dialog) => void dialog.accept());
  await mockFolderPicker(app, repo);
  await burst(bay.getByRole('button', { name: 'Projekt hinzufügen' }));
  const create = bay.getByRole('button', { name: `Neue Session in ${name}` });
  await burst(create);
  await expect(bay.getByRole('region', { name: /^Session/ })).toHaveCount(1);
  return { ...launched, bay, create };
}

test('adding the same bay five times during its start starts it once', async () => {
  const { app, shell, userData } = await launch({ bayDirs: [slowBays], seedBays: false });
  try {
    await shell.evaluate(() =>
      Promise.all([1, 2, 3, 4, 5].map(() => window.hangarShell.addBay('dev.hangar.slow'))),
    );
    expect(await app.evaluate(() => globalThis.__slowActivations)).toBe(1);
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    await expect(nav.getByRole('button', { name: 'Langsam' })).toHaveCount(1);
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length,
      ),
    ).toBe(1);
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).bays).toEqual([
      'dev.hangar.slow',
    ]);
  } finally {
    await app.close();
  }
});

test('the agent bay: project, session, field, undock and restart, each pressed five times', async () => {
  const { app, bay, create } = await agentsWithSession('chaos');
  try {
    const tree = bay.getByRole('navigation', { name: 'Projekte und Sessions' });
    await expect(tree.locator('.tree-project-open')).toHaveCount(1);
    await expect(tree.locator('[data-testid^="session-"]')).toHaveCount(1);

    // A new session again after the first one answered: one more, not five.
    await burst(create);
    await expect(tree.locator('[data-testid^="session-"]')).toHaveCount(2);

    // Fields: a five-fold click adds one field; closing again and again leaves one.
    const fields = bay.getByRole('group', { name: /^Feld/ });
    await burst(bay.getByRole('button', { name: 'Feld hinzufügen' }));
    await expect(fields).toHaveCount(2);
    // Always the first close button, as a pointer resting on the same spot would hit.
    await bay.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        const close = [...document.querySelectorAll('button')].find(
          (b) => b.textContent === 'Feld schließen',
        );
        close?.click();
        await new Promise((r) => setTimeout(r, 16));
      }
    });
    await expect(fields).toHaveCount(1);

    // Undock five times: one window; bring back five times: docked again.
    await tree.locator('[data-testid^="session-"]').first().click();
    await burst(bay.getByRole('button', { name: 'Abdocken' }));
    await bayPage(app, 'index.html?window=');
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(2);
    await burst(bay.getByRole('button', { name: 'Zurückholen' }));
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(1);
    await expect(bay.getByRole('region', { name: /^Session/ })).toHaveCount(1);

    // Restart an ended shell five times: one new shell.
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('exit\n');
    await expect(bay.getByRole('status')).toContainText('Shell beendet.');
    await burst(bay.getByRole('button', { name: 'Neu starten', exact: true }));
    await expect(bay.getByRole('button', { name: 'Neu starten', exact: true })).toHaveCount(0);
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type('echo ALIVE$((2+3))\n');
    await expect(bay.locator('.xterm-rows')).toContainText('ALIVE5');

    // Close the session five times: closed once, no error.
    await burst(bay.getByRole('button', { name: 'Session schließen' }));
    await expect(tree.locator('[data-testid^="session-"]')).toHaveCount(1);
    await expect(bay.getByRole('alert')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('a job: planned once for five submits, run once for five clicks', async () => {
  const { app, shell, bay } = await agentsWithSession('chaosjob');
  try {
    await bay.getByRole('button', { name: 'Job planen' }).click();
    const form = bay.getByRole('form', { name: 'Job planen' });
    const ran = join(mkdtempSync(join(tmpdir(), 'hangar-e2e-job-')), 'ran.txt');
    await form.getByRole('textbox', { name: 'Befehl' }).fill(`echo ran >> ${ran}`);
    await form.getByRole('textbox', { name: 'Zeitplan (Cron)' }).fill('0 3 * * *');
    await burst(form.getByRole('button', { name: 'Job anlegen' }));
    await expect(form).toBeHidden();

    await shell.getByRole('button', { name: 'Einstellungen' }).click();
    const rows = shell.getByRole('table', { name: 'Jobs' }).getByRole('row', { name: /echo ran/ });
    await expect(rows).toHaveCount(1);
    await burst(rows.getByRole('button', { name: 'Jetzt ausführen' }));
    await expect(rows).toContainText('erfolgreich');
    await expect(shell.getByRole('alert')).toHaveCount(0);
    // Each run appends a line: one run.
    await shell.waitForTimeout(500);
    expect(readFileSync(ran, 'utf8')).toBe('ran\n');

    await burst(rows.getByRole('button', { name: 'Löschen' }));
    await expect(rows).toHaveCount(0);
    await expect(shell.getByRole('alert')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the shell: theme, picker and shortcut, each pressed again and again', async () => {
  const { app, shell, userData } = await launch({ bayDirs: [slowBays], seedBays: false });
  try {
    await app.evaluate(({ shell }) => {
      globalThis.__opened = [];
      shell.openExternal = (async (url: string) => void globalThis.__opened.push(url)) as never;
    });
    const nav = shell.getByRole('navigation', { name: 'Bays' });

    // Five steps from System: Hell, Dunkel, System, Hell, Dunkel.
    await burst(nav.getByRole('button', { name: /^Farbschema/ }));
    await expect(nav.getByRole('button', { name: /^Farbschema/ })).toHaveAccessibleName(
      'Farbschema: Dunkel (wechseln zu System)',
    );
    await expect
      .poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).theme)
      .toBe('dark');

    // The picker: a bay pressed five times during its start, a website submitted five times.
    const plus = nav.getByRole('button', { name: 'Zur Leiste hinzufügen' });
    const picker = shell.getByRole('dialog', { name: 'Zur Leiste hinzufügen' });
    await burst(plus);
    await burst(picker.getByRole('button', { name: /^Langsam/ }));
    await expect(picker).toBeHidden();
    await expect(nav.getByRole('button', { name: 'Langsam' })).toHaveCount(1);
    expect(await app.evaluate(() => globalThis.__slowActivations)).toBe(1);

    await plus.click();
    await picker.getByLabel('Webseite').fill('https://example.com');
    await burst(picker.getByRole('button', { name: 'Webseite hinzufügen' }));
    await expect(picker).toBeHidden();
    const site = nav
      .getByRole('list', { name: 'Verknüpfungen' })
      .getByRole('button', { name: 'example.com öffnen' });
    await expect(site).toHaveCount(1);

    // A double and a triple click open the website once each.
    await site.dblclick();
    await site.click({ clickCount: 3 });
    await expect
      .poll(() => app.evaluate(() => globalThis.__opened))
      .toEqual(['https://example.com/', 'https://example.com/']);
  } finally {
    await app.close();
  }
});

test('passwords and the board: save, add, finish and delete, each pressed five times', async () => {
  const repo = createRepo('chaosboard');
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    env: agentsEnv(),
  });
  try {
    await shell.getByRole('button', { name: 'Passwörter' }).click();
    const vault = await bayPage(app, 'secrets/dist/ui');
    // Confirmed at once: a native confirm the test would have to answer in between.
    await vault.evaluate(() => (window.confirm = () => true));
    const form = vault.getByRole('form', { name: 'Neues Passwort' });
    await form.getByLabel('Name').fill('TOKEN');
    await form.getByLabel('Wert').fill('geheim');
    await burst(form.getByRole('button', { name: 'Speichern' }));
    await expect(vault.getByRole('listitem')).toHaveCount(1);
    await expect(form.locator('[role=alert]')).toHaveText('');
    await burst(vault.getByRole('button', { name: 'TOKEN löschen' }));
    await expect(vault.getByText('Noch keine Passwörter gespeichert.')).toBeVisible();

    await shell.getByRole('button', { name: 'Agents' }).click();
    const agents = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await agents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await shell.getByRole('button', { name: 'Board' }).click();
    const board = await bayPage(app, 'board/dist/ui');
    // Confirmed at once: a native confirm the test would have to answer in between.
    await board.evaluate(() => (window.confirm = () => true));
    await board.getByRole('button', { name: 'Aufgabe hinzufügen' }).click();
    const add = board.getByRole('form', { name: 'Neue Aufgabe' });
    await add.getByLabel('Titel').fill('Einmal');
    await burst(add.getByRole('button', { name: 'Aufgabe anlegen' }));
    const cards = board.getByRole('listitem').filter({ hasText: 'Einmal' });
    await expect(cards).toHaveCount(1);
    await expect(add.locator('[role=alert]')).toHaveText('');
    await burst(board.getByRole('button', { name: 'Einmal erledigt' }));
    await expect(board.getByRole('region', { name: 'Erledigt' })).toContainText('Einmal');
    await burst(board.getByRole('button', { name: 'Einmal löschen' }));
    await expect(cards).toHaveCount(0);
  } finally {
    await app.close();
  }
});
