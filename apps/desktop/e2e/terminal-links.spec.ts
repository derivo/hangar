import {
  expect,
  test,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
} from './helpers';

declare global {
  var __opened: string[];
}

test('a link in the terminal (OSC 8, as Claude Code writes it) opens in the browser after OK', async () => {
  const repo = createRepo('links');
  const { app, shell } = await launch({ bayDirs: [repoBays], env: agentsEnv() });
  try {
    await app.evaluate(({ shell }) => {
      globalThis.__opened = [];
      shell.openExternal = (async (url: string) => void globalThis.__opened.push(url)) as never;
    });
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    // The first question is cancelled, the second confirmed.
    const dialogs: string[] = [];
    bay.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void (dialogs.length === 1 ? dialog.dismiss() : dialog.accept());
    });
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Projekt hinzufügen' }).click();
    await bay.getByRole('button', { name: 'Neue Session in links' }).click();
    await bay.locator('.xterm-helper-textarea').focus();
    await bay.keyboard.type(
      String.raw`printf '\e]8;;https://example.com/hangar\e\\link%s\e]8;;\e\\\n' 42` + '\n',
    );
    const line = bay.locator('.xterm-rows > div').filter({ hasText: /^link42\s*$/ });
    await expect(line).toHaveCount(1);

    // xterm's screen lies over the rows, so click by position.
    const box = (await line.boundingBox())!;
    await bay.mouse.click(box.x + 10, box.y + box.height / 2);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(await app.evaluate(() => globalThis.__opened)).toEqual([]);
    await bay.mouse.click(box.x + 10, box.y + box.height / 2);
    await expect
      .poll(() => app.evaluate(() => globalThis.__opened))
      .toEqual(['https://example.com/hangar']);
    // The question names the real target: the text of an OSC 8 link can say anything.
    expect(dialogs).toEqual(Array(2).fill('Link öffnen?\n\nhttps://example.com/hangar'));
  } finally {
    await app.close();
  }
});
