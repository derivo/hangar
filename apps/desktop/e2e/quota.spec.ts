import { mkdirSync, writeFileSync } from 'node:fs';
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

test('the footer shows the 5-hour and weekly limits of Codex (log) and Claude Code (statusline)', async () => {
  const repo = createRepo('kontingent');
  const env = agentsEnv();
  // Codex logs into ~/.codex/sessions/<y>/<m>/<d>/; the bay reads the newest one.
  const day = join(env.HOME!, '.codex', 'sessions', '2026', '10', '30');
  mkdirSync(day, { recursive: true });
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(
    join(day, 'rollout.jsonl'),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 9, window_minutes: 300, resets_at: resetsAt },
          secondary: { used_percent: 30, window_minutes: 10080, resets_at: resetsAt + 86400 },
        },
      },
    }) + '\n',
  );

  const { app, shell } = await launch({ bayDirs: [repoBays], env });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    const footer = bay.getByRole('group', { name: 'Kontingente' });
    await expect(footer.getByRole('meter', { name: 'Codex 5h' })).toHaveAttribute(
      'aria-valuenow',
      '91',
    );
    await expect(footer.getByRole('meter', { name: 'Codex 7d' })).toHaveAttribute(
      'aria-valuenow',
      '70',
    );
    await expect(footer.getByRole('meter', { name: 'Claude 5h' })).toHaveCount(0);

    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in kontingent' }).click();
    // What Claude Code pipes into the statusLine command Hangar wrote into the worktree.
    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 6, resets_at: resetsAt },
        seven_day: { used_percentage: 15, resets_at: resetsAt + 86400 },
      },
    });
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(
      `grep -c '"command": "hangar statusline"' .claude/settings.local.json; echo '${input}' | hangar statusline\n`,
    );
    await expect(footer.getByRole('meter', { name: 'Claude 5h' })).toHaveAttribute(
      'aria-valuenow',
      '94',
    );
    await expect(bay.locator('.xterm-rows > div').filter({ hasText: /^1\s*$/ })).toHaveCount(1);
    await expect(footer).toContainText('94 % frei');
    await expect(footer.getByRole('meter', { name: 'Claude 7d' })).toHaveAttribute(
      'aria-valuenow',
      '85',
    );

    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `quota (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});
