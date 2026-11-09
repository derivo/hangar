# apps/relay

The Hangar relay (ADR 0011, Phase 15): passes sealed envelopes between
Hangar instances of a workspace. Never sees contents, only fingerprints and
envelopes. No Electron (lint rule `no-restricted-imports`). Operation:
[docs/relay-operations.md](../../docs/relay-operations.md).

## Structure

- `src/main.ts` – entry point: options, read the certificate, `SIGTERM`/`SIGINT` → `close()`.
- `src/options.ts` – `parseOptions(argv, env)`: `--data` (required), `--listen`
  (default `127.0.0.1:7430`), `--tls-cert` and `--tls-key` only together;
  `HANGAR_RELAY_TOKEN` only from the environment, never from the command line;
  `HANGAR_RELAY_URL` (public address) required outside loopback.
- `src/relay.ts` – `startRelay(options)`: sign-in by challenge (`hello` →
  `challenge` → `prove` with Ed25519), create workspaces (operator token),
  invitations (only the hash is stored, single use, 7 days, at most 20 open per
  workspace, not for revoked members; remembers who invited), `joined` with the
  `inviter` to the members,
  check and order member lists according to the rules of `Workspace`, forward
  envelopes only between members (`undeliverable` with `offline` or
  `refused`). `GET /health` → `{ok, version}`, otherwise 404.
- `relay.json` (mode 600, written to disk with `writeDurable` before every reply): workspaces, fingerprints, invitation hashes,
  current list. No envelopes, no contents.
- `vite build` bundles everything into `dist/hangar-relay.mjs`.

## Tests

- `relay.test.ts`, `options.test.ts`, `client.test.ts` – server, options,
  `RelayClient` against a real relay on loopback.
- `relay.integration.test.ts` – Phase 15 acceptance: two buses over a local
  relay; a shared function works, one that is not shared does not; plaintext marker
  neither in the log nor in `relay.json`.
- `docker/relay/smoke.check.ts` (`pnpm test:container`) – image: non-root,
  `healthy`, TLS, workspace survives `docker restart`.

## Pitfalls

- Without TLS the relay listens only on loopback (`startRelay` throws otherwise).
- An instance's proof is bound to `origin` (`signedChallenge(nonce, origin)`);
  if `HANGAR_RELAY_URL` does not match the address the instances use, every
  sign-in fails with `Invalid proof`.
- Every connection has an `error` listener (oversized frame); a peer that lets
  more than 8 MiB pile up unsent is disconnected instead of buffered further.
- A list that the instances would reject is also rejected by the relay; otherwise
  a member could block the workspace for everyone with nonsense.
- The log never mentions a token, invitation or content.
