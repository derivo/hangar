# @hangar/theme

Design tokens as CSS variables (`--hangar-*`) with light and dark mode.

## Interfaces

- `src/tokens.css` – the single source. Importable as `@hangar/theme/tokens.css`.
- `themeCss` – the same content as a string; the shell injects it into every bay
  via `webContents.insertCSS`.
- `readToken(name)` – light value of a token for non-CSS consumers (e.g. xterm.js).

## Pitfalls

- Every `--hangar-color-*` must appear in **three** blocks (light, media query
  dark, `[data-theme='dark']`); the test checks this.
- No color values in components – add new steps here.
- Style per ADR 0026: no bevels, glow only via `--hangar-glow` on the active item.
  Michroma exists only in weight 400; bolder settings would be artificially widened.
- The test checks contrast: text, accent, focus, error and "waiting" ≥ 4.5:1 on all
  surfaces, status lights ≥ 3:1 – light and dark.
