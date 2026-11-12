# Review: the local server's UI from its own copy (2026-11-12)

Reviewer: Codex (read-only), before the commit. Found in the maintenance review
of 2026-11-11: `localBundle` in `apps/desktop/src/main/host.ts` preferred the
app's bundle over the server's runtime copy when id and manifest version
matched. Bays keep their version across builds, so after an app update the old
server got the new UI (ADR 0036, point 5). Fixed: for the local server the copy
comes first, and `serverUiRoots` names only the copy of the build it runs.
Codex checked the extracted methods in memory (six cases); no Electron or
launchd run.

## Findings

1. **[P2] A view kept the bundle it was created with.** The app connects
   before `localServerVersion` is known, so with two copies of the same bay
   version (after a failed restart) the first match could be the wrong copy;
   once the build was known, `syncRemotes` kept the existing view. Fixed: a
   view whose bundle (`dir`) changed is closed and created anew. Test in
   `host.test.ts`.
2. **[P3] Remote servers no longer find UIs in other local copies.** The
   roots are now limited to the running build for every server. Accepted: a
   remote bay whose only matching UI lies in a stale copy of the local server
   is hidden; the app's own bundles and installed bays still match, and stale
   copies go at the next successful restart.

## Verification

`pnpm exec vitest run apps/desktop/src/main/host.test.ts
apps/desktop/src/main/local-server.test.ts`: 143 passed; the three new tests
were red before their fix.
