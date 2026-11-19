# Review: grid fields shrink instead of scrolling (2026-11-19)

Reviewer: Codex (`codex exec -s read-only`), one round on the diff of branch
`fix/grid-shrink` (first version: fields shrink to `minmax(0, 1fr)`).

## Findings and outcome

1. **P1 – content of a shrunk field covers the neighbouring field.** Confirmed.
   The extended `e2e/grid.spec.ts` measures content larger than its field with
   `overflow: visible` (`spills`); at 200 % zoom it was `true` with the first
   version (red), at 100 % `false`. The screenshot showed the header filling the
   field and no terminal rows. Fixed: fields shrink only down to 30 × 4
   characters plus header, below that the grid scrolls; `.field` has
   `overflow: auto`. Test green.
2. **P2 – the shrink test used empty fields only.** Confirmed. The test now
   opens a session in each of the three fields and checks with `stty size` that
   the terminal of a shrunk field has fewer than 16 rows or 60 columns.
3. **P3 – ADR 0048 promised "no scrollbars" while keeping `overflow: auto`.**
   Confirmed. ADR 0048 now states the 30 × 4 limit and that the grid still
   scrolls below it (200 % zoom).

A first attempt at the P1 check (`elementFromPoint` at the corners of each
field) stayed green on the faulty version and was replaced by the `spills`
measurement.
