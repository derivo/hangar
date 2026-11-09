---
name: write-e2e-test
description: Write an end-to-end test for the Hangar Electron app with Playwright. Use for every milestone, every new bay and every visible behavior.
---

# Write an E2E test

Tests live in `apps/desktop/e2e/*.spec.ts` and run against the built app
(`out/`). `pnpm test:e2e` builds first.

Helpers from `e2e/helpers.ts`:

| Helper                               | Purpose                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `launch({ bayDirs, env, userData })` | Start the app with its own data folder; returns `{ app, shell, userData }` |
| `bayPage(app, urlPart)`              | Find the page of a bay view (or of the shell) by URL                       |
| `createRepo(name)`                   | Temporary Git repository                                                   |
| `agentsEnv()`                        | Predictable shell (`/bin/sh`) and empty `HOME`                             |
| `mockFolderPicker(app, dir)`         | Replace the folder dialog in the main process                              |
| `fixturesBays`, `repoBays`           | Test bays and the real bays, respectively                                  |

Rules:

- Import `test` and `expect` from `./helpers`, not from `@playwright/test`:
  There, every test fails in which a page throws an unhandled error.
- A new button that creates, runs, opens or deletes (also a send button):
  check in `e2e/chaos.spec.ts` with `burst` (multiple clicks) that it happens
  exactly once (ADR 0028). Rule out rare failures with `--repeat-each 10`.
- Always `try { … } finally { await app.close(); }`.
- Selectors by role and accessible name (`getByRole`), not by CSS.
  This also checks accessibility.
- Terminal input: focus `.xterm-helper-textarea`, `keyboard.type(...\n)`.
- Notifications: with `HANGAR_E2E=1` (set by `launch`) they end up in
  `globalThis.__hangarNotifications` in the main process (`app.evaluate`).
- Under `HANGAR_E2E` windows stay invisible and take no focus;
  to watch, set `HANGAR_E2E_SHOW=1`.
- Test a restart: `launch` twice with the same `userData`.
- Test the packaged app:
  `HANGAR_E2E_EXECUTABLE=<path to the binary> pnpm --filter @hangar/desktop exec playwright test`
  (uses the bundled bays instead of `repoBays`).
- Visible UI changed → extend `e2e/a11y.spec.ts`.
