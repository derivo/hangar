# ADR 0023 – Bay settings in the Hangar settings

Status: accepted. Extends [ADR 0017](0017-bays-in-the-sidebar.md); type `text`
since [ADR 0025](0025-session-shell-prompt.md).

## Context

The agent bay gets "Selecting copies to the clipboard" as a switch per session.
Whether it is on or off for new sessions should be set once by the person, in
one place for all app settings. So far bays have no settings that Hangar knows
about; each would have to build its own UI for them.

## Decision

- **Declared in the manifest:** `settings` is a list of
  `{ key, type: 'boolean', default, label: { de, en }, description?: { de, en } }`.
  Only `boolean` at first; more types come with the first need.
- **Stored in `settings.json`** of the app under
  `baySettings[<bay-id>][<key>]`; only declared keys with a matching type,
  otherwise `default` applies.
- **Display:** The settings show one section per bay in the sidebar that has
  settings, with its name, and per setting a checkbox with label and
  description in the app language.
- **For the bay:** `ctx.settings.get(key)` returns the current value,
  `ctx.settings.onChange(listener)` reports changes with `{ key, value }`.
  A bay's UI gets no interface of its own; it asks its main part.
- **Server:** Bays on a Hangar server read the server's `settings.json`; the
  desktop app does not show their settings (later, if needed).

## Alternatives

- **Own settings in every bay:** no SDK change, but scattered settings and
  duplicated work per bay.
- **Free values without declaration:** saves the manifest field, but Hangar
  could neither show nor check them.
