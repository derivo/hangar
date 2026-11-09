# ADR 0009 – Texts and languages

Status: accepted

## Context

All texts were hardcoded in German in the code. Hangar should support German and
English from the start; the default follows the system language. The guideline
is the `webapp-blueprint` checklist, internationalization section: texts not in
code (I18N-01), whole sentences with placeholders (I18N-02), language choice
visible and stored (I18N-05), pseudo-localization in tests (I18N-10), missing
translations are reported (I18N-11).

## Decision

- **Languages:** `de` and `en` (`Locale`). In addition the pseudo-locale `en-XA`
  (`UiLocale`) for tests only: English text, with accents, about 40 % longer, in
  square brackets.
- **Language choice:** `HANGAR_LOCALE` (tests) before the `language` setting in
  `settings.json` (`system`, `de`, `en`) before the system language
  (`app.getPreferredSystemLanguages()`, first entry with `de` or `en`, otherwise
  English). The language applies for the whole run; a change in the settings
  takes effect from the next start. A restart at the push of a button would end
  running agent sessions.
- **Passing it on:** `ctx.locale` in the main part of a bay,
  `window.hangar.locale` in its interface, `window.hangarShell.locale` in the
  shell. The preloads set `<html lang>`.
- **Catalogs without a library:** Each package and each bay has a file
  `messages.ts` with one object per language. Texts with placeholders are
  functions that return whole sentences. The English catalog has the type of the
  German one (`const en: typeof de`); if a key is missing, `pnpm typecheck`
  fails. `catalogFor` (SDK, `@hangar/sdk/i18n`) selects the catalog, `setLocale`
  sets it once at start, `t` is the active catalog.
- **Plural** is handled by the catalog function of the respective language
  itself; for German and English the distinction "exactly 1" is enough.
- **Texts for agents stay English:** function descriptions in the manifest,
  errors of the bus, MCP server and bay functions. They address models, and tool
  descriptions should not change with the user's language.
- **Diagnostics for bay developers stay English:** load and manifest errors,
  missing handlers, undeclared functions.
- **CLI:** `LC_ALL`, `LC_MESSAGES`, `LANG` (in this order); German if the value
  begins with `de`, otherwise English. The CLI stays free of dependencies.

## Consequences

- Unit tests run with the German catalog (default of `t`) and check literal
  texts, never values from the catalog itself. For English, one test per
  interface checks after `setLocale('en')`.
- E2E tests start with `HANGAR_LOCALE=de`. `e2e/i18n.spec.ts` checks English
  (with axe), the switcher via a restart, and the pseudo-locale: every visible
  text and every accessible name carries the brackets, except user data, and at
  200 % zoom nothing overflows sideways.
- The names of the languages in the switcher are in their own language
  ("Deutsch", "English") and carry `lang`.
- Further languages need a catalog per package and bay and an extension of
  `Locale`; right-to-left writing direction is not prepared.
