# @hangar/relay

Cryptography between Hangar instances (ADR 0011, [concept-relay.md](../../docs/concept-relay.md)):
identity, member list, envelope, protection against replay, protocol to the
relay and `RelayClient` (transport in the bus). The server is in `apps/relay`.
No Electron dependency.

## Interfaces

- `createIdentity(name)` → `Identity` (Ed25519 for signing, X25519 for
  key exchange); `IdentityDocument` is self-signed, `fingerprint(doc)` =
  SHA-256 of the canonical document. `verifyIdentity(doc)`, `exportIdentity` /
  `importIdentity` (PKCS#8; checks that the keys match the document).
- `Workspace` – trusted member list: `Workspace.found(name, founder)`,
  `new Workspace(list, now?, vouched?)` (first list, trust via confirmed
  fingerprints; stored with `vouchedTimes`), `accept(list, now?)` (newer
  version, signed by a member of the current list, no revocation dropped,
  `issued` at most 5 minutes ahead), `next(signer, change)` (also for
  renewing), `member(fp)` / `isMember(fp)`: only if a **different** instance
  confirmed the member by list within the last 7 days (`vouchedTimes`).
- `seal(sender, recipientDoc, header, text)` / `open(recipient, senderDoc, envelope)` –
  XChaCha20-Poly1305 (`@noble/ciphers`), key per direction via HKDF-SHA256
  from X25519, canonical header as AAD, Ed25519 over length + header + nonce +
  ciphertext.
- `ReplayGuard(file)` – last number per sender and epoch, read
  fresh before every check, written atomically and with `fsync` to disk before execution;
  time window ±5 minutes.
- `Endpoint(identity, workspace, guard)` – `send(to, text)`, `receive(envelope)`
  in the right order (member → signature/decryption → replay).
- `canonical(value)` – JSON with sorted keys, without whitespace.
- `protocol.ts` – `ToRelay`/`FromRelay`, `RELAY_VERSIONS`, `MAX_MESSAGE_BYTES`
  (1 MiB), `signedChallenge(nonce)`. Flow: `hello` → `challenge` → `prove` →
  `ready` (workspaces with the current list). `joined` names the inviter (`inviter`);
  the client discards `joined` with an invalid identity document. The proof is bound to the address of the
  relay (`signedChallenge(nonce, origin)`). `undeliverable` names `offline` or
  `refused`.
- `RelayClient.connect(options, stored)` – connection of an instance; trusts the
  stored workspaces (`StoredWorkspace {list, vouched}`, changes via
  `onChange`). `create`, `invite`, `join` (`'trusted'` or `'waiting'` until the
  confirmed inviter signs a list), `addMember`, `removeMember`, `renew`.
  Remote bays appear in the bus as `remoteBayId(doc, bayId)` =
  `remote.<name>-<fingerprint>.<bay-id>` (whole fingerprint, permissions hang on it); `announce` carries the own shared
  functions (`shared(workspace)`) and the member list. Also the `RemoteAccess`
  of the bus (`isMember`, `isShared`). Limits: 60 s per call, handshake and
  request to the relay; 10 open calls per instance in both directions; messages
  from the relay at most 2 MiB (`ws` with `maxPayload`).
- `writeDurable(file, data, mode?)` – atomic and with `fsync` (replay state, `relay.json`).

## Pitfalls

- `ReplayGuard` does not read a broken file or one of the wrong shape as empty
  (it would accept every replay), but throws `Broken replay state`.
- A list never extends its own signer: a revoked member
  from whom the relay withholds the revocation expires after 7 days. Whoever stores a list
  stores `vouchedTimes` with it; without them every member counts again
  as freshly confirmed. If only one member renews (`next` with an empty change),
  it expires itself at the others; it needs the renewal of another.
- `from` and `epoch` become object keys in the replay state: only a hex fingerprint
  or base64url (16–64 characters), otherwise `Invalid sequence`.
- The first list checks only its own signature; trust arises from the
  confirmation of the fingerprints by humans (Phase 16).
- A member who is revoked in the new list cannot sign it.
- A list change is adopted and reported via `onChange` only when the
  relay has accepted it – the relay orders the versions, otherwise two
  simultaneous changes fork. Own changes (`addMember`, `removeMember`, `renew`) run one after another and draft from the list the previous one left; only a change of another member can still be refused.
- The relay is not trustworthy: a broken message before `ready` ends
  the connection setup, afterwards it is discarded; `error` after `ready` ends
  nothing. Never throw in the listener.
- Arguments are not checked against `inputSchema` (no JSON schema validator in the
  repo); the handlers do that.
- If an instance offers the same function over two workspaces, it appears once
  in the bus; if one path drops, the other takes over (`offers`, `takeOver`).
- Private keys are stored by the host (desktop: `safeStorage`), not by this package.
