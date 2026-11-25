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
