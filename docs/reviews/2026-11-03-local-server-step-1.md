# Review local server, step 1 (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: ADR
0036 step 1 – runtime copy, LaunchAgent, `listen.json`, `pair-code`,
`ServerConnections.pairLocal`.

## Findings

1. **[P2] Early desktop sees no bays.** The server now listens before the bays
   start; a desktop that connects in this time got `bays: []` and no update.
   Also affects remote desktops. **Adopted:** the bridge answers `/connect`
   with 503 (`ready`) until the bay start is finished; desktop and
   `pairWhenReady` retry. Test `server.test.ts` "turns desktops away until the
   bays have started".
2. **[P2] Foreign process on the old port ends the retries.** A different
   fingerprint counted as final. **Adopted:** for local servers the desktop
   keeps trying until `listen.json` names its own server. Test
   `connections.test.ts` "keeps trying while another server holds
   the old port".
3. **[P2] Newly written plist does not reach the loaded service.**
   **Adopted:** if the plist is written anew, the app reloads the service with
   `bootout` and `bootstrap`. Test `local-server.test.ts` "writes the
   LaunchAgent anew …".
4. **[P2] Renamed app.** The program name came from the bundle name.
   **Adopted:** `executable` from `process.execPath`. Test "runs the
   executable of the app, also when the app was renamed".

## Checked without a finding

File permissions (0700 folder, 0600 `listen.json`/`pair-code`), XML escaping of
the plist, order fingerprint before code in `pairLocal`.

## Not checked

Codex ran without a real LaunchAgent. The real run is proven by
`e2e/local-server.spec.ts`, with `out/` and with the packaged app
(`HANGAR_E2E_EXECUTABLE`). Whether macOS reports "background item added" is
not observed.
