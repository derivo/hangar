# Review: proxy bay engine (2026-11-25)

Reviewer: Codex (`codex exec -s read-only`), on the uncommitted step 2 of the proxy
bay (ADR 0049) before its PR. Every finding was checked against the code before it
was adopted; all ten held.

| #   | Sev.   | Finding                                                                                                   | Checked                                                 | Change                                                                                                                                                                  |
| --- | ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | high   | A server answering the upgrade with `permessage-deflate` unasked made mitmproxy inflate without the limit | The addon stripped the header only from the request     | Also stripped from the 101 response; integration test: no extension header reaches the client, a compressed frame is dropped (red with the old addon)                   |
| 2   | high   | `get_content()` inflated gzip bodies fully before the 1 MB cut                                            | Streaming is decided on the compressed `Content-Length` | The addon sends bodies as on the wire with `encoding` (`Content-Encoding`); bounded inflating moves to the flow store (step 4); integration test with 4 MB in 4 KB gzip |
| 3   | high   | `unlisten` during a restart left the restored listener bound                                              | `unlisten` only removed the map entry while `starting`  | `unlisten` waits for a start in progress; unit test holds the restore reply                                                                                             |
| 4   | medium | Encoded parameter names (`%74oken`) escaped the redaction                                                 | The pattern ran on the raw name                         | Names are decoded before matching; integration test                                                                                                                     |
| 5   | medium | HTTP/2 uploads without a length were buffered whole                                                       | Only `chunked` and large `Content-Length` streamed      | Bodies of HTTP/2 and 3 requests without a length (except GET, HEAD, OPTIONS) stream. Not tested: no HTTP/2 client in the integration test                               |
| 6   | medium | A start dying while `stop()` waited for it scheduled a restart after the stop                             | `exited()` checked only `stopping`, set after the wait  | `stop()` marks the engine halted first; unit test                                                                                                                       |
| 7   | medium | A restart opened listeners before restoring pause and pass-through hosts                                  | Order in `launch()`                                     | `capture` and `ignore` go first; unit test checks the order                                                                                                             |
| 8   | medium | A queued command still went out after its timeout                                                         | The timeout removed only the pending entry              | The timeout also removes it from the queue; unit test                                                                                                                   |
| 9   | medium | Replies (`force`) bypassed both limits of the addon's stdout queue                                        | `Out.put`                                               | Replies may use twice the limits, then they are dropped and counted too. Not tested: no Python unit tests                                                               |
| 10  | low    | A complete incoming line above 8 MB was parsed when it arrived in one chunk                               | The limit applied only to the partial line              | Every line is checked; unit test                                                                                                                                        |

## Second review: commit ad06ba3 (addon copied out of `app.asar`)

Reviewer: Codex (`codex exec -s read-only`), on commit ad06ba3. All three findings
concern `scripts/check-proxy-addon.mjs`, the CI check of the packaged addon. Each was
checked against the code and reproduced by `scripts/check-proxy-addon.test.ts`, which
runs the check against a fake `mitmdump` (red before the fix). Codex also confirmed that
the addon in the existing macOS `app.asar` matches the source and build bytes.

| #   | Sev.   | Finding                                                                        | Checked                                                                                                       | Change                                                                                      |
| --- | ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | medium | A `hello` split across stdout chunks was parsed half and threw a `SyntaxError` | Confirmed: `startsWith` matched the incomplete last line                                                      | Only complete lines are parsed; the rest waits for the next chunk; test                     |
| 2   | medium | The timeout only sent SIGTERM; a mitmdump ignoring it kept the check running   | Confirmed: ad06ba3 had dropped the `process.exit(1)` from the timeout                                         | The timeout kills mitmdump with SIGKILL and exits 1; test with a child that ignores SIGTERM |
| 3   | medium | A mitmdump that ended only through the timeout's SIGTERM with code 0 passed    | Confirmed: success was `out.includes('"hello"')` plus the exit code, so also a log line saying "hello" passed | Any timeout fails; success needs a parsed `hello` line; tests for both cases                |

The timeout can be shortened with `CHECK_PROXY_ADDON_TIMEOUT_MS` (default 60 s) so the
tests do not wait a minute. The tests are skipped on Windows, where the shebang fake
cannot be spawned.

## CI finding: macOS upstream roots

On the macOS CI runner, "reaches a public HTTPS host with the system roots" got a
mitmproxy 502 "Certificate verify failed: unable to get local issuer certificate".
`example.com` chains to `SSL.com TLS ECC Root CA 2022` (cross-signed by `AAA Certificate
Services`); the runner's `/etc/ssl/cert.pem`, the only macOS source of `systemRoots()`,
had neither. Locally `cert.pem` holds `AAA Certificate Services`, so the test passed.

