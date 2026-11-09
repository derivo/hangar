# Review: Relay and Registry concepts

Date: 2026-10-28. Reviewer: Codex (`gpt-6.1-sol`, `codex exec -s read-only`).
Subject: [concept-relay.md](../concept-relay.md),
[ADR 0011](../adr/0011-relay.md), [concept-registry.md](../concept-registry.md),
[ADR 0012](../adr/0012-registry.md), checked against the code (`packages/bus`,
`packages/mcp`, `packages/sdk`, `apps/desktop/src/main`, `bays/agents`).

Every finding was checked against code or source before it was accepted.
Result: 20 findings (10 high, 10 medium), all accepted; two of them were bugs
in the existing code and are fixed.

## Code findings

| No. | Finding                                                                                                                    | Check                                                      | Consequence                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 18  | Manifest accepts `01.0.0`, rejects `1.0.0+build.1`; `semver.lt` in the bay loader throws on `01.0.0` as `minHangarVersion` | Read the regex in `packages/sdk/src/manifest.ts`; red test | Fixed in `02c79f1` (SemVer 2.0.0 grammar), tests in `manifest.test.ts`                |
| 14  | `relativePath` accepts UNC paths (`\\server\share\…`) and does not check symlink targets                                   | Read the regex; red test for UNC                           | UNC fixed in `02c79f1`; symlinks and real boundaries belong in the unpacker (concept) |

## Relay

| No. | Severity | Finding                                                                                           | Change in the concept                                                                                         |
| --- | -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 3   | high     | "Workspace key" undefined; X25519 not bound to the confirmed Ed25519 fingerprint                  | Signed identity document with both keys; workspace without its own key, signed list                           |
| 4   | high     | `Caller` without workspace; a stored `allow` overrides the share list                             | `Caller` with workspace; membership, share and "not sensitive" before any stored permission                   |
| 5   | high     | Revocation can be withheld through a compromised relay                                            | Versioned, signed member list, compared at `hello`, at most seven days old; limit stated                      |
| 6   | high     | No concrete format: key derivation, nonce, signed bytes, header binding                           | HKDF per direction, random 192-bit nonce, canonical header as AAD, signature over header + nonce + ciphertext |
| 7   | high     | Replay after a restart if the receive state is lost                                               | Epoch per connection, state persisted before execution, deduplication via call ID                             |
| 8   | high     | Permissions for outgoing calls hang on the changeable name `remote.<short>`                       | Permissions bound to the fingerprint, name is display only                                                    |
| 12  | medium   | `safeStorage` does not protect everywhere (Linux `basic_text`, Windows DPAPI per user)            | Limits stated; relay refuses on `basic_text`. Source: Electron docs `safeStorage`, read                       |
| 13  | medium   | Manifest accepts `remote.anna-laptop.dev.hangar.agents`; namespace collides                       | Prefix `remote.` reserved for local bays                                                                      |
| 20  | medium   | Agent functions require a local session (`functions.ts:24`); a share alone makes nothing callable | `remote: true` per function; a remote `sessionId` never counts as a local session                             |

## Registry

| No. | Severity | Finding                                                                              | Change in the concept                                                                               |
| --- | -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | high     | `utilityProcess` is not a security boundary (full Node access)                       | Stage B only with an operating system sandbox; source: Electron docs `utilityProcess`, read         |
| 2   | high     | Any bay can call `registerAgentSession` and call as a session, bypassing `uses`      | Capability `agentSessions` in the manifest, otherwise no session token                              |
| 9   | high     | Package storage would sit in the bay's writable data folder (`<userData>/bays/<id>`) | Packages under `<userData>/packages/`, written by the host only                                     |
| 10  | high     | Rollback of the code without rollback of the data                                    | `dataVersion`, backup before the switch, restore on rollback                                        |
| 11  | medium   | Publisher key not authenticated against publisher and prefix                         | Signed `publishers.json` with prefixes, keys, validity, revocation                                  |
| 15  | medium   | No limits against decompression bombs                                                | Limits for size, entries, file, file types                                                          |
| 16  | medium   | Function becomes sensitive later, old `allow` still applies                          | Part of the approval diff; old `allow` permissions are reset                                        |
| 17  | medium   | "Without native modules" contradicts ADR 0004 and `node-pty`                         | `hostModules` in the manifest, resolved only from the app package                                   |
| 19  | medium   | Precedence of bundled bays prevents updates of `dev.hangar.agents`                   | Registry version of the same publisher replaces the bundled one, local development takes precedence |

## Open

- Whether an operating system sandbox is viable on all three platforms
  (registry stage B) is decided by a separate ADR.
- The seven days for stale member lists are a starting value, not measured.
