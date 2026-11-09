import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, agentsEnv, launch, repoBays, violations } from './helpers';

/** Bay ids in the order the sidebar shows them. */
const shown = (shell: Page) =>
  shell
    .locator('.sidebar-list [data-testid^="bay-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(4)));

const settings = (userData: string) =>
  JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
    bays: string[];
    shortcuts: { target: string }[];
  };

test('bays and shortcuts are sorted by dragging or from their menu and keep the order (ADR 0038)', async () => {
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env });
  const { userData } = first;
  let order: string[];
  try {
    const { app, shell } = first;
    const nav = shell.getByRole('navigation', { name: 'Bays' });
    // The sidebar fills in after the first paint; read it only once all four bays are there.
    await expect.poll(async () => (await shown(shell)).length).toBe(4);
    const before = await shown(shell);
    const button = (id: string) => nav.getByTestId(`bay-${id}`);

    // Dragged onto the third, the first takes its place.
    await button(before[0]!).dragTo(button(before[2]!));
    order = [before[1]!, before[2]!, before[0]!, before[3]!];
    await expect.poll(() => shown(shell)).toEqual(order);
    expect(settings(userData).bays).toEqual(order);

    // Without dragging (WCAG 2.5.7): the native menu, its „Nach oben“ clicked at once.
    await app.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = ((items: { label?: string; click?(): void }[]) => ({
        popup: () => items.find((i) => i.label === 'Nach oben')!.click!(),
      })) as never;
    });
    await button(order[3]!).click({ button: 'right' });
    order = [order[0]!, order[1]!, order[3]!, order[2]!];
    await expect.poll(() => shown(shell)).toEqual(order);

    // Shortcuts among themselves.
    await shell.evaluate(async () => {
      const api = (
        window as unknown as { hangarShell: { addUrlShortcut(u: string): Promise<void> } }
      ).hangarShell;
      await api.addUrlShortcut('https://a.example/');
      await api.addUrlShortcut('https://b.example/');
    });
    const shortcuts = nav.getByRole('list', { name: 'Verknüpfungen' });
    await shortcuts
      .getByRole('button', { name: 'b.example öffnen' })
      .dragTo(shortcuts.getByRole('button', { name: 'a.example öffnen' }));
    await expect
      .poll(() => settings(userData).shortcuts.map((s) => s.target))
      .toEqual(['https://b.example/', 'https://a.example/']);
    expect(await shown(shell)).toEqual(order);

    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell)).toEqual([]);
    }
  } finally {
    await first.app.close();
  }

  const second = await launch({ bayDirs: [repoBays], env, userData });
  try {
    await expect.poll(() => shown(second.shell)).toEqual(order);
    expect(
      await second.shell
        .getByRole('list', { name: 'Verknüpfungen' })
        .getByRole('button')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
    ).toEqual(['b.example öffnen', 'a.example öffnen']);
  } finally {
    await second.app.close();
  }
});
