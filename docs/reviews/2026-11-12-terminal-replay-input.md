# Review: keys typed while a terminal replays its scrollback (2026-11-12)

Reviewer: Codex (read-only), two rounds before the commit. Scope: the input
filter in `bays/agents/src/ui/terminals.ts` and `terminals.test.ts`. Codex
checked the filter against the installed xterm 6.0.0 (`InputHandler`,
`Keyboard.ts`) with Node probes; no browser run.

## Findings

1. **[P2] Dropping every escape sequence lost real input** (round 1). The
   first fix forwarded only data without a leading ESC during the replay, so
   bracketed pastes (`ESC[200~…`), Escape, arrows, Home/End, function and Meta
   keys were dropped. Fixed: only data matching xterm's answers (`ANSWER`) is
   dropped. Test: Escape, arrow and a bracketed paste reach the shell.
2. **[P2] ANSI DECRQM answers passed** (round 2). `ESC[4$p` is answered with
   `ESC[4;2$y`, without `?`. Fixed: the `$y` branch takes both.
3. **[P2] F3 with a modifier is dropped** (round 2). `ESC[1;<mod>R` has the
   shape of a cursor report. Left: during the replay only, documented in the
   code and the changelog.
4. **[P3] Pasted OSC/DCS sequences counted as answers** (round 2). Fixed: OSC
   only with `rgb:` (color answers), DCS only as DECRQSS (`P0$r`/`P1$r`).
   Test: a pasted title sequence reaches the shell.

Codex found no C1 (`\x9b`) answers with the default `termName`.

## Verification

`pnpm exec vitest run bays/agents/src/ui/terminals.test.ts`: 12 passed.
Locally, with the filter of round 1: `playwright test e2e/local-server.spec.ts
--repeat-each=5 --retries=0` passed the test 5 of 5 (`:307` failed 2 of 5 with
an unrelated page error, see `docs/STATUS.md`), then `-g "agent bay moves"
--repeat-each=5`: 5 passed. Round 2 only narrows what is dropped (typed text
never matched); with the final code the e2e suite ran in the PR's CI (macOS).
