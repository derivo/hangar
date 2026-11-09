import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  violations,
} from './helpers';

// The default resolution of a 16" MacBook Pro.
const BOUNDS = { x: 0, y: 0, width: 1728, height: 1080 };

/** Zooms the agent bay out, so a laptop display has room for more fields of 60 × 16. */
async function zoomBay(app: ElectronApplication, factor: number) {
  await app.evaluate(({ webContents }, f) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getURL().includes('agents/dist/ui')) wc.setZoomFactor(f);
    }
  }, factor);
}

const field = (bay: Page, n: number) => bay.getByRole('group', { name: `Feld ${n}` });

/** Types into the terminal of a field and returns what the terminal shows. */
async function typeIn(bay: Page, n: number, text: string) {
  await field(bay, n).locator('.xterm-helper-textarea').focus();
  await bay.keyboard.type(text);
}
const screenOf = (bay: Page, n: number) => field(bay, n).locator('.xterm-rows');

test('terminals share the screen as a grid of at least 60 × 16 characters, restored after a restart', async () => {
  const repo = createRepo('grid');
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env });
  let userData = first.userData;
  try {
    await first.app.evaluate(
      ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b),
      BOUNDS,
    );
    await first.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(first.app, 'agents/dist/ui');
    await mockFolderPicker(first.app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    const add = bay.getByRole('button', { name: 'Feld hinzufügen' });

    // At 100 % a 16" laptop window holds two fields of 60 × 16 characters, side by side.
    await expect(add).toHaveAttribute('aria-disabled', 'false');
    for (const n of [1, 2, 3]) {
      if (n === 3) {
        await expect(add).toHaveAttribute('aria-disabled', 'true');
        await expect(add).toHaveAccessibleDescription(/Kein Platz für ein weiteres Feld/);
        await zoomBay(first.app, 0.5);
        await expect(add).toHaveAttribute('aria-disabled', 'false');
      }
      if (n > 1) await add.click();
      await bay.getByRole('button', { name: 'Neue Session in grid' }).click();
      await expect(field(bay, n).getByRole('region', { name: /^Session/ })).toBeVisible();
    }
    const [one, two] = await Promise.all([1, 2].map((n) => field(bay, n).boundingBox()));
    expect(one!.y).toBe(two!.y);
    await expect(bay.getByTestId(/^session-/)).toHaveCount(3);

    // Input goes to the focused field only.
    await typeIn(bay, 2, 'echo MARK$((40+2))\n');
    await expect(screenOf(bay, 2)).toContainText('MARK42');
    await expect(screenOf(bay, 1)).not.toContainText('MARK42');
    await expect(screenOf(bay, 3)).not.toContainText('MARK42');
    await expect(field(bay, 2)).toHaveAttribute('data-focused');

    // A field of exactly the minimum size still holds 60 × 16 characters.
    await bay.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('.grid')!;
      const px = (value: string) => parseFloat(/minmax\(([\d.]+)px/.exec(value)![1]!);
      const one = document.querySelector<HTMLElement>('[aria-label="Feld 1"]')!;
      one.style.width = `${px(grid.style.gridTemplateColumns)}px`;
      one.style.height = `${px(grid.style.gridAutoRows)}px`;
    });
    await expect(async () => {
      await typeIn(bay, 1, 'clear; stty size\n');
      const [rows, cols] = (await screenOf(bay, 1).innerText()).trim().split(/\s+/).map(Number);
      expect(rows).toBeGreaterThanOrEqual(16);
      expect(cols).toBeGreaterThanOrEqual(60);
    }).toPass({ timeout: 10_000 });

    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `grid (${colorScheme})`).toEqual([]);
    }

    // A field can be closed; its session keeps running.
    await field(bay, 3).getByRole('button', { name: 'Feld schließen' }).click();
    await expect(bay.getByRole('group', { name: /^Feld/ })).toHaveCount(2);
    await expect(bay.getByTestId(/^session-/)).toHaveCount(3);

    await first.app.close();
    const second = await launch({ bayDirs: [repoBays], env, userData });
    userData = second.userData;
    try {
      await second.shell.getByRole('button', { name: 'Agents' }).click();
      const again = await bayPage(second.app, 'agents/dist/ui');
      await expect(again.getByRole('group', { name: /^Feld/ })).toHaveCount(2);
      for (const n of [1, 2]) {
        await expect(field(again, n).getByRole('region', { name: /^Session/ })).toBeVisible();
      }
    } finally {
      await second.app.close();
    }
  } finally {
    await first.app.close().catch(() => {});
  }
});

test('a small window keeps fields at their minimum and scrolls instead of squeezing them', async () => {
  const repo = createRepo('gridzoom');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await app.evaluate(
      ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b),
      BOUNDS,
    );
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await zoomBay(app, 0.5);
    await bay.getByRole('button', { name: 'Feld hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Feld hinzufügen' }).click();
    await zoomBay(app, 2);
    const sizes = await bay.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('.grid')!;
      const min = parseFloat(/minmax\(([\d.]+)px/.exec(grid.style.gridTemplateColumns)![1]!);
      const widths = [...grid.children].map((f) => f.getBoundingClientRect().width);
      return {
        min,
        widths,
        gridScrolls: grid.scrollWidth > grid.clientWidth || grid.scrollHeight > grid.clientHeight,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    for (const width of sizes.widths) expect(width).toBeGreaterThanOrEqual(sizes.min - 0.5);
    expect(sizes.gridScrolls).toBe(true);
    // The page itself does not scroll sideways; only the grid of terminals does.
    expect(sizes.pageOverflow).toBeLessThanOrEqual(0);
    for (const name of ['Feld hinzufügen', 'Projekt hinzufügen']) {
      await expect(bay.getByRole('button', { name })).toBeInViewport();
    }
  } finally {
    await app.close();
  }
});
