import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  agentsEnv,
  answerDialog,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  violations,
} from './helpers';

/** The questions the permission dialog asked, recorded by `answerDialog`. */
const dialogs = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __hangarDialogs?: string[] }).__hangarDialogs ?? []);

/** Has the visible session shell write `command`'s output to `file` and returns it. */
async function shellOutput(bay: Page, command: string, file: string) {
  let out = '';
  await expect(async () => {
    const terminal = bay.locator('.xterm:visible');
    await expect(terminal.locator('.xterm-rows')).toContainText('$', { timeout: 2000 });
    await terminal.locator('.xterm-helper-textarea').focus();
    // Keys typed while the shell starts may get lost: start a clean line.
    await bay.keyboard.press('Control+C');
    await bay.keyboard.type(`${command} > ${file}.tmp && mv ${file}.tmp ${file}\n`);
    await expect.poll(() => existsSync(file), { timeout: 2000 }).toBe(true);
    out = readFileSync(file, 'utf8').trim();
  }).toPass({ timeout: 20_000 });
  rmSync(file);
  return out;
}

/** MCP calls of the board as the agent holding `token`. */
function board(token: string, mcpUrl: string) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: `dev.hangar.board/${name}`, arguments: args },
      }),
    });
    const { result } = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text) as unknown;
  };
}

test('a password from the vault reaches the shell as a variable, never a file in plain text (ADR 0021)', async () => {
  const repo = createRepo('shop');
  const tmp = mkdtempSync(join(tmpdir(), 'hangar-e2e-secrets-'));
  const { app, shell, userData } = await launch({
    bayDirs: [repoBays],
    env: agentsEnv(),
  });
  try {
    // Bays ask each other for what their manifest declares in `uses` without a dialog
    // (ADR 0032); only reading a value, which is sensitive, asks.
    await answerDialog(app, 'Dauerhaft erlauben');
    await shell.getByRole('button', { name: 'Passwörter' }).click();
    const vault = await bayPage(app, 'secrets/dist/ui');
    const form = vault.getByRole('form', { name: 'Neues Passwort' });
    // One field wrong, then the happy path by keyboard.
    await form.getByLabel('Name').fill('GH_TOKEN');
    await form.getByRole('button', { name: 'Speichern' }).click();
    await expect(form.getByRole('alert')).toHaveText('Wert fehlt');
    await form.getByLabel('Name').fill('1X');
    await form.getByLabel('Wert').fill('geheim-123');
    await form.getByRole('button', { name: 'Speichern' }).click();
    await expect(form.getByRole('alert')).toHaveText(
      'Ungültiger Name: 1X (Buchstaben, Ziffern, _)',
    );
    await form.getByLabel('Name').fill('GH_TOKEN');
    await form.getByLabel('Beschreibung').fill('CI');
    await form.getByLabel('Wert').press('Enter');
    await expect(vault.getByRole('listitem')).toContainText('GH_TOKEN');
    await expect(vault.getByRole('status')).toHaveText('GH_TOKEN gespeichert');
    for (const colorScheme of ['light', 'dark'] as const) {
      await vault.emulateMedia({ colorScheme });
      expect(await violations(vault)).toEqual([]);
    }

    await shell.getByRole('button', { name: 'Agents' }).click();
    const agents = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await agents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await agents.getByRole('button', { name: /^shop / }).click();
    const env = agents.getByRole('textbox', { name: 'Umgebungsvariablen für neue Sessions' });
    await expect(env).toHaveAccessibleDescription(/Gespeichert: GH_TOKEN/);
    await env.fill('GH=@secret:GH_TOKEN');
    await agents.getByRole('button', { name: 'Speichern' }).click();
    await agents.getByRole('button', { name: 'Neue Session in shop' }).click();
    expect(await shellOutput(agents, 'echo "v=$GH"', join(tmp, 'gh'))).toBe('v=geheim-123');
    expect(await dialogs(app)).toEqual([
      expect.stringContaining('„dev.hangar.secrets/secret.resolve“'),
    ]);

    // Only the reference and the encrypted value lie on disk.
    const files = [
      join(userData, 'bays', 'dev.hangar.agents', 'state.json'),
      join(userData, 'bays', 'dev.hangar.secrets', 'vault.json'),
    ];
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain('geheim-123');
    expect(readFileSync(files[0]!, 'utf8')).toContain('"secret": "GH_TOKEN"');

    // Gone from the vault: the shell does not start and says why.
    await shell.getByRole('button', { name: 'Passwörter' }).click();
    await vault.evaluate(() => (window.confirm = () => true));
    await vault.getByRole('button', { name: 'GH_TOKEN löschen' }).click();
    await expect(vault.getByText('Noch keine Passwörter gespeichert.')).toBeVisible();
    await shell.getByRole('button', { name: 'Agents' }).click();
    await agents.getByRole('button', { name: 'Neue Session in shop' }).click();
    await expect(agents.locator('.xterm:visible .xterm-rows')).toContainText(
      'Shell nicht gestartet: Unknown password: GH_TOKEN',
    );
  } finally {
    await app.close();
  }
});

test('person and agents share the tasks of a project on the board (ADR 0037)', async () => {
  const repo = createRepo('shop');
  const tmp = mkdtempSync(join(tmpdir(), 'hangar-e2e-board-'));
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    env: agentsEnv(),
  });
  try {
    // Records every permission dialog: the board asks the agent bay without one (ADR 0032).
    await answerDialog(app, 'Ablehnen');
    await shell.getByRole('button', { name: 'Agents' }).click();
    const agents = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await agents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await agents.getByRole('button', { name: 'Neue Session in shop' }).click();
    const line = await shellOutput(agents, 'echo "$HANGAR_TOKEN $HANGAR_MCP_URL"', join(tmp, 'a'));
    const [token, url] = line.split(' ') as [string, string];
    const agent = board(token, url);

    await shell.getByRole('button', { name: 'Board' }).click();
    const page = await bayPage(app, 'board/dist/ui');
    await expect(page.getByLabel('Projekt')).toHaveValue(/.+/);
    await page.getByRole('button', { name: 'Aufgabe hinzufügen' }).click();
    const form = page.getByRole('form', { name: 'Neue Aufgabe' });
    await form.getByRole('button', { name: 'Aufgabe anlegen' }).click();
    await expect(form.getByRole('alert')).toHaveText('Titel fehlt');
    await form.getByLabel('Titel').fill('Login testen');
    await form.getByLabel('Titel').press('Enter');
    const open = page.getByRole('region', { name: 'Offen' });
    await expect(open).toContainText('Login testen');

    const [task] = (await agent('task.list')) as { id: string; title: string }[];
    expect(task!.title).toBe('Login testen');
    await agent('task.claim', { id: task!.id });
    const doing = page.getByRole('region', { name: 'In Arbeit' });
    await expect(doing).toContainText('Login testen');
    await expect(doing).toContainText(/in Arbeit bei/);
    await agent('task.add', { title: 'Tests ergänzen' });
    await expect(open).toContainText('von Agent');
    await agent('task.done', { id: task!.id, note: 'grün' });
    await expect(page.getByRole('region', { name: 'Erledigt' })).toContainText('grün');

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await violations(page)).toEqual([]);
    }
    // Back on open from the board: the agent may take it again.
    await page.getByRole('button', { name: 'Login testen wieder öffnen' }).click();
    await expect(open).toContainText('Login testen');
    expect(readdirSync(tmp)).toEqual([]);
    expect(await dialogs(app)).toEqual([]);
  } finally {
    await app.close();
  }
});
