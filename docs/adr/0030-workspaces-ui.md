# ADR 0030 – Workspaces in the UI

Status: accepted (Phase 16; concept: [concept-relay.md](../concept-relay.md),
relay: [ADR 0011](0011-relay.md))

## Context

Phase 15 delivers the relay and `RelayClient`, but no instance uses them.
Phase 16 is to let people set up workspaces and show what other instances are
working on: instance, project, session, status, description.

## Decision

- **One relay connection per Hangar.** Address, trusted workspaces
  (`StoredWorkspace`), share lists and confirmed inviters are in
  `<userData>/workspaces.json`; the identity in `relay-identity.json`, the
  private keys encrypted with `safeStorage` (E2E: `use-mock-keychain`, so that
  no keychain dialog stops the tests). Logic without Electron in
  `packages/host/src/workspaces.ts`.
- **Status as a message of its own, not as a bay function.** A query through a
  function would need permission dialogs on both sides for every query. For
  this, `RelayClient` knows the encrypted message `state` (bay identifier and
  state); the bay decides what it shares. SDK: `ctx.workspaces.publish(state)`
  and `ctx.workspaces.onState(listener)`, only with
  `hostModules: ["workspaces"]`. A state goes only to the same bay identifier of
  the other instance and carries instance (name, fingerprint) and workspace:
  the origin is always recognizable.
- **Sharing per project, off by default.** The agent bay shares only sessions of
  projects with "Share in workspaces"; a status change or a new description
  sends the state again. The sharing applies to all workspaces of the instance
  (deviation from the concept, which lets one choose per workspace: less
  operation, until someone uses several workspaces with different circles).
- **Confirm fingerprints on both sides.** The invitation names workspace,
  invitation token and the inviter's fingerprint; whoever joins enters it
  (second channel). The inviter then sees "wants to join" with the new
  instance's fingerprint and accepts or rejects it.
- **Share list per function** in the settings: all functions with
  `remote: true`, selectable or deselectable per workspace; then `announceAll`.

## Consequences

- With `workspaces`, bays get a new host module; without a relay (for example on
  the Hangar server) `publish` has no effect and `onState` reports nothing.
- A bay's state is an envelope like any other for the relay; it sees neither
  project nor session names.

## Implementation

- Relay address only `wss://`, `ws://` only on `localhost`, `127.0.0.1` or
  `[::1]` (`Workspaces.connect` otherwise throws `Invalid relay address`).
- Whoever joins waits until a list of the confirmed inviter contains their own
  instance; the list that the relay sends along on joining does not contain it
  yet (found in E2E, test in `apps/relay/src/client.test.ts`).
- Only the inviter accepts: The relay remembers per invitation who created it
  and names them in `joined` (`inviter`). Other members see the request and can
  reject it, but not accept – the joiner trusts only a list from the inviter.
- Every instance re-signs its lists after one day (`renewMs`), so that a
  workspace without membership change does not fall silent after seven days.
- Without an available keychain (`safeStorage.isEncryptionAvailable()` false,
  such as Linux without Secret Service) the keys are stored unencrypted in
  `relay-identity.json` (mode 600, prefix `plain:`); with a keychain `safe:`.
  Addendum (S2): if `HANGAR_KEY_PASSPHRASE` is set, keys written without a
  keychain are encrypted instead (`pass:`, scrypt N=2^15 + AES-256-GCM,
  `keysWithoutKeychain` in `@hangar/host`); `plain:` is still read. It applies
  when the keys are written, i.e. to a new identity; an existing `plain:` file
  stays as it is. App and server remove the variable from their environment after
  reading it, so session shells and jobs do not inherit it. The local server
  (ADR 0036) still gets the keys as `plain:` from the app.
- Settings: `apps/desktop/src/renderer/Workspaces.tsx`; agent bay:
  `bays/agents/src/main/share.ts`, `src/ui/RemoteList.tsx`. E2E with two
  instances and a local relay: `apps/desktop/e2e/workspaces.spec.ts`.
