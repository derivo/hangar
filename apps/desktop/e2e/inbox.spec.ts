import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type Page,
  agentsEnv,
  answerDialog,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  OPERATOR,
  repoBays,
  shellOutput,
  startRelay,
  violations,
} from './helpers';

let relay: { child: ChildProcess } | undefined;
test.afterEach(() => void relay?.child.kill());

async function connect(shell: Page, url: string) {
  await shell.getByRole('button', { name: 'Einstellungen' }).click();
  const address = shell.getByRole('textbox', { name: 'Relay-Adresse' });
  await address.fill(url);
  await address.press('Enter');
  await expect(shell.getByRole('status').first()).toHaveText('Verbunden');
  return shell.locator('.facts b').nth(1).innerText();
}

/** MCP as an agent of Ben's session: finds Anna's shared `task.add` and calls it. */
function agent(token: string, url: string) {
  const rpc = async (method: string, params: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return ((await res.json()) as { result: unknown }).result;
  };
  return async (title: string) => {
    let name: string | undefined;
    await expect(async () => {
      const { tools } = (await rpc('tools/list', {})) as { tools: { name: string }[] };
      name = tools.find((t) => /^remote\..*\/task\.add$/.test(t.name))?.name;
      expect(name).toBeDefined();
    }).toPass({ timeout: 15_000 });
    const result = (await rpc('tools/call', {
      name,
      arguments: { project: 'shop', title },
    })) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text) as { queued?: string; title?: string };
  };
}

test('work from another instance waits in the inbox until the person accepts it (ADR 0046)', async () => {
  test.setTimeout(120_000);
  const r = await startRelay();
  relay = r;
  const tmp = mkdtempSync(join(tmpdir(), 'hangar-e2e-inbox-'));
  const anna = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  const ben = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    const annaPrint = await connect(anna.shell, r.url);
    const benPrint = await connect(ben.shell, r.url);
    const create = anna.shell.getByRole('form', { name: 'Workspace anlegen' });
    await create.getByRole('textbox', { name: 'Name' }).fill('team');
    await create.getByLabel('Betreiber-Token').fill(OPERATOR);
    await create.getByLabel('Betreiber-Token').press('Enter');
    const annaTeam = anna.shell.getByRole('region', { name: 'team' });
    await annaTeam.getByRole('button', { name: 'Einladen' }).click();
    const token = await annaTeam
      .getByRole('list', { name: 'Einladung' })
      .locator('b')
      .nth(1)
      .innerText();
    const join_ = ben.shell.getByRole('form', { name: 'Workspace beitreten' });
    await join_.getByRole('textbox', { name: 'Workspace' }).fill('team');
    await join_.getByRole('textbox', { name: 'Einladungs-Token' }).fill(token);
    await join_.getByRole('textbox', { name: 'Fingerabdruck des Einladenden' }).fill(annaPrint);
    await join_.getByRole('textbox', { name: 'Fingerabdruck des Einladenden' }).press('Enter');
    await expect(annaTeam).toContainText(benPrint);
    await annaTeam.getByRole('button', { name: /^Fingerabdruck stimmt – / }).click();
    // The checkboxes show the state the main process confirmed: click, then wait for it.
    const shareAdd = annaTeam.getByRole('checkbox', { name: 'dev.hangar.board/task.add' });
    await shareAdd.click();
    await expect(shareAdd).toBeChecked();

    // Anna shares the project shop; Ben has a session whose agent calls her board.
    await anna.shell.getByRole('button', { name: 'Agents' }).click();
    const annaAgents = await bayPage(anna.app, 'agents/dist/ui');
    await mockFolderPicker(anna.app, createRepo('shop'));
    await annaAgents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await annaAgents.getByRole('button', { name: /^shop/ }).click();
    const share = annaAgents.getByRole('checkbox', { name: 'In Workspaces teilen' });
    await share.click();
    await expect(share).toBeChecked();
    await ben.shell.getByRole('button', { name: 'Agents' }).click();
    const benAgents = await bayPage(ben.app, 'agents/dist/ui');
    await mockFolderPicker(ben.app, createRepo('web'));
    await benAgents.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await benAgents.getByRole('button', { name: 'Neue Session in web' }).click();
    const line = await shellOutput(
      benAgents,
      'echo "$HANGAR_TOKEN $HANGAR_MCP_URL"',
      join(tmp, 'b'),
    );
    const [benToken, benUrl] = line.split(' ') as [string, string];
    const send = agent(benToken, benUrl);
    await answerDialog(ben.app, 'Erlauben');

    // Untrusted: queued, not on the board until Anna accepts.
    expect(await send('Aus dem Relay')).toEqual({ queued: expect.any(String) });
    await expect(
      anna.shell.getByRole('button', { name: 'Einstellungen, 1 Hinweis' }),
    ).toBeVisible();
    await anna.shell.getByRole('button', { name: /^Einstellungen/ }).click();
    const activity = anna.shell.getByRole('region', { name: 'Aktivität' });
    const waiting = activity.getByRole('list', { name: 'Wartet auf Freigabe' });
    await expect(waiting).toContainText('Aus dem Relay');
    await anna.shell.getByRole('button', { name: 'Board' }).click();
    const board = await bayPage(anna.app, 'board/dist/ui');
    await expect(board.getByRole('region', { name: 'Offen' })).not.toContainText('Aus dem Relay');

    await anna.shell.getByRole('button', { name: /^Einstellungen/ }).click();
    for (const colorScheme of ['light', 'dark'] as const) {
      await anna.shell.emulateMedia({ colorScheme });
      expect(await violations(anna.shell), `activity (${colorScheme})`).toEqual([]);
    }
    // Accept by keyboard.
    await activity.getByRole('button', { name: /^Annehmen: Aus dem Relay/ }).focus();
    await anna.shell.keyboard.press('Enter');
    await expect(waiting).toBeHidden();
    await anna.shell.getByRole('button', { name: 'Board' }).click();
    await expect(board.getByRole('region', { name: 'Offen' })).toContainText('Aus dem Relay');

    // Rejected work never reaches the board.
    expect(await send('Abgelehnt')).toEqual({ queued: expect.any(String) });
    await anna.shell.getByRole('button', { name: /^Einstellungen/ }).click();
    await activity.getByRole('button', { name: /^Ablehnen: Abgelehnt/ }).click();
    await expect(activity.getByText('Nichts wartet auf Freigabe.')).toBeVisible();

    // Trusted: runs at once and answers with the task.
    const trust = annaTeam.getByRole('checkbox', { name: /^Arbeit von .+ automatisch annehmen$/ });
    await trust.click();
    await expect(trust).toBeChecked();
    expect(await send('Vertraut')).toMatchObject({ title: 'Vertraut' });
    await anna.shell.getByRole('button', { name: 'Board' }).click();
    const open = board.getByRole('region', { name: 'Offen' });
    await expect(open).toContainText('Vertraut');
    await expect(open).not.toContainText('Abgelehnt');

    // The log has all of it, newest first.
    await anna.shell.getByRole('button', { name: /^Einstellungen/ }).click();
    const log = activity.getByRole('table', { name: 'Protokoll' });
    await expect(log.getByRole('row')).toHaveCount(6);
    await expect(log.getByRole('row').nth(1)).toContainText('ausgeführt');
    for (const outcome of ['angenommen', 'abgelehnt', 'wartet'])
      await expect(log).toContainText(outcome);

    // At 200 % the section reflows: nothing scrolls sideways.
    await anna.app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await expect(log).toBeVisible();
    const overflow = await anna.shell.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await anna.app.close();
    await ben.app.close();
  }
});
