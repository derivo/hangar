// Renders Hangar's app and tray icons from their SVG sources with Playwright's
// Chromium (a dev dependency of apps/desktop). Run: node scripts/make-icons.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'apps', 'desktop');
const { chromium } = createRequire(join(root, 'package.json'))('@playwright/test');

const targets = [
  ['build/icon.svg', 1024, 'build/icon.png'],
  ['resources/tray.svg', 16, 'resources/trayTemplate.png'],
  ['resources/tray.svg', 32, 'resources/trayTemplate@2x.png'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [source, size, file] of targets) {
  const svg = readFileSync(join(root, source), 'base64');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${svg}">`,
  );
  await page.screenshot({ path: join(root, file), omitBackground: true });
}
await browser.close();
