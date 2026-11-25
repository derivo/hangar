# Review: macOS update via the release page (2026-11-25)

Reviewer: Codex (`codex exec -s read-only`), on the first commit of
`feat/update-macos-manual`. Focus: URL allow-list bypasses in `isReleasePage`
(`apps/desktop/src/main/host.ts`), state transitions in `updates.ts`, test gaps.

Result: Codex reported no findings. It probed 400 generated URLs (0 left
`https://github.com/derivo/hangar/releases/`) and replayed the signature error
transitions (`available`/`ready` → `manual`, repeated error, new check → `manual`
with the new version).

## Own follow-up on a Codex probe

| #   | Sev. | Finding                                                                                                                                                                                                                 | Checked                                                                                                                 | Change                                                                                                                                                       |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | low  | One of Codex's probes, `https://github.com/derivo/hangar/releases/%2e%2e%2f%2e%2e%2flogin`, passed the check: URL parsing does not decode `%2f`, so the string came back unchanged, but GitHub's server could decode it | Confirmed: `new URL(u).href === u` is `true` for it (node); the target stays on `https://github.com`, not a host bypass | `isReleasePage` also rejects any `%`; the renderer no longer percent-encodes the version (electron-updater versions are semver). Test case in `host.test.ts` |

## Not checked

- A real packaged build on macOS (shares the bundle id `dev.hangar.app` with the
  installed Hangar); the Squirrel.Mac message comes from the observed 0.8.9 → 0.9.0 run.
