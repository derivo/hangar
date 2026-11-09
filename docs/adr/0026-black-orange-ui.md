# ADR 0026 – Black and orange UI with fine lines

Status: accepted. Replaces the style of `docs/mockups/hangar-ui.html`.

## Context

The UI had beveled corners (`clip-path`), a blueprint grid in the background,
cyan as accent and Chakra Petch for headings. What was wanted was a more
minimal but futuristic style: fine lines, no slanted corners, glowing lines,
rather dark, somewhat lighter than before, black and orange. Several drafts
were rejected (a line from the tree to the field, plum gray); accepted is
`docs/mockups/hangar-minimal.html`.

## Decision

- **Colors:** neutral dark gray instead of blue-black (`#111214`), accent orange
  (`#ff8a2a`, light `#b34a00`), "waiting" yellow, so that it stands out from
  "working" (orange). The sidebar stays dark in both modes, because the bays'
  icons are light images; its orange is in `--hangar-color-dock-glow`.
- **Shapes:** no more bevels; surfaces with `--hangar-radius`, buttons 4 px. No
  grid in the background. `--hangar-cut` and `--hangar-color-grid` are removed.
- **Glow only on the active element:** new token `--hangar-glow` (shadow in
  `--hangar-color-glow`) on the focused field, on the selected session, on the
  edge of the active bay and on the filled part of the scales.
- **Typeface:** Geist Mono for the UI, Michroma (weight 400 only) for a few
  headings. `--hangar-font-sans` is kept for bays.
- The theme switch above the settings stays as it is.
- A test in `@hangar/theme` keeps text, accent and status above 4.5:1 and 3:1
  respectively (lights) in both modes.

## Consequences

- Third-party bays that use `--hangar-cut` or `--hangar-color-grid` lose these
  values; no bay in the repository uses them any more.
- Headings in Michroma are wide; they stay small (12–20 px).
