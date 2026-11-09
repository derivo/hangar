# Review sorting and collapsing projects, first click (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Content:
sorting projects in the project tree by drag and drop and via "Move project
up/down" (`moveProject`, channel `project.move`), collapsing projects with
sessions (`collapsedProjects` in `localStorage`), `acceptFirstMouse` for main
window and bay window.

## Findings

1. **[P2] Broken stored value blocks the bay.** `collapsedProjects` was parsed
   unchecked; `[`, `null` or `{}` threw. **Fixed:** not an array → empty list.
   Test "ignores a damaged list of collapsed projects".
2. **[P2] Index without a check.** `project.move` with text, a negative or a
   fractional number moved the project to a wrong place. **Fixed:** whole
   numbers from 0 only, otherwise "Invalid position" and no change
   (`sessions.test.ts`).
3. **[P2] Projects with the same name cannot be told apart when collapsed.**
   **Partly adopted:** when collapsed, the project's tooltip names the path.
   Identical button names for screen readers ("New session in shop") existed
   before; not changed.
4. **[P3] Marker when dragging down.** The line stood above the target, the
   project landed below. **Fixed:** when dragged down the line stands below the
   target (`drop-after`), test in `ProjectTree.test.tsx`.
5. **[P3] Restart tests checked the initial order.** **Fixed:**
   unit test reads again after the first move, E2E restarts with a changed
   order.
6. **[P3] First click only checked against the fake.** Correct; Playwright
   cannot reproduce an inactive macOS window. Open: check by hand.

## Not checked

Whether native dragging also works with the trackpad and in undocked windows as
in `e2e/project-order.spec.ts` (mouse via Playwright).
