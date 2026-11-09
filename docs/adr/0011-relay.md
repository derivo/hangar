# ADR 0011 – Hangar Relay

Status: accepted, implemented in phases 13–17 (concept:
[concept-relay.md](../concept-relay.md))

## Context

Several Hangar instances should work together through a server: share status and
summaries, call shared functions remotely. For this the bus has had a
`Transport` interface since the MVP; but `Caller` and the "own bay" rule only
know local callers.

## Decision

- **Relay as a pure intermediary:** Instances open an outgoing WebSocket
  connection over TLS; the relay forwards and stores no content.
- **End to end:** Content is encrypted per target instance and signed by the
  sender instance (Ed25519, X25519 with HKDF, XChaCha20-Poly1305, header as
  authenticated data). Trust arises only from fingerprints of signed identity
  documents confirmed by both sides and from a versioned member list signed by
  members, not from the relay. Revocation takes effect immediately for reachable
  members, otherwise after at most seven days.
- **Bus:** new caller `remote` with instance fingerprint and workspace; the
  "own bay" rule never applies to it; before any stored permission the bus
  checks membership, share list and "not sensitive"; remote functions live in
  the namespace `remote.<instanz>.<bay-id>/<funktion>` (prefix `remote.` is
  blocked for local bays); permissions attach to the fingerprint, not the name;
  only what carries `remote: true` in the manifest can be called remotely.
- **Protocol:** versioned envelope, version negotiation at `hello`, the server
  also supports the previous version.

## Implementation

- Phase 13: `Caller` `remote` in the bus, prefix `remote.`, manifest `remote`.
- Phase 14: `packages/relay`. Deviation from the concept: The seven days count
  per member from the newest list that another instance has signed, not from the
  issue of the list; otherwise a revoked member would extend itself
  ([review](../reviews/2026-11-01-phase-14-relay-crypto.md)).
- Phase 15: `apps/relay` and `RelayClient`. The relay orders the versions of the
  member list; an instance adopts its own change only after the relay's
  confirmation, so that simultaneous changes do not diverge. `announce` carries
  the sender's list, so that a list withheld by the relay still arrives.
  Arguments are not checked against `inputSchema` (no validator in the repo);
  that stays with the handlers
  ([review](../reviews/2026-11-02-phase-15-relay-server.md)).

## Alternatives

- **Peer-to-peer without a server:** fails because of NAT and corporate
  networks.
- **Relay with plaintext content:** simpler, but every operator would see jobs,
  code summaries and results.
- **Permissions per workspace instead of per instance:** fewer dialogs, but a
  new member would inherit all approvals.

## Consequences

- Before any implementation, the bus must restrict the "own bay" rule to local
  callers (`packages/bus/src/bus.ts:134`); otherwise a remote caller with the
  same bay id satisfies it.
- New package `packages/relay` and a separately operated relay server.
- Handovers between agents need a local implementation first.
- The receiver keeps replay state permanently (epoch, number) and writes it
  before execution.
- Review: [reviews/2026-10-28-relay-registry.md](../reviews/2026-10-28-relay-registry.md).
