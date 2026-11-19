# Review: "Add to sidebar" picker layout (2026-11-18)

Reviewer: Codex (`codex exec -s read-only`), one round on the diff of branch
`ui/picker-layout`.

## Context

The picker dialog drew the global `:focus-visible` outline
(`packages/theme/src/tokens.css`) around the `<dialog>` itself, and its layout was
loose: the website field and its button sat in separate rows, the hint stood far
from the field, "Connect to server" had no heading, and Cancel shared the row with
it. The change removes the outline on `.picker:focus-visible` only, puts field and
button in one row with the hint directly below, adds a "Server" section heading and
moves Cancel alone to the bottom right below a border.

## Findings

No findings (label association, accessible names, focus rings of the controls, CSS
side effects on `.pairing`, `.workspace-form` and `.field`).

Codex could not start Vitest in its read-only sandbox (`EPERM` on `.vite-temp`) and
ran no e2e, axe or zoom check; those were run outside the sandbox (below).

## Verification

- Red test first: `sidebar-bays.spec.ts` forces `:focus-visible` on `dialog.picker`
  via CDP and expected `outline-style: none`; it received `solid` before the fix.
- e2e `sidebar-bays`, `shortcuts`, `server`, `chaos`: 11 passed, including axe-core
  with 0 violations on the picker in light and dark mode.
- Keyboard: tab order file, folder, address, "Add website", "Connect to server",
  Cancel; Escape closes.
- 200 % zoom: the dialog scrolls (`overflow-y: auto`), Cancel stays reachable, no
  horizontal overflow.
- `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test` 1541 passed, 2 skipped;
  Prettier check on the touched files exit 0.
