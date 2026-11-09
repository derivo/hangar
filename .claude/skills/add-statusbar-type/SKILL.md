---
name: add-statusbar-type
description: Add a new display type for the status bar of the agent bay (besides text, path, bar, badge). Use when agents should be able to display segments differently.
---

# Add a new status bar type

All places that list the types:

| File                                          | Change                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| `bays/agents/src/main/types.ts`               | extend `SegmentType`                                 |
| `bays/agents/src/main/functions.ts`           | `z.enum([...])` in the segment schema; extra rules   |
| `bays/agents/src/ui/Statusbar.tsx`            | `case` in `SegmentValue`                             |
| `bays/agents/src/ui/styles.css`               | style `.segment-type-<type>` using only `--hangar-*` |
| `packages/cli/src/cli.ts`                     | `USAGE` and call hint (`--type <…>`)                 |
| `docs/mcp.md`, `docs/specification-mvp.md` §6 | table of the types                                   |

Procedure:

1. Tests first: `functions.test.ts` (type is accepted, extra rules with
   exact error text), `Statusbar.test.tsx` (rendering, role/name for
   screen readers), `cli.test.ts` (help text).
2. Implement. Prefer native elements (`bar` uses `<meter>`).
3. Extend `apps/desktop/e2e/m7-notify.spec.ts` with the type and run
   `apps/desktop/e2e/a11y.spec.ts` (light and dark, 0 findings).
4. Gates, CHANGELOG, commit with trailer `A11y-Check: …`.
