---
name: new-bay
description: Create a new Hangar bay (manifest, main part, UI, tests, docs). Use when a bay/module should be created, e.g. "create a notes bay".
---

# Create a new bay

1. Choose the id (reverse domain, e.g. `dev.hangar.notes`). The folder is named
   after the last segment: `bays/notes/`.
2. Generate the scaffold:
   ```bash
   pnpm create:bay dev.hangar.notes Notizen
   pnpm install
   ```
   Creates `manifest.json`, `package.json`, `icon.svg`, Vite configurations,
   `src/main/index.ts` with a test, `src/ui/` and `CLAUDE.md`. Replace the
   example function `greeting.get`.
3. Write tests first in `src/main/*.test.ts` (the 90 % coverage gate applies to
   `bays/*/src/main`), then the main part. Offer functions: skill
   `add-bay-function`.
4. UI in `src/ui/`: only `window.hangar.invoke/on`, no Node. Colors, font and
   spacing via `--hangar-*` variables (injected, light and dark).
5. Fill in the bay's `CLAUDE.md` (purpose, functions, pitfalls).
6. Delivery: `pnpm create:bay` adds the bay to `apps/desktop/electron-builder.yml`
   under `files`; check the entry.
7. At least one E2E test (skill `write-e2e-test`), then the gates:
   `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`.
8. CHANGELOG entry under `Unreleased`, commit `feat(<slug>): …`.

Reference: `docs/bay-development.md`, ADR 0004 (bay runtime).
