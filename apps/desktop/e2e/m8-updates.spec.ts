import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, launch } from './helpers';

test('the update channel is chosen in the settings and kept across restarts', async () => {
  const first = await launch();
  try {
    await first.shell.getByRole('button', { name: 'Einstellungen' }).click();
    const channel = first.shell.getByRole('combobox', { name: 'Update-Kanal' });
    await expect(channel).toHaveValue('stable');
    await channel.selectOption({ label: 'Beta' });
    await expect
      .poll(() => readFileSync(join(first.userData, 'settings.json'), 'utf8'))
      .toContain('"beta"');
  } finally {
    await first.app.close();
  }

  const second = await launch({ userData: first.userData });
  try {
    await second.shell.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(second.shell.getByRole('combobox', { name: 'Update-Kanal' })).toHaveValue('beta');
  } finally {
    await second.app.close();
  }
});
