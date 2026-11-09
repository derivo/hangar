# ADR 0039 – Documentation in English

Status: accepted 2026-11-04.

## Context

The repository is on GitHub (`derivo/hangar`). Its documentation was written in
German: README, `docs/` with ADRs and review records, the `CLAUDE.md` files,
`AGENTS.md`, the project skills and the CHANGELOG. Code comments and commit
messages were already English. The app itself speaks German and English
(ADR 0009).

## Decision

- All documentation is English: README, `docs/` (including ADRs and review
  records), every `CLAUDE.md`, `AGENTS.md`, `.claude/skills/*/SKILL.md` and the
  CHANGELOG. File names of docs are English too.
- The existing documentation was translated once, review records included; the
  old German file names were renamed and every reference adjusted.
- UI texts stay in both languages as ADR 0009 sets out. Docs quote a UI label
  with its English text from the `en` catalog.
- Code comments and commit messages stay English.

## Consequences

- `AGENTS.md` carries the rule (rule 9), so agents write new docs in English.
- German strings remain where they are data: the `de` catalogs, tests that
  assert German UI texts, and examples of German catalog entries.
