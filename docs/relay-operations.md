# Operating the relay

The Hangar relay connects the Hangar instances of a workspace (ADR 0011). Each
instance opens an outgoing WebSocket connection; the relay forwards end-to-end
encrypted envelopes and sees no content.

## Set up

1. Build the image (in the repository): `pnpm image:relay`.
2. Put the certificate and key at `docker/relay/tls/cert.pem` and `key.pem`,
   readable for uid 1000 (user `node` in the image); the folder needs the
   search right for it too (`chmod 755 docker/relay/tls`), otherwise the relay
   cannot open the files and exits. A public certificate (for
   example Let's Encrypt) needs nothing else on the instances.
3. Copy `docker/relay/relay.env.example` to `relay.env` and set
   `HANGAR_RELAY_TOKEN`, long and random (`openssl rand -base64 32`). Whoever
   knows the token may create workspaces; you become a member only by
   invitation. `HANGAR_RELAY_URL` is the address at which the instances reach the
   relay (for example `wss://relay.example.com:7430`). An instance's login is
   valid only for this address, so that a foreign relay cannot pass it on;
   without it the relay starts on loopback only.
4. Run `docker compose up -d` in `docker/relay/`. The relay listens on port 7430,
   `GET /health` answers with `{"ok":true,"version":1}`.

Without Docker: `HANGAR_RELAY_TOKEN=… HANGAR_RELAY_URL=wss://… node apps/relay/dist/hangar-relay.mjs --data <folder>
--listen 0.0.0.0:7430 --tls-cert cert.pem --tls-key key.pem` (after
`pnpm --filter @hangar/relay-server build`). Without TLS the relay accepts only a
loopback address.

## Self-signed certificate

The instances check the certificate. With your own certificate, give Hangar the
certificate authority through `NODE_EXTRA_CA_CERTS=<path>/ca.pem`.

## Backup and update

- Backup: the volume `data` (file `relay.json`: workspaces, fingerprints,
  invitation hashes, current member lists). If it is lost, the instances create
  their workspaces again; their trust lies with them, not with the relay.
- Update: rebuild the image, `docker compose up -d`. The instances reconnect.
- The log contains connections and errors, never tokens, invitations or content.
