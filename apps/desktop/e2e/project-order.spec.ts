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

test('projects are sorted by dragging, collapse to their name and keep both after a restart', async () => {
  const [shop, blog] = [createRepo('shop'), createRepo('blog')];
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env });
  const names = (bay: Awaited<ReturnType<typeof bayPage>>) =>
    bay.locator('.tree-project-name').allTextContents();
  try {
    await first.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(first.app, 'agents/dist/ui');
    for (const repo of [shop, blog]) {
      await mockFolderPicker(first.app, repo);
      await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
      await expect(bay.getByText(repo)).toBeVisible();
    }
    await bay.getByRole('button', { name: 'Neue Session in shop' }).click();
    expect(await names(bay)).toEqual(['shop', 'blog']);

    const row = (name: string) => bay.locator('.tree-project').filter({ hasText: name });
    await row('blog').dragTo(row('shop'));
    await expect.poll(() => names(bay)).toEqual(['blog', 'shop']);
    // Without dragging (WCAG 2.5.7): the overview moves it back and down again.
    await bay.getByRole('button', { name: /^shop/ }).click();
    await bay.getByRole('button', { name: 'Projekt nach oben' }).click();
    await expect.poll(() => names(bay)).toEqual(['shop', 'blog']);
    await expect(bay.getByRole('button', { name: 'Projekt nach oben' })).toBeDisabled();
    await bay.getByRole('button', { name: 'Projekt nach unten' }).click();
    await expect.poll(() => names(bay)).toEqual(['blog', 'shop']);

    await bay.getByRole('button', { name: 'Sessions von shop ausblenden' }).click();
    await expect(bay.locator('.tree-session')).toHaveCount(0);
    await expect(bay.getByRole('navigation').getByText(shop)).toBeHidden();
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `collapsed project (${colorScheme})`).toEqual([]);
    }
  } finally {
    await first.app.close();
  }

  const second = await launch({ bayDirs: [repoBays], env, userData: first.userData });
  try {
    await second.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(second.app, 'agents/dist/ui');
    await expect.poll(() => names(bay)).toEqual(['blog', 'shop']);
    await expect(bay.getByRole('button', { name: 'Sessions von shop einblenden' })).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test('sessions are sorted within their project by dragging or from the overview and keep it after a restart', async () => {
  const shop = createRepo('shop');
  const env = agentsEnv();
  const first = await launch({ bayDirs: [repoBays], env });
  const titles = (bay: Awaited<ReturnType<typeof bayPage>>) =>
    bay.locator('.tree-session-title').allTextContents();
  let order: string[];
  try {
    await first.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(first.app, 'agents/dist/ui');
    await mockFolderPicker(first.app, shop);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    for (let n = 1; n <= 3; n++) {
      await bay.getByRole('button', { name: 'Neue Session in shop' }).click();
      await expect(bay.locator('.tree-session')).toHaveCount(n);
    }
    const [a, b, c] = await titles(bay);
    const item = (title: string) => bay.locator('.tree-session').filter({ hasText: title });
    await item(c!).dragTo(item(a!));
    order = [c!, a!, b!];
    await expect.poll(() => titles(bay)).toEqual(order);

    // Without dragging (WCAG 2.5.7): up and down in the project overview.
    await bay.getByRole('button', { name: /^shop/ }).click();
    await expect(bay.getByRole('button', { name: `Session ${c} nach oben` })).toBeDisabled();
    // Up, down and close side by side in their cell.
    const tops = await Promise.all(
      [`Session ${c} nach oben`, `Session ${c} nach unten`, `Session ${c} schließen`].map(
        async (name) => (await bay.getByRole('button', { name }).boundingBox())!.y,
      ),
    );
    expect(new Set(tops).size).toBe(1);
    await bay.getByRole('button', { name: `Session ${c} nach unten` }).click();
    order = [a!, c!, b!];
    await expect.poll(() => titles(bay)).toEqual(order);
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `project overview (${colorScheme})`).toEqual([]);
    }
  } finally {
    await first.app.close();
  }

  const second = await launch({ bayDirs: [repoBays], env, userData: first.userData });
  try {
    await second.shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(second.app, 'agents/dist/ui');
    await expect.poll(() => titles(bay)).toEqual(order);
  } finally {
    await second.app.close();
  }
});

test('a long project tree scrolls between its fixed header and the session counts', async () => {
  const repos = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => createRepo(`p-${n}`));
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 420));
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    for (const repo of repos) {
      await mockFolderPicker(app, repo);
      await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
      await expect(bay.getByText(repo)).toBeVisible();
    }
    const tree = bay.locator('nav.tree');
    await expect
      .poll(() => tree.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);
    const inTree = async (part: ReturnType<typeof bay.locator>) => {
      const [box, outer] = [(await part.boundingBox())!, (await tree.boundingBox())!];
      return box.y >= outer.y - 1 && box.y + box.height <= outer.y + outer.height + 1;
    };
    const add = bay.getByRole('button', { name: 'Projekt hinzufügen' });
    const counts = bay.getByRole('list', { name: 'Übersicht' });
    for (const top of [0, 1e6]) {
      await tree.evaluate((el, y) => el.scrollTo(0, y), top);
      expect(await inTree(add), `header at ${top}`).toBe(true);
      expect(await inTree(counts), `counts at ${top}`).toBe(true);
    }
    // Focus scrolls a button clear of header and counts (WCAG 2.4.11), in both directions.
    const clear = async (part: ReturnType<typeof bay.locator>) => {
      const box = (await part.boundingBox())!;
      const head = (await bay.locator('.tree-header').boundingBox())!;
      const foot = (await counts.boundingBox())!;
      return box.y >= head.y + head.height && box.y + box.height <= foot.y;
    };
    const focused = bay.locator('.tree-project-item :focus');
    await tree.evaluate((el) => el.scrollTo(0, 0));
    await add.focus();
    for (let i = 0; i < 12; i++) {
      await bay.keyboard.press('Tab');
      if ((await focused.count()) === 1) expect(await clear(focused), `Tab ${i}`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await bay.keyboard.press('Shift+Tab');
      if ((await focused.count()) === 1) expect(await clear(focused), `Shift+Tab ${i}`).toBe(true);
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `scrolled tree (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});