Change: on macOS `systemRoots()` joins `cert.pem` (if present), the keychain
(`tls.getCACertificates('system')`, company CAs too) and Node's bundled Mozilla roots
(`'bundled'`), each certificate once. Linux and Windows are unchanged. Unit test with an
injected store in `ca.test.ts` (red before). Reproduced locally: a copy of `cert.pem`
without the two roots as the only roots gave the same 502 in the integration test; with
`systemRoots('darwin', [that copy])` all 8 integration tests passed.

## Third review: commit 27263ba (macOS roots, hardened addon check)

Reviewer: Codex (`codex exec -s read-only`), on commit 27263ba. Codex found nothing
in the PEM deduplication or in `scripts/check-proxy-addon.mjs`, and one finding in
`systemRoots()`.

| #   | Sev. | Finding                                                                                                                                                                 | Checked                                                                                                                                                                                                                                                                                                                          | Change                 |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | high | A root the user set to "Never Trust" in the keychain comes back through `'bundled'`, so `upstream.pem` and every session bundle trust it although the keychain does not | Confirmed: `systemRoots()` joins the three sources without filtering (`bays/proxy/src/main/ca.ts:46-50`); Codex reproduced it with an injected store. Not new in kind: before 27263ba the roots in `cert.pem` were not checked against keychain distrust either; 27263ba extends this to the Mozilla roots that `cert.pem` lacks | Fixed (option C below) |

Open decision for finding 1. Locally (Node v26.12.1) `getCACertificates('system')`
returns 16 certificates and not `SSL.com TLS ECC Root CA 2022`, the root missing on
the CI runner; `'bundled'` has it. The keychain store is therefore no replacement for
the bundled roots. Options:

- **A – keep the union, document it.** Hangar trusts upstream what Node and `cert.pem`
  trust; keychain distrust is not honored, as before for `cert.pem`. No code change;
  ADR 0049 and `bays/proxy/CLAUDE.md` name the limit.
- **B – drop `'bundled'`.** `cert.pem` plus the keychain. Likely brings back the CI 502
  ("unable to get local issuer certificate") and the same failure for users whose
  `cert.pem` lacks a root that browsers trust.
- **C – honor keychain distrust.** Read the distrusted certificates (for example
  `security dump-trust-settings` for user, admin and system domains) and remove them
  from all three sources, `cert.pem` included. Closes the gap fully, but adds a
  parser for macOS trust settings and a process call at every bundle build.

Recommendation: A now, C as a roadmap item if keychain distrust must be honored.
Distrusting a Mozilla root by hand is rare, Node itself trusts the bundled roots
regardless of the keychain, and B trades a rare gap for a reproduced failure.

Decision: C, by the user. Fix: `distrustedRoots()` in `bays/proxy/src/main/ca.ts`
runs `security trust-settings-export` (user domain, then `-d` for admin) into a
temporary file and reads the XML plist: `trustList` maps each certificate's SHA-1
(upper-case hex) to a dictionary whose optional `trustSettings` array holds flat
usage-constraint dictionaries (`kSecTrustSettingsResult`, 3 = deny, default 1 =
trust root; `kSecTrustSettingsPolicy` as OID data; `Application`, `PolicyString`,
`KeyUsage`, `AllowedError`). Checked locally: the admin export lists two
certificates without `trustSettings` (`security dump-trust-settings -d`: "Number of
trust settings : 0", an empty array = always trust), the user export an empty
`trustList`, the system export (`-s`) Apple's 157 roots without settings; the keys and
values come from `SecTrustSettings.h` of the macOS SDK. The system domain is not read:
it is Apple's read-only list and carries no denies. The parser is regular expressions
instead of a plist library, because the usage-constraint dictionaries are flat.

Rule: the first entry of a certificate that applies to TLS decides (Apple's order);
an entry applies when it names no application, host or key usage and its policy is
absent, SSL or basic X.509. Entries for other policies (S/MIME, code signing …) are
skipped, an `Unspecified` result passes to the next entry. The user domain decides
before the admin domain. `systemRoots()` drops every candidate from `cert.pem`, the
keychain and `'bundled'` whose SHA-1 (`X509Certificate.fingerprint`) is denied. A
failing read (no `security`, an error other than "No Trust Settings") warns once
(`[proxy] …`) and filters nothing. Tests in `ca.test.ts` (red before): "drops a root
the keychain distrusts from cert.pem, the keychain and the bundled roots", "denies
only what the first entry that applies to TLS denies", "lets the user domain decide
before the admin domain", "keeps everything without trust settings", "falls back to
no filter and warns once when the settings cannot be read", "reads the trust
settings of this system without throwing". Not tried: a real root set to "Never
Trust" (that would change the keychain); in particular which entries Keychain Access
writes for it is taken from the header, not observed.
