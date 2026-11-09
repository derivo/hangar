# Review phase 22: security hardening (2026-11-09)

Reviewer: Codex (gpt-6.1-sol, read-only), after the commits. Scope:
`c451e29..b76c4ab`, 16 commits, 52 files:

- `23ebe20` job process tree on Windows (`taskkill /T /F`)
- `4caf59f` `packBay` only for ids under `dev.hangar.`
- `a59916c` `.bay` paths only printable ASCII
- `2b0d90f` the agent bay's own git calls without `GIT_*`
- `fd259c3` scrollback line search limit named
- `ff8b82a` `ponytail:` markers dropped from comments
- `b2c9fe5` CLI entry point out of coverage
- `24a8ceb` `create:bay` enters the bay in `electron-builder.yml`
- `6ed3fef` agent bay refuses work once 100 tasks wait
- `2b7375f`, `b76c4ab` MCP rate limit per session token (now burst 100,
  600 per minute)
- `fec913b` test: parallel writes of `servers.json`
- `2470911` test: where the agent bay runs after a move that broke off
- `f58f7e1` test: replay state after a SIGKILL during writing
- `3efbf15` `-o StdinNull=no` from OpenSSH 8.7 on
- `04bcd68` relay keys encrypted with `HANGAR_KEY_PASSPHRASE`

Codex type-checked (exit 0) and ran write-free checks; Windows process
behaviour was modelled, not run natively; the repository tests and E2E were
not run in its sandbox.

## Findings

1. **[medium] `GIT_*` filter case-sensitive.** Windows reads environment names
   case-insensitively, so `git_dir` or `Git_Config_Count` still reached git in
   the agent bay and in `checkedFolder` of the server. **Fixed** in `3a75a9b`
   (`/^git_/i` in `bays/agents/src/main/git.ts` and `withoutGitVars` in
   `apps/server/src/options.ts`, tests with mixed case).
2. **[medium] A failed `taskkill` leaves a job running.** If the shell is gone
   and a child holds the output pipes, `done` waits for `close` forever.
   **Fixed** in `3364e54`: 2 s after a kill the job closes stdout and stderr
   itself, so the run rejects (all platforms; test with a child outside the
   process group). The Windows test now checks the timeout message.
   **Accepted limit:** no Windows Job Objects; a shell that survives a failed
   `taskkill` still keeps its run open.
3. **[medium] Missing or wrong passphrase stops the desktop start silently.**
   `new Workspaces(...)` threw on `pass:` keys it could not open; the in-app
   relaunch lost the passphrase deleted from `process.env`. **Fixed** in
   `d9cae08`: an error box ("Workspaces not available …") and a start without
   workspaces, the identity file untouched; `takePassphrase` keeps the value and
   puts it back before `app.relaunch()`. `index.ts` has no unit tests (E2E
   only); the helper is tested, a relaunch with a `pass:` identity is not.
4. **[medium] Removing the passphrase from `process.env` is no protection
   against agents.** On Linux `/proc/<pid>/environ` keeps the original
   environment for the same user. **Fixed** in `9d021ac` (wording in ADR 0030,
   `apps/server/CLAUDE.md`, CHANGELOG: it stops inheritance only; the
   passphrase protects keys at rest). **Accepted limit:** real protection
   against processes of the same user needs a separate user.
5. **[low] Rate limit buckets never pruned.** One bucket per token ever used.
   **Fixed** in `3e34fb0`: `rateLimiter` sweeps full buckets once it holds 1000.
6. **[low] Clock set back drains buckets.** **Fixed** in `d531d54`:
   `performance.now()`, test with the system clock set back one hour.
7. **[low] High-bit test proves no traversal.** `0xAE 0xAE` → `..` was already
   refused by the path check. **Fixed** in `f932f85`: a harmless byte (`0xE9`,
   written as `i` before) is pinned, and the CHANGELOG describes the change as
   strict ASCII paths.

## Found fine

- Passphrase cryptography: 16-byte salt, 12-byte IV, 32-byte key, full 16-byte
  GCM tag, scrypt N=32768 r=8 p=1 with 64 MiB `maxmem`; no plaintext before
  `final()`, 73 tampered or truncated values refused. Existing `plain:` keys
  stay plain and the move to the local server stays `plain:`, as documented.
- `packBay` prefix, ASCII tar paths (`latin1` keeps the bytes for the check).
- Scrollback constant, removed markers, CLI coverage exclusion (the entry point
  is tested through child processes).
- `create:bay` YAML block (LF enforced by `.gitattributes`).
- Queue cap: at most 100 open tasks including the running one; `finally`
  releases on errors.
- `servers.json` test: right for one `ServerConnections`; not for several
  writing processes.
- Migration fallback test: a real break after the data moved; it shows where
  the data lies, not server health.
- Replay crash test: real writer and hard kill; no power loss (documented).
- OpenSSH `StdinNull`: the 8.7 boundary and the Windows version format are
  right; no test with a real tunnel and `StdinNull yes`.
