import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {
  _electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

/** Uncaught errors and unhandled rejections of every page of the apps launched in a test. */
let pageErrors: string[] = [];

/** Fails a test whose pages threw, even when everything it checked looked right. */
export const test = base.extend<{ noPageErrors: void }>({
  noPageErrors: [
    // Playwright reads the fixtures a function uses from its first parameter's pattern.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      pageErrors = [];
      await use();
      expect(pageErrors, 'uncaught errors in the app pages').toEqual([]);
    },
    { auto: true },
  ],
});

/** Errors from now on, and those a page threw before the test could listen. */
async function watchErrors(app: ElectronApplication) {
  const record = (page: Page, e: Error) => pageErrors.push(`${page.url()}: ${e.message}`);
  app.on('window', (page) => page.on('pageerror', (e) => record(page, e)));
  for (const page of app.windows()) {
    page.on('pageerror', (e) => record(page, e));
    for (const e of await page.pageErrors()) record(page, e);
  }
}

export const fixturesBays = join(__dirname, 'fixtures', 'bays');
export const repoBays = join(__dirname, '..', '..', '..', 'bays');
/** Second bay with a main part and a sensitive function, called by agents via `curl`. */
export const vaultBays = join(__dirname, 'fixtures', 'vault');
/** A bay whose start takes 500 ms and counts its starts in `globalThis.__slowActivations`. */
export const slowBays = join(__dirname, 'fixtures', 'slow');

export interface LaunchOptions {
  userData?: string;
  bayDirs?: string[];
  env?: Record<string, string>;
  /** `false` starts with an empty sidebar, like a new Hangar (ADR 0017). */
  seedBays?: boolean;
}

/** Ids of the valid bays in `dirs`. */
function bayIds(dirs: string[]): string[] {
  return dirs.flatMap((dir) =>
    readdirSync(dir).flatMap((name) => {
      try {
        const { id } = JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8'));
        return typeof id === 'string' ? [id] : [];
      } catch {
        return [];
      }
    }),
  );
}

/**
 * New user data gets every bay in the sidebar and the first one selected, as the tests
 * before ADR 0017 expect; existing user data is left alone.
 */
function seedBays(userData: string, bayDirs: string[]) {
  const settings = join(userData, 'settings.json');
  if (existsSync(settings)) return;
  const bays = bayIds(bayDirs);
  writeFileSync(settings, JSON.stringify({ bays }));
  const view = join(userData, 'view.json');
  if (!existsSync(view)) writeFileSync(view, JSON.stringify({ selected: bays[0] ?? null }));
}

/**
 * Packaged app to test instead of `out/` (e.g. `release/<v>/mac-arm64/Hangar.app/Contents/MacOS/Hangar`).
 * It then uses its bundled bays wherever a test asks for the repository's bays.
 */
const packaged = process.env.HANGAR_E2E_EXECUTABLE;

/** Starts the built app (`out/main/index.js`) with isolated user data. */
export async function launch(options: LaunchOptions = {}) {
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'hangar-e2e-'));
  const bayDirs = options.bayDirs ?? [fixturesBays];
  const useBundledBays = packaged && bayDirs.length === 1 && bayDirs[0] === repoBays;
  if (options.seedBays !== false) seedBays(userData, bayDirs);
  const app = await _electron.launch({
    ...(packaged ? { executablePath: packaged } : { args: [join(__dirname, '..')] }),
    env: {
      ...(process.env as Record<string, string>),
      HANGAR_USER_DATA: userData,
      ...(!useBundledBays && { HANGAR_BAYS_DIR: bayDirs.join(delimiter) }),
      HANGAR_E2E: '1',
      // Tests address controls by their German names; `''` falls back to settings and system.
      HANGAR_LOCALE: 'de',
      // The packaged app would start a LaunchAgent in every test (ADR 0036); local-server.spec.ts sets 1.
      HANGAR_LOCAL_SERVER: '0',
      ...options.env,
    },
  });
  await watchErrors(app);
  // Not firstWindow(): a bay view may finish loading before the shell window.
  const shell = await bayPage(app, 'out/renderer/index.html');
  return { app, shell, userData };
}

/** Finds a page (shell or bay view) by a fragment of its URL. */
export async function bayPage(app: ElectronApplication, urlPart: string): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const page = app.windows().find((w) => w.url().includes(urlPart));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Keine Seite mit "${urlPart}" gefunden`);
}

/** Throw-away git repository (never a real project). */
export function createRepo(name: string): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'hangar-e2e-repo-'))), name);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# e2e\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Hangar E2E',
    '-c',
    'user.email=e2e@example.invalid',
    'commit',
    '-qm',
    'init',
  );
  return dir;
}

/** A predictable shell: plain sh with an empty home, so no user profile interferes. */
export function agentsEnv(): Record<string, string> {
  return { SHELL: '/bin/sh', HOME: mkdtempSync(join(tmpdir(), 'hangar-e2e-home-')) };
}

/** Makes the native folder picker return `folder` without showing a dialog. */
export async function mockFolderPicker(app: ElectronApplication, folder: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as never;
  }, folder);
}

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** WCAG 2.2 AA violations found by axe-core, as `rule: targets`. */
export async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    // Electron cannot open the helper page axe uses for frames; the views have none.
    .setLegacyMode(true)
    .withTags(WCAG)
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`);
}

/** Answers the next permission dialogs with the button `label`. */
export async function answerDialog(app: ElectronApplication, label: string) {
  await app.evaluate(({ dialog }, label) => {
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { buttons: string[]; detail: string };
      (globalThis as { __hangarDialogs?: string[] }).__hangarDialogs ??= [];
      (globalThis as { __hangarDialogs?: string[] }).__hangarDialogs!.push(options.detail);
      return { response: options.buttons.indexOf(label), checkboxChecked: false };
    }) as never;
  }, label);
}

/**
 * Calls an MCP tool from the session shell and prints `<name>:ok`, `:denied` or `:failed`.
 * The quotes keep the typed command line from matching the printed result.
 */
export const curl = (name: string) =>
  `r=$(curl -s -H "Authorization: Bearer $HANGAR_TOKEN" -H 'content-type: application/json'` +
  ` -H 'accept: application/json, text/event-stream' "$HANGAR_MCP_URL"` +
  ` -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dev.hangar.vault/${name}","arguments":{}}}'` +
  `); case "$r" in *'"isError":true'*) echo ${name}:'denied';; *'"result"'*) echo ${name}:'ok';;` +
  ` *) echo ${name}:'failed';; esac\n`;

export const OPERATOR = 'e2e-operator-token';

/** `hangar-relay` from `apps/relay/dist` (built by `pnpm test:e2e`) on a free loopback port. */
export async function startRelay() {
  const child = spawn(
    process.execPath,
    [
      join(__dirname, '../../relay/dist/hangar-relay.mjs'),
      ...['--data', mkdtempSync(join(tmpdir(), 'hangar-e2e-relay-')), '--listen', '127.0.0.1:0'],
    ],
    { env: { ...process.env, HANGAR_RELAY_TOKEN: OPERATOR } },
  );
  let log = '';
  child.stdout!.on('data', (chunk) => (log += chunk));
  const url = () => /^relay listening on (\S+)$/m.exec(log)?.[1];
  await expect.poll(url, { timeout: 15_000 }).toBeTruthy();
  return { child, url: url()! };
}
