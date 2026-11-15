import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Windows has no `ps`: no agent is shown there (ADR 0045).
test.skip(process.platform === 'win32', 'agents are found with ps');

test('the session shows the logo of the agent running in its shell (ADR 0045)', async () => {
  const repo = createRepo('shop');
  // A program called `claude`: `sleep` under that name, as the real binary shows in ps.
  const bin = mkdtempSync(join(tmpdir(), 'hangar-agent-'));
  symlinkSync('/bin/sleep', join(bin, 'claude'));
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in shop' }).click();
    await expect(bay.locator('.xterm-rows')).toBeVisible();
    const tab = bay.locator('.tree-session').first();
    const logo = tab.getByRole('img', { name: 'Claude Code aktiv' });
    await expect(logo).toHaveCount(0);

    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(`${join(bin, 'claude')} 120\n`);
    // The bay reads the process table every 5 seconds.
    await expect(logo).toBeVisible({ timeout: 15_000 });
    const box = (await logo.boundingBox())!;
    const tabBox = (await tab.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(tabBox.x + tabBox.width - 40); // at the right

    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `agent logo (${colorScheme})`).toEqual([]);
    }

    // 200 % zoom: the logo stays in the tab, the page does not scroll sideways.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await expect(logo).toBeVisible();
    expect(
      await bay.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1);
    });

    // The agent ends: its logo goes.
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.press('Control+C');
    await expect(logo).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await app.close();
    rmSync(bin, { recursive: true, force: true });
  }
});
