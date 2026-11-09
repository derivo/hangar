import type { ChildProcess } from 'node:child_process';
import {
  expect,
  test,
  type Page,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  OPERATOR,
  repoBays,
  startRelay,
  violations,
} from './helpers';

let relay: { child: ChildProcess } | undefined;
test.afterEach(() => void relay?.child.kill());

/** Opens the settings and connects to the relay with Enter. */
async function connect(shell: Page, url: string) {
  await shell.getByRole('button', { name: 'Einstellungen' }).click();
  const address = shell.getByRole('textbox', { name: 'Relay-Adresse' });
  await address.fill(url);
  await address.press('Enter');
  await expect(shell.getByRole('status')).toHaveText('Verbunden');
  return shell.locator('.facts b').nth(1).innerText();
}

test('two Hangars join a workspace and see the shared sessions of each other (ADR 0030)', async () => {
  test.setTimeout(90_000);
  const r = await startRelay();
  relay = r;
  const anna = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  const ben = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    const annaPrint = await connect(anna.shell, r.url);
    const benPrint = await connect(ben.shell, r.url);
    expect(annaPrint).toMatch(/^[0-9a-f]{64}$/);
    expect(benPrint).not.toBe(annaPrint);

    // Anna founds the workspace (keyboard only) and invites.
    const create = anna.shell.getByRole('form', { name: 'Workspace anlegen' });
    await create.getByRole('textbox', { name: 'Name' }).focus();
    await anna.shell.keyboard.type('team');
    await anna.shell.keyboard.press('Tab');
    await expect(create.getByLabel('Betreiber-Token')).toBeFocused();
    await anna.shell.keyboard.type(OPERATOR);
    await anna.shell.keyboard.press('Enter');
    const annaTeam = anna.shell.getByRole('region', { name: 'team' });
    await annaTeam.getByRole('button', { name: 'Einladen' }).click();
    const invite = annaTeam.getByRole('list', { name: 'Einladung' });
    await expect(invite).toContainText(annaPrint);
    const token = await invite.locator('b').nth(1).innerText();

    // Ben joins with the three values and waits for Anna.
    const join = ben.shell.getByRole('form', { name: 'Workspace beitreten' });
    await join.getByRole('textbox', { name: 'Workspace' }).fill('team');
    await join.getByRole('textbox', { name: 'Einladungs-Token' }).fill(token);
    await join.getByRole('textbox', { name: 'Fingerabdruck des Einladenden' }).fill(annaPrint);
    await join.getByRole('textbox', { name: 'Fingerabdruck des Einladenden' }).press('Enter');
    const benTeam = ben.shell.getByRole('region', { name: 'team' });
    await expect(benTeam).toContainText('Wartet, bis der Einladende diesen Hangar aufnimmt.');

    // Anna compares Ben's fingerprint and adds him.
    await expect(annaTeam).toContainText(benPrint);
    for (const colorScheme of ['light', 'dark'] as const) {
      await anna.shell.emulateMedia({ colorScheme });
      expect(await violations(anna.shell), `workspaces (${colorScheme})`).toEqual([]);
    }
    await annaTeam.getByRole('button', { name: /^Fingerabdruck stimmt – / }).click();
    await expect(
      benTeam.getByRole('list', { name: 'Mitglieder' }).getByRole('listitem'),
    ).toHaveCount(2);
    await expect(benTeam).not.toContainText('Wartet');

    // At 200 % the settings reflow: nothing scrolls sideways.
    await ben.app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await expect(benTeam.getByRole('button', { name: 'Einladen' })).toBeVisible();
    const overflow = await ben.shell.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await ben.app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1);
    });

    // Anna shares a project; Ben sees its session with description and status.
    const repo = createRepo('shop');
    await anna.shell.getByRole('button', { name: 'Agents' }).click();
    const annaBay = await bayPage(anna.app, 'agents/dist/ui');
    await mockFolderPicker(anna.app, repo);
    await annaBay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await annaBay.getByRole('button', { name: 'Neue Session in shop' }).click();
    await annaBay.locator('.xterm-helper-textarea').focus();
    await annaBay.keyboard.type('hangar describe "Login bauen" && hangar status waiting\n');
    await annaBay.getByRole('button', { name: /^shop/ }).click();
    // The checkbox shows the state the bay confirmed, so click and wait for it.
    const share = annaBay.getByRole('checkbox', { name: 'In Workspaces teilen' });
    await share.click();
    await expect(share).toBeChecked();

    await ben.shell.getByRole('button', { name: 'Agents' }).click();
    const benBay = await bayPage(ben.app, 'agents/dist/ui');
    const remote = benBay.getByRole('region', { name: 'Andere Instanzen' });
    const shop = remote.getByRole('listitem', { name: /^shop – .+ \(team\)$/ });
    await expect(shop).toContainText('Login bauen', { timeout: 15_000 });
    await expect(shop.getByRole('img', { name: 'wartet auf Eingabe' })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await benBay.emulateMedia({ colorScheme });
      expect(await violations(benBay), `remote sessions (${colorScheme})`).toEqual([]);
    }

    // A change of status reaches Ben too; unsharing takes the project away.
    await annaBay.getByRole('button', { name: 'Login bauen' }).first().click();
    await annaBay.locator('.xterm-helper-textarea').focus();
    await annaBay.keyboard.type('hangar status working\n');
    await expect(shop.getByRole('img', { name: 'arbeitet' })).toBeVisible({ timeout: 15_000 });
    await annaBay.getByRole('button', { name: /^shop/ }).click();
    await share.click();
    await expect(share).not.toBeChecked();
    await expect(remote).toBeHidden({ timeout: 15_000 });
  } finally {
    await anna.app.close();
    await ben.app.close();
  }
});
