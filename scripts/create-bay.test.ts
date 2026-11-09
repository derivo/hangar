import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseManifest, type BayContext, type BayMain } from '../packages/sdk/src/index';
// @ts-expect-error plain ESM script without type declarations
import { createBay } from './create-bay.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'hangar-create-bay-'));

describe('create-bay', () => {
  it('scaffolds a bay with a valid manifest and a working main part', async () => {
    const dir: string = createBay('dev.example.notes', { root: root(), name: 'Notizen' });
    expect(dir).toMatch(/bays[\\/]notes$/);

    const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    expect(manifest).toMatchObject({
      ok: true,
      manifest: { id: 'dev.example.notes', name: 'Notizen' },
    });
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe(
      '@hangar/bay-notes',
    );
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('`dev.example.notes`');

    const bay = (await import(join(dir, 'src/main/index.ts'))).default as BayMain;
    const provide = vi.fn();
    await bay.activate({ provide, ui: { handle: vi.fn() } } as unknown as BayContext);
    expect(provide.mock.calls[0]![1]()).toEqual({ text: 'Hallo von Notizen' });
  });

  it('escapes the name in generated code and HTML', async () => {
    const name = "Bob's <Notes>";
    const dir: string = createBay('dev.example.bobs', { root: root(), name });
    const bay = (await import(join(dir, 'src/main/index.ts'))).default as BayMain;
    const provide = vi.fn();
    await bay.activate({ provide, ui: { handle: vi.fn() } } as unknown as BayContext);
    expect(provide.mock.calls[0]![1]()).toEqual({ text: `Hallo von ${name}` });
    expect(readFileSync(join(dir, 'src/main/index.test.ts'), 'utf8')).toContain(
      JSON.stringify(`Hallo von ${name}`),
    );
    expect(readFileSync(join(dir, 'src/ui/index.html'), 'utf8')).toContain(
      '<title>Bob&#39;s &#60;Notes&#62;</title>',
    );
    expect(readFileSync(join(dir, 'src/ui/main.tsx'), 'utf8')).toContain(
      `<h1>{${JSON.stringify(name)}}</h1>`,
    );
  });

  it('derives the name from the id and refuses bad ids and existing folders', () => {
    const r = root();
    const dir: string = createBay('dev.example.rss', { root: r });
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toContain('"name": "Rss"');
    expect(() => createBay('dev.example.rss', { root: r })).toThrow('Ordner existiert bereits');
    expect(() => createBay('Notes', { root: r })).toThrow('Ungültige Bay-Kennung "Notes"');
  });

  it('reports usage errors with exit code 1', () => {
    const script = join(import.meta.dirname, 'create-bay.mjs');
    expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).toThrow(
      /Aufruf: pnpm create:bay <id> \[Name\]/,
    );
  });
});
