import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  test,
  type Page,
  agentsEnv,
  bayPage,
  createRepo,
  launch,
  mockFolderPicker,
  repoBays,
  violations,
} from './helpers';

test('in English, shell and agent bay show English texts without WCAG violations', async () => {
  const repo = createRepo('english');
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    env: { ...agentsEnv(), HANGAR_LOCALE: 'en' },
  });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await expect(bay.locator('html')).toHaveAttribute('lang', 'en');
    await expect(shell.locator('html')).toHaveAttribute('lang', 'en');
    await expect(bay.getByText('Add a Git repository with “+” next to “Projects”.')).toBeVisible();

    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: 'Add project' }).click();
    await bay.getByRole('button', { name: 'New session in english' }).click();
    await bay.getByRole('button', { name: 'Environment variables' }).click();
    await bay.getByRole('textbox', { name: /Environment variables/ }).fill('FOO');
    await bay.getByRole('button', { name: 'Save and restart shell' }).click();
    await expect(bay.getByRole('alert')).toHaveText('Line without "=": FOO');
    for (const colorScheme of ['light', 'dark'] as const) {
      await bay.emulateMedia({ colorScheme });
      expect(await violations(bay), `agent bay (${colorScheme})`).toEqual([]);
    }

    await shell.getByRole('button', { name: 'Settings' }).click();
    await expect(shell.getByRole('combobox', { name: 'Language' })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await shell.emulateMedia({ colorScheme });
      expect(await violations(shell), `settings (${colorScheme})`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});

test('the language chosen in the settings applies from the next start', async () => {
  // `''`: no override, the app follows its settings.
  const env = { HANGAR_LOCALE: '' };
  const first = await launch({ env });
  try {
    // Named in the system language here: the settings button is the last one in the sidebar.
    await first.shell.locator('nav.sidebar > button').last().click();
    await first.shell.getByRole('combobox').first().selectOption('en');
    await expect
      .poll(() => readFileSync(join(first.userData, 'settings.json'), 'utf8'))
      .toContain('"language": "en"');
  } finally {
    await first.app.close();
  }
  const second = await launch({ env, userData: first.userData });
  try {
    await expect(second.shell.getByRole('button', { name: 'Settings' })).toBeVisible();
    await second.shell.getByRole('button', { name: 'Settings' }).click();
    await expect(second.shell.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
  } finally {
    await second.app.close();
  }
});

/** Visible texts and accessible names, except terminal output and endonyms (`lang`). */
function texts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const skip = (el: Element | null) => !el || !!el.closest('.xterm, code, [lang]:not(html)');
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!skip(node.parentElement)) found.push(node.textContent!.trim());
    }
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      if (skip(el)) continue;
      for (const name of ['aria-label', 'title', 'placeholder']) {
        found.push(el.getAttribute(name) ?? '');
      }
    }
    return found.filter((text) => /\p{L}/u.test(text));
  });
}

test('the pseudo-locale finds no hard-coded text and no overflow at 200 % zoom', async () => {
  const repo = createRepo('pseudo');
  const { app, shell } = await launch({
    bayDirs: [repoBays],
    env: { ...agentsEnv(), HANGAR_LOCALE: 'en-XA' },
  });
  try {
    await shell.getByRole('button', { name: 'Agents' }).click();
    const bay = await bayPage(app, 'agents/dist/ui');
    await mockFolderPicker(app, repo);
    await bay.getByRole('button', { name: /Ádd prójéçt/ }).click();
    await bay
      .getByRole('button', { name: /pseudo/ })
      .filter({ hasText: '+' })
      .click();
    await expect(bay.getByTestId(/^session-/)).toHaveCount(1);
    await bay.getByRole('button', { name: /Éñvíróñméñt/ }).click();

    // User data (project, path, branch) and the bays' manifest names are not texts of the app.
    const branch = await bay
      .getByTestId(/^session-/)
      .locator('.tree-session-title')
      .innerText();
    const data = new Set([
      'pseudo',
      repo,
      branch,
      'Agents',
      'Browser',
      'Board',
      'Feeds',
      'Passwörter',
    ]);
    const found = await texts(bay);
    await shell.getByRole('button', { name: /Séttíñgs/ }).click();
    // Language, update channel, caller filter and the three of the rule form.
    await expect(shell.getByRole('combobox')).toHaveCount(6);
    found.push(...(await texts(shell)));
    // Name and fingerprint of this instance and the example relay address are data too.
    for (const fact of await shell.locator('.facts b').allInnerTexts()) data.add(fact);
    data.add('wss://relay.example.com');
    // Function ids (`<bay-id>/<function>`) are identifiers from the manifest, not texts.
    const isFunctionId = (text: string) => /^[a-z][\w.-]*\/[\w.]+$/.test(text);
    expect(
      found.filter((text) => !text.includes('[') && !data.has(text) && !isFunctionId(text)),
    ).toEqual([]);

    await shell.getByRole('button', { name: 'Agents' }).click();
    const width = await bay.evaluate(() => innerWidth);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(2);
    });
    await bay.waitForFunction((w) => innerWidth <= w / 2 + 1, width);
    const overflow = await bay.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'horizontal overflow in CSS px').toBeLessThanOrEqual(0);
  } finally {
    await app.close();
  }
});
