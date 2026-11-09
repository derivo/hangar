# ADR 0027 – Shortcuts in the sidebar

Status: accepted.

## Context

Besides the bays, one often needs the same programs, folders, files and web
pages while working (editor, project folder, ticket system). The sidebar is the
place where Hangar holds the person's tools; these targets should also be
reachable there with one click, without a bay of their own.

## Decision

- **Targets:** programs, folders, files (absolute path) and web pages (only
  `http`/`https`). Hangar opens them with the system: paths through
  `shell.openPath` (start programs, folders in the file manager, files in the
  associated program), web pages through `shell.openExternal` in the default
  browser – not in a bay's browser tab.
- **Adding** in the plus modal, which is therefore titled "Add to sidebar":
  "File or program …" and "Folder …" open the file dialog (two buttons, because
  Windows and Linux do not allow file and folder in one dialog), the "Website"
  field takes an address. An address without `http://`/`https://` is rejected,
  not completed. A target that is already in the sidebar is not added twice.
- **Display:** below the bays (and servers), above the plus, separated by a
  line. Icon on macOS and Windows from `nativeImage.createThumbnailFromPath`
  (`app.getFileIcon` returns only an empty default icon for programs on macOS),
  on Linux from `app.getFileIcon`; web pages show a globe,
  paths without an icon (such as a deleted folder) a file symbol. Name: the last
  part of the path without `.app`, for web pages the host. The tooltip
  additionally shows the whole target.
- **Opening:** click. The renderer sends only the shortcut's identifier; the
  main process reads the target from `settings.json`. If opening fails (path
  missing), Hangar shows a notice with the system's reason.
- **Removing:** right-click (or context menu key) → "Remove from sidebar", as
  with bays (ADR 0017).
- **Storage:** `settings.json` holds `shortcuts` as a list of `{ id, target }`
  in order. On reading, only entries with an absolute path or an
  `http`/`https` address are kept.

## Alternatives

- **Web pages in a bay's browser tab:** requires the browser bay and separates
  it from logins in the person's own browser; rejected.
- **Complete an address without scheme with `https://`:** more convenient, but
  for inputs such as `localhost:3000` Hangar guesses wrong; the message says
  what is missing.
- **Own file `shortcuts.json`:** the sidebar is already in `settings.json`.

## Consequences

- A program from the sidebar starts with the person's rights – like a double
  click in the file manager. Hangar runs only what the person chose themselves;
  bays and agents cannot create shortcuts.
- On Linux `shell.openPath` hands over to `xdg-open`, which does not start
  executable files (ELF, AppImage) but only opens files with an associated
  program. Programs can be linked there through their `.desktop` file. Hangar
  deliberately does not run files itself.
- Moved targets stay as an entry until they are removed.
