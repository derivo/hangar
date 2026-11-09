import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signIndex, type BayIndexEntry } from '../../../packages/host/src/bay-index';
import { packBay } from '../../../packages/host/src/bay-package';
import { expect, test, type Page, launch, violations } from './helpers';

/** A bay with a UI only, packed and listed in a signed index in `dir`. */
function publish(dir: string, key: KeyObject, bays: Record<string, unknown>[], version: number) {
  const entries: BayIndexEntry[] = bays.map((extra) => {
    const manifest = {
      id: 'dev.hangar.notes',
      name: 'Notizen',
      version: '1.0.0',
      icon: 'icon.svg',
      ui: 'dist/index.html',
      ...extra,
    };
    const src = mkdtempSync(join(tmpdir(), 'hangar-e2e-bay-'));
    writeFileSync(join(src, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(src, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    mkdirSync(join(src, 'dist'));
    writeFileSync(
      join(src, 'dist', 'index.html'),
      `<!doctype html><html lang="de"><title>Notizen</title><main><h1>Notizen ${manifest.version}</h1></main></html>`,
    );
    const pkg = packBay(src, key);
    const url = `v1/bays/${pkg.id}/${pkg.version}.bay`;
    mkdirSync(join(dir, 'v1', 'bays', pkg.id), { recursive: true });
    writeFileSync(join(dir, url), pkg.bytes);
    const { id, sha256, size, signature } = pkg;
    return { id, version: pkg.version, channel: 'stable', sha256, size, signature, url };
  });
  const index = { version, expires: '2099-01-01T00:00:00Z', bays: entries };
  writeFileSync(join(dir, 'index.json'), JSON.stringify(signIndex(index, key)));
}

/** Opens the settings; every native confirmation is recorded and accepted. */
async function settings(shell: Page, dialogs: string[]) {
  shell.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await shell.getByRole('button', { name: 'Einstellungen' }).click();
  return shell.getByRole('list', { name: 'Bays installieren' });
}

test('installs, updates with a permission diff and rolls back a bay from a local index (ADR 0034)', async () => {
  test.setTimeout(90_000);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const indexDir = mkdtempSync(join(tmpdir(), 'hangar-e2e-index-'));
  publish(indexDir, privateKey, [{}], 1);
  const env = {
    HANGAR_BAY_INDEX: join(indexDir, 'index.json'),
    HANGAR_BAY_INDEX_KEY: publicKey.export({ format: 'jwk' }).x!,
  };
  const dialogs: string[] = [];

  // Install with the keyboard; it runs from the next start.
  const first = await launch({ env });
  const { userData } = first;
  let { app, shell } = first;
  try {
    const catalog = await settings(shell, dialogs);
    await expect(catalog).toContainText('Nicht installiert');
    await catalog.getByRole('button', { name: '1.0.0 installieren' }).focus();
    await shell.keyboard.press('Enter');
    await expect(catalog).toContainText('Ab dem nächsten Start: 1.0.0');
    expect(dialogs[0]).toContain('Notizen 1.0.0 installieren?');
    expect(dialogs[0]).toContain('Keine neuen Rechte.');
    await expect(shell.getByRole('button', { name: 'Notizen', exact: true })).toHaveCount(0);
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `settings (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }

  // After the restart it is in the sidebar; the update shows what it may do in addition.
  publish(
    indexDir,
    privateKey,
    [
      {},
      {
        version: '1.1.0',
        functions: [{ name: 'note.list', sensitive: false }],
        uses: ['dev.hangar.test/echo.say'],
      },
    ],
    2,
  );
  ({ app, shell } = await launch({ env, userData }));
  try {
    await expect(shell.getByRole('button', { name: 'Notizen', exact: true })).toBeVisible();
    const catalog = await settings(shell, dialogs);
    await expect(catalog).toContainText('Installiert: 1.0.0');
    await catalog.getByRole('button', { name: 'Auf 1.1.0 aktualisieren' }).click();
    await expect(catalog).toContainText('Ab dem nächsten Start: 1.1.0');
    expect(dialogs[1]).toContain('Neue Funktionen: note.list');
    expect(dialogs[1]).toContain('Ruft neu auf: dev.hangar.test/echo.say');
  } finally {
    await app.close();
  }

  // Roll back to 1.0.0.
  ({ app, shell } = await launch({ env, userData }));
  try {
    const catalog = await settings(shell, dialogs);
    await expect(catalog).toContainText('Installiert: 1.1.0');
    await catalog.getByRole('button', { name: 'Auf 1.0.0 zurückrollen' }).click();
    await expect(catalog).toContainText('Ab dem nächsten Start: 1.0.0');
    expect(dialogs[2]).toContain('dev.hangar.notes auf 1.0.0 zurückrollen?');
  } finally {
    await app.close();
  }

  ({ app, shell } = await launch({ env, userData }));
  try {
    const catalog = await settings(shell, dialogs);
    await expect(catalog).toContainText('Installiert: 1.0.0');
    await expect(catalog.getByRole('button', { name: 'Auf 1.1.0 aktualisieren' })).toBeVisible();

    // At 200 % the list wraps instead of pushing the page sideways.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await catalog.scrollIntoViewIfNeeded();
    await expect(catalog.getByRole('button', { name: 'Auf 1.1.0 aktualisieren' })).toBeVisible();
    const overflow = await shell.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement;
      return scrollWidth - clientWidth;
    });
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
  } finally {
    await app.close();
  }
});
