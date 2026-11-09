// Scaffolds a new bay: `pnpm create:bay <id> [Name]`, e.g. `pnpm create:bay dev.hangar.notes Notizen`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Writes `bays/<last id segment>/` below `root`. Returns the bay folder.
 * @param {string} id Reverse-domain id, e.g. `dev.hangar.notes`.
 * @param {{ root: string, name?: string }} options
 */
export function createBay(id, { root, name }) {
  if (!ID.test(id)) throw new Error(`Ungültige Bay-Kennung "${id}" (Beispiel: dev.hangar.notes)`);
  const slug = id.split('.').at(-1);
  const title = name ?? slug.charAt(0).toUpperCase() + slug.slice(1);
  const dir = join(root, 'bays', slug);
  if (existsSync(dir)) throw new Error(`Ordner existiert bereits: ${dir}`);

  for (const [file, content] of Object.entries(files(id, slug, title))) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

const json = (value) => JSON.stringify(value, null, 2) + '\n';

/** The bay name as a JavaScript literal and as HTML text. */
const js = (text) => JSON.stringify(text);
const html = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function files(id, slug, title) {
  return {
    'manifest.json': json({
      id,
      name: title,
      version: '0.1.0',
      minHangarVersion: '0.1.0',
      icon: 'icon.svg',
      ui: 'dist/ui/index.html',
      main: 'dist/main/index.js',
      functions: [{ name: 'greeting.get', description: `Begrüßung von ${title}` }],
    }),
    'package.json': json({
      name: `@hangar/bay-${slug}`,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        build: 'vite build --config vite.ui.config.ts && vite build --config vite.main.config.ts',
      },
      devDependencies: {
        '@hangar/sdk': 'workspace:*',
        '@vitejs/plugin-react': '^6.1.2',
        react: '^19.3.1',
        'react-dom': '^19.3.1',
        vite: '^8.3.5',
      },
    }),
    'icon.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8"/></svg>\n',
    'vite.ui.config.ts': `import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Bay UI: loaded from disk by Hangar, so all asset paths must be relative.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/ui'),
  base: './',
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, 'dist/ui'), emptyOutDir: true },
});
`,
    'vite.main.config.ts': `import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Bay main part: one ESM file loaded by Hangar's main process (ADR 0004).
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'src/main/index.ts'),
    outDir: resolve(import.meta.dirname, 'dist/main'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((m) => \`node:\${m}\`)],
      output: { format: 'es', entryFileNames: 'index.js' },
    },
  },
  ssr: { noExternal: true },
});
`,
    'src/main/index.ts': `import type { BayMain } from '@hangar/sdk';

const bay: BayMain = {
  activate(ctx) {
    const greeting = () => ({ text: ${js(`Hallo von ${title}`)} });
    // On the bus and via MCP as \`${id}/greeting.get\` (declared in manifest.json).
    ctx.provide('greeting.get', greeting, { type: 'object', properties: {} });
    // For this bay's own UI: window.hangar.invoke('greeting').
    ctx.ui.handle('greeting', greeting);
  },
};

export default bay;
`,
    'src/main/index.test.ts': `import { describe, expect, it, vi } from 'vitest';
import type { BayContext } from '@hangar/sdk';
import bay from './index';

describe('${id}', () => {
  it('offers greeting.get on the bus and to its UI', async () => {
    const provide = vi.fn();
    const handle = vi.fn();
    await bay.activate({ provide, ui: { handle, send: vi.fn() } } as unknown as BayContext);

    expect(provide).toHaveBeenCalledWith('greeting.get', expect.any(Function), expect.any(Object));
    const greeting = provide.mock.calls[0]![1] as () => unknown;
    expect(greeting()).toEqual({ text: ${js(`Hallo von ${title}`)} });
    expect(handle).toHaveBeenCalledWith('greeting', greeting);
  });
});
`,
    'src/ui/index.html': `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    />
    <title>${html(title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`,
    'src/ui/main.tsx': `import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {} from '@hangar/sdk'; // declares window.hangar

function App() {
  const [text, setText] = useState('');
  useEffect(() => {
    void window.hangar.invoke<{ text: string }>('greeting').then((g) => setText(g.text));
  }, []);
  // Colours, fonts and spacing come from the injected --hangar-* tokens.
  return (
    <main style={{ padding: 'var(--hangar-space-4)', fontFamily: 'var(--hangar-font-sans)' }}>
      <h1>{${js(title)}}</h1>
      <p>{text}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
`,
    'CLAUDE.md': `# bays/${slug} – ${title} (\`${id}\`)

Zweck: UNBEKANNT – beim Ausbau hier eintragen.

## Aufbau

- \`manifest.json\` – Kennung, Funktionen (über Bus und MCP sichtbar).
- \`src/main/\` – läuft im Hauptprozess (Abdeckungs-Gate 90 %).
- \`src/ui/\` – Oberfläche in einer gesandboxten View, nur \`window.hangar\`.

## Funktionen

| Funktion       | Wirkung                                  |
| -------------- | ---------------------------------------- |
| \`greeting.get\` | Beispiel; liefert \`{ text }\` – ersetzen. |

## Fallstricke

- Jede Funktion muss im Manifest deklariert sein, sonst wirft \`ctx.provide\`.
- Für die Auslieferung die Bay in \`apps/desktop/electron-builder.yml\` (\`files\`) eintragen.
- Leitfaden: \`docs/bay-development.md\`.
`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [id, name] = process.argv.slice(2);
  try {
    if (!id) throw new Error('Aufruf: pnpm create:bay <id> [Name]');
    const dir = createBay(id, { root: resolve(import.meta.dirname, '..'), name });
    console.log(`Bay angelegt: ${dir}\nWeiter: pnpm install && pnpm build && pnpm dev`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
