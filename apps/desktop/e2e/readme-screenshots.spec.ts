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
} from './helpers';

// Not a test: renders the README screenshots. Run with
// HANGAR_SCREENSHOTS=1 pnpm --filter @hangar/desktop exec playwright test e2e/readme-screenshots.spec.ts
test.skip(!process.env.HANGAR_SCREENSHOTS, 'only with HANGAR_SCREENSHOTS=1');

const media = join(__dirname, '../../../docs/media');

test('README screenshots of the agent bay, light and dark', async () => {
  // Short paths in the tree and a neutral prompt: nothing of this machine in the picture.
  process.env.TMPDIR = '/tmp';
  const [shop, blog] = [createRepo('shop'), createRepo('blog')];
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    env: { ...agentsEnv(), HANGAR_LOCALE: 'en' },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    for (const repo of [shop, blog]) {
      await mockFolderPicker(app, repo);
      await bay.getByRole('button', { name: 'Add project' }).click();
      await expect(bay.getByText(repo)).toBeVisible();
    }
    const sessions = [
      ['shop', 'Fix the checkout total', 'working'],
      ['blog', 'Write the release notes', 'waiting'],
      ['shop', 'Add tests for the cart', 'done'],
    ] as const;
    for (const [project, description, status] of sessions) {
      await bay.getByRole('button', { name: `New session in ${project}` }).click();
      await expect(bay.getByRole('textbox', { name: 'Description' })).toHaveValue('');
      await bay.locator('.xterm-helper-textarea').last().focus();
      await bay.keyboard.type(
        `PS1='$ '; hangar describe "${description}" && hangar status ${status}` +
          ' && hangar statusbar set model opus --type text' +
          ' && hangar statusbar set context 42 --type bar --max 100 && clear\n',
      );
      await expect(bay.getByRole('textbox', { name: 'Description' })).toHaveValue(description);
    }
    await bay.locator('.tree-session', { hasText: 'Fix the checkout total' }).click();
    await bay.locator('.xterm-helper-textarea').last().focus();
    await bay.keyboard.type('git status --short --branch && ls\n');
    mkdirSync(media, { recursive: true });
    // The window capture leaves out the bay views: shell and bay are put together here.
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const views = BrowserWindow.getAllWindows()[0]!.contentView
        .children as Electron.WebContentsView[];
      const view = views.find((v) => v.webContents?.getURL().includes('agents/dist/ui'))!;
      return view.getBounds();
    });
    for (const theme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme: theme });
      await bay.emulateMedia({ colorScheme: theme });
      await bay.waitForTimeout(300);
      const [back, front] = await Promise.all([
        shell.screenshot({ scale: 'css' }),
        bay.screenshot({ scale: 'css' }),
      ]);
      const png = await shell.evaluate(
        async ([back, front, at]) => {
          const load = (b64: string) =>
            new Promise<HTMLImageElement>((resolve) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.src = `data:image/png;base64,${b64}`;
            });
          const [b, f] = await Promise.all([load(back), load(front)]);
          const canvas = document.createElement('canvas');
          [canvas.width, canvas.height] = [b.width, b.height];
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(b, 0, 0);
          ctx.drawImage(f, at.x, at.y);
          return canvas.toDataURL('image/png').split(',')[1]!;
        },
        [back.toString('base64'), front.toString('base64'), bounds] as const,
      );
      writeFileSync(join(media, `hangar-${theme}.png`), Buffer.from(png, 'base64'));
    }
  } finally {
    await app.close();
  }
});
