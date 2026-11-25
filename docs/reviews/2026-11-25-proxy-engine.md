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

## Fourth review: commit ec520f0 (keychain distrust filter)

Reviewer: Codex (`codex exec -s read-only`), on commit ec520f0. Eight findings; Codex
reproduced six with in-memory plists against the unchanged parser. Each was checked
against Apple's open-source Security code (`apple-oss-distributions/Security`, branch
`main`): `trust/trustd/SecCertificateSource.c` (`SecLegacyAnchorSourceCopyUsageConstraints`),
`trust/trustd/SecPolicyServer.c` (`SecPVCContainsPolicy`, `SecPVCMeetsConstraint`,
`SecPVCGetTrustSettingsResult`, `SecPVCContainsTrustSettingsKeyUsage`) and
`OSX/libsecurity_keychain/lib/TrustSettings.cpp` (disk format to API).

| #   | Sev. | Finding                                                                                     | Checked                                                                                                                                                                                                      | Change |
| --- | ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | high | Domain order reversed: user `TrustRoot` hides an admin `Deny`                               | Confirmed: trustd returns a certificate's admin settings whenever they exist ("admin trust settings overrule user trust settings") and reads the user domain only otherwise, whole array, not entry by entry | Fixed  |
| 2   | high | Basic X.509 entries counted as TLS, so a basic `TrustRoot` hides a later SSL `Deny`         | Confirmed: `SecPVCContainsPolicy` compares the entry's OID with the compatibility OID of the evaluated policy; an SSL check never matches basic X.509                                                        | Fixed  |
| 3   | high | `kSecTrustSettingsPolicyName` ignored, so an `sslClient` entry decides a server check       | Confirmed: with OID and name both must match; a name `sslServer` also matches, `sslClient` never does for a server check; a name without OID matches by name                                                 | Fixed  |
| 4   | high | Policy OID as `<string>` skipped                                                            | Confirmed: `TrustSettings.cpp` accepts CFData or CFString (`SecPolicyCreateWithProperties`), the schema header says the same                                                                                 | Fixed  |
| 5   | high | `KeyUsage` 4294967295 (`kSecTrustSettingsKeyUseAny`) skipped                                | Confirmed: `SecPVCContainsTrustSettingsKeyUsage` returns true for exactly that value. Other key usages stay skipped (exact match against the policy's usages, not modelled)                                  | Fixed  |
| 6   | med  | `Unspecified` passes to the next entry; an `AllowedError`/`Unspecified` entry was a fixture | Confirmed: `SecPVCGetTrustSettingsResult` breaks at the first entry that meets the constraint, whatever its result; `AllowedError` is no matching criterion                                                  | Fixed  |
| 7   | med  | macOS test expects every bundled root although a denied one is now dropped                  | Confirmed: "includes cert.pem and Node's bundled roots on macOS" fails on a machine that distrusts a bundled root                                                                                            | Fixed  |
| 8   | low  | System smoke test passes with both exports failing once `warned` is set                     | Confirmed as latent: no earlier test in the file sets `warned` in the shared module today, but the order is not guaranteed                                                                                   | Fixed  |

Fix in `bays/proxy/src/main/ca.ts`: `distrustedRoots()` reads user, then admin, and a
certificate's admin entry overwrites its user result. `deniesTls()` returns the result
of the first entry that applies to an SSL server check: no `Application` or
`PolicyString`, `KeyUsage` absent or 4294967295, `Policy` absent or SSL (data
`KoZIhvdjZAED` or string `1.2.840.113635.100.1.3`), `PolicyName` absent or
`sslServer`; `Unspecified` stops the search like any result. Tests in `ca.test.ts`
(the first two red before): "stops at the first entry that applies to an SSL server
check, as trustd does", "lets admin settings of a certificate overrule its user
settings"; the macOS test now skips roots `distrustedRoots()` denies, and the smoke test
runs on a fresh module. ADR 0049 and `bays/proxy/CLAUDE.md` follow the new rule.

Not observed: a real "Never Trust" entry (that would change the keychain). This Mac's
exports (user: empty `trustList`, admin: two certificates without settings) yield no
deny before and after the fix. Whether Keychain Access writes `KeyUsage` as
4294967295 or as -1 is unknown; -1 stays skipped, as trustd's exact comparison would
also not treat it as "any". Entries with `kSecTrustSettingsPolicyOptions` (a nested
dictionary) are outside the flat-dictionary parser, as before.

## Fifth review: commit ee001a6

Reviewer: Codex (`codex exec -s read-only`), on commit ee001a6 (trust settings filter in
`bays/proxy/src/main/ca.ts`). Codex confirmed the admin-before-user domain order and
reported three findings, each with a fail-open and a fail-closed scenario. Every claim
was checked against Apple's open-source Security code at commit
`db15acbe6a7f257a859ad9a3bb86097bfe0679d9` of `apple-oss-distributions/Security` (raw
files fetched; line numbers below refer to that commit).

| #   | Sev. | Finding                                                                                | Checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Change |
| --- | ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | high | `KeyUsage` 8 (SignCert) skipped, although it applies to a root in a TLS server chain   | Confirmed: `SecPVCContainsTrustSettingsKeyUsage` (`trust/trustd/SecPolicyServer.c:3174`) reads the value as SInt64 (`:3179`, failure: no match), accepts `kSecTrustSettingsKeyUseAny` (`:3183`), adds SignCert for every certificate that is not the leaf (`:3206`), adds the policy's key usages (none for the SSL server policy: `KeyUsage` absent from `SecPolicyCreateSSL(true)`'s options, observed via `SecPolicyGetOptions` on this Mac) and compares the low 32 bits exactly (`:3222`)                                              | Fixed  |
| 2   | high | String OIDs `1.2.840.113635.100.1.3.1` / `.3.2` compared without Apple's normalisation | Confirmed: a string policy becomes `SecPolicyCreateWithProperties(certPolicy, NULL)` (`OSX/libsecurity_keychain/lib/TrustSettings.cpp:1074`), which creates the SSL policy for `.3`, `.3.1` and `.3.2` (`OSX/sec/Security/SecPolicy.c:83-84`, `:333`); trustd takes its compatibility OID (`trust/trustd/SecPolicyServer.c:3292-3296`), which is `.3` for all three (`SecPolicy.c:603-607`). The stored name still scopes it (`SecPolicyServer.c:3041-3083`): `.3.2` without a name applies to a server check, with `sslClient` it does not | Fixed  |
| 3   | med  | Whitespace stripped from every value, so `ssl Server` became `sslServer`               | Confirmed: the name is copied unchanged (`TrustSettings.cpp:1087`) and compared with `CFEqual` (`SecPolicyServer.c:3054-3063`)                                                                                                                                                                                                                                                                                                                                                                                                              | Fixed  |

Decisions taken from Apple's code:

- `KeyUsage` -1: not "any". trustd compares the SInt64 value with 0xFFFFFFFF
  (`SecPolicyServer.c:3183`, `kSecTrustSettingsKeyUseAny` is a `uint32_t` option,
  `trust/headers/SecTrustSettings.h:191-205`), so -1 fails there; its low 32 bits
  (0xFFFFFFFF) do not equal SignCert either (`:3222`). The entry never applies to a root
  in a TLS server chain. `security add-trusted-cert -u -1` writes exactly this value
  (`SecurityTool/macOS/trusted_cert_add.c:182`, `:312`).
- Values beyond 64 bits never apply (`CFNumberGetValue` fails, `:3179`); values whose low
  32 bits are 8 apply (`:3222`).
- DER (`<data>`) OIDs need no normalisation: `SecPolicyCopy` resolves data OIDs only
  through the fixed list in `OSX/libsecurity_keychain/lib/PolicyCursor.cpp:46-65`, which
  holds the SSL OID `.3` (`:49`) but no `.3.1` or `.3.2`.

Fix in `bays/proxy/src/main/ca.ts`: `keyUsageApplies()` implements rule 1 (BigInt, so
64-bit values and the low-32-bit mask stay exact); `SSL_POLICY` also holds the string
OIDs `.3.1` and `.3.2`; `deniesTls()` strips whitespace only from `<data>` values. Test
in `ca.test.ts` (red before the fix: eight wrong results): "matches key usage, policy
OID and policy name exactly as trustd does", one entry per fail-open and fail-closed
scenario of the review, plus -1, a non-matching usage (9) and a value beyond 64 bits.
ADR 0049 and `bays/proxy/CLAUDE.md` follow the new rule.

Known differences that stay (rare, only reachable through `security
trust-settings-import` of hand-written settings):

- A data OID outside the `PolicyCursor.cpp` list makes `copyTrustSettings` abort for the
  certificate (`TrustSettings.cpp:1068-1071`), so trustd sees no settings for it in that
  domain (admin then falls back to user). The filter instead skips only that entry.
- A string OID that `SecPolicyCreateWithProperties` does not resolve leaves the entry
  without a policy (`TrustSettings.cpp:1076`), so it applies to any policy. The filter
  instead treats it as a non-SSL policy.
- A self-signed root presented as the leaf gets no SignCert usage in trustd
  (`SecPolicyServer.c:3197-3207`); the filter assumes the root signs a chain.

Not observed: a live trustd evaluation with changed settings (that would change the
keychain).

## Sixth review: commit 77f01cf

Reviewer: Codex (`codex exec -s read-only`), on commit 77f01cf, with the three known
differences of the fifth review excluded. Two findings. Every claim and the three known
differences were checked against Apple's open-source Security code at commit
`db15acbe6a7f257a859ad9a3bb86097bfe0679d9` (raw files fetched; line numbers refer to that
commit).

| #   | Sev. | Finding                                                                                          | Checked                                                                                                                                                                                                                                                                                                                                                                                                           | Change |
| --- | ---- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | high | An entry with only `kSecTrustSettingsPolicyName` ended the search as `TrustRoot` before a `Deny` | Confirmed: `copyTrustSettings` drops an entry without policy, application, policy string, allowed error, result and key usage, the name not counted (`OSX/libsecurity_keychain/lib/TrustSettings.cpp:1048-1056`), so trustd never sees it                                                                                                                                                                         | Fixed  |
| 2   | med  | `DisableUserTrustSettings` ignored, so user denies dropped roots trustd keeps (fail closed)      | Confirmed: `tsGetGlobalTrustSettings` returns no user domain when `DisableUserTrustSettings` in `/Library/Preferences/com.apple.security.plist` is true (`OSX/libsecurity_keychain/lib/SecTrustSettings.cpp:102-118`, `:189-191`, read by `Dictionary::getBoolValue`, `OSX/libsecurity_utilities/lib/simpleprefs.cpp:202-228`); the export reads the domain without that check (`SecTrustSettings.cpp:1148-1166`) | Fixed  |

The three known differences of the fifth review, checked:

- Unknown DER OID: confirmed. `SecPolicyCopy` fails for an OID outside the
  `PolicyCursor.cpp:46-65` list, and also for iChat and the two PKINIT OIDs in it, which
  `SecPolicySearchCopyNext` skips (`OSX/libsecurity_keychain/lib/SecPolicySearch.cpp:74-90`);
  `copyTrustSettings` then throws (`TrustSettings.cpp:1068-1071`), the cached API returns
  an error (`SecTrustSettings.cpp:71-81`, `:368-389`) and trustd falls back from admin to
  user, or sees no settings (`trust/trustd/SecCertificateSource.c:998-1021`). Fixed.
- Unresolved string OID: confirmed. `SecPolicyCreateWithProperties(oid, NULL)` returns
  NULL for an identifier it does not handle or that needs a name
  (`OSX/sec/Security/SecPolicy.c:278-503`, macro list `SecPolicy.list`), the entry keeps
  no policy (`TrustSettings.cpp:1072-1079`) and applies to every policy unless its name
  scopes it (`SecPolicyServer.c:3368-3372`, `:3041-3083`). Fixed.
- Self-signed root as leaf: confirmed. trustd adds SignCert only when the certificate is
  not at path index 0 (`SecPolicyServer.c:3197-3207`), so the leaf computes usage 0. A
  bundle cannot tell the roles apart, and OpenSSL trusts a self-signed leaf found in its
  store, so a self-signed root is dropped when either role is denied (fail closed for
  the other role). Fixed.

Found while checking (not reported by Codex): `kSecTrustSettingsPolicyOptions` is not
copied by `copyTrustSettings` (`TrustSettings.cpp:1040-1124`), so trustd evaluates such an
entry without options; the regex parser could not read the nested dictionary and skipped
the entry (fail open). Fixed by the plist parser below.

Fix in `bays/proxy/src/main/ca.ts`: `parsePlist()` reads the export as a plist (nested
dictionaries, empty `<dict/>`); `deniesTls()` converts the entries as `copyTrustSettings`
does (`DATA_OIDS`: the DER OIDs `SecPolicyCopy` resolves, any other drops the
certificate's settings in that domain; `OTHER_ARCS`: the string OIDs that resolve to a
non-SSL policy, any other string means no policy) and returns the decision for both
roles; `distrustedRoots()` returns `{ chain, leaf }` and skips the user domain when
`userTrustSettingsDisabled()` says so; `systemRoots()` drops a root denied as chain
signer, or as leaf when it is self-signed. Tests in `ca.test.ts` (red before): "converts
the stored settings as Security.framework does before trustd sees them", "checks a
self-signed root as its own server certificate without SignCert", "ignores the user
domain when DisableUserTrustSettings is set, as trustd does", "reads
DisableUserTrustSettings as Security.framework does" (macOS), and a leaf case in "drops a
root the keychain distrusts …".

Not modelled: an `Application` entry whose data `SecTrustedApplicationCreateWithExternalRepresentation`
rejects also makes `copyTrustSettings` abort (`TrustSettings.cpp:1093-1099`); the filter
skips only that entry.

## Seventh review: working tree after the sixth review

Reviewer: Codex (`codex exec -s read-only`), on the uncommitted fix of the sixth review.
Three findings, checked against the same Apple commit.

| #   | Sev. | Finding                                                                                      | Checked                                                                                                                                                                                                                                                                                                                                                               | Change |
| --- | ---- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | med  | `kSecTrustSettingsResult` 4294967299 is not converted to SInt32, so its `Deny` (3) is missed | Rejected: `tsIsGoodCfNum` refuses a result that does not fit SInt32 when a domain is loaded, imported or exported (`OSX/libsecurity_keychain/lib/TrustSettings.cpp:337-358`, `:1579-1583`, `:1714-1716`), and trustd turns a failed SInt32 conversion into `TrustRoot`, not the low bits (`trust/trustd/SecPolicyServer.c:3348-3356`); the filter also yields no deny | None   |
| 2   | low  | An integer `DisableUserTrustSettings` above 2^53 lost bits before the char cast              | Confirmed: `Dictionary::getBoolValue` casts the number to char (`OSX/libsecurity_utilities/lib/simpleprefs.cpp:223-226`); `Number()` rounds 9007199254740993 to an even value                                                                                                                                                                                         | Fixed  |
| 3   | low  | A string `DisableUserTrustSettings` compared without Unicode case folding (`yeſ`)            | Confirmed: `CFStringCompare(…, "YES", kCFCompareCaseInsensitive)` (`simpleprefs.cpp:210-214`) folds U+017F to `s`; `/^yes$/i` without the `u` flag does not                                                                                                                                                                                                           | Fixed  |

Fix in `bays/proxy/src/main/ca.ts` (`userTrustSettingsDisabled()`): strings match
`/^yes$/iu`, integers are cast with `BigInt.asIntN(8, …)`. Test: three more cases in
"reads DisableUserTrustSettings as Security.framework does" (red before: two).

## Eighth review: working tree after the seventh review

Reviewer: Codex (`codex exec -s read-only`), on the uncommitted fixes of the sixth and
seventh reviews. Two findings, checked against the same Apple commit and, for the number
conversion, a CoreFoundation probe on this Mac (arm64).

| #   | Sev. | Finding                                                                                                                                                                  | Checked                                                                                                                                                                                                                                                                                                                                                                   | Change |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | high | The leaf check used `X509Certificate.checkIssued()`, which needs `keyCertSign`, so a self-signed certificate without it kept its leaf deny out of the filter (fail open) | Confirmed: `_SecCertificateIsSelfSigned` (`OSX/sec/Security/SecCertificate.c:6192-6223`) compares the normalised issuer and subject, the key IDs when an authority key ID exists, and the own signature; key usage does not count. OpenSSL's `X509_check_issued` also checks the key usage; `checkIssued()` was false for a test certificate with only `digitalSignature` | Fixed  |
| 2   | med  | A `<real>` `DisableUserTrustSettings` was cast to char with `% 256`, unlike CoreFoundation (NaN, 1e20)                                                                   | Confirmed with a CoreFoundation probe: `CFNumberGetValue(…, kCFNumberCharType, …)` gives NaN 0, 1e20 -1, -1e20 0, 257.9 1, 9.3e18 -1, so the value saturates to 64 bits before the low byte is taken (`simpleprefs.cpp:223-226`)                                                                                                                                          | Fixed  |

Fix in `bays/proxy/src/main/ca.ts`: `systemRoots()` treats a certificate as self-signed
when subject and issuer match (case and whitespace ignored) and it verifies with its own
key; `userTrustSettingsDisabled()` converts reals as measured. Tests (red before): a
self-signed certificate with only `digitalSignature` in "drops a root the keychain
distrusts …", four reals in "reads DisableUserTrustSettings as Security.framework does".

Known limits: names are compared case- and whitespace-insensitively, not with Apple's
full normalisation, and the authority/subject key ID check is not modelled (Node exposes
neither); the real conversion follows arm64, an Intel Mac saturates differently.

## Ninth review: working tree after the eighth review

Reviewer: Codex (`codex exec -s read-only`), on the uncommitted fixes of the sixth to
eighth reviews. Two findings, both confirmed; this was the last of four rounds agreed
for this filter, so the fixes below were not reviewed again.

| #   | Sev. | Finding                                                                                                    | Checked                                                                                                                                                                                                                                                 | Change |
| --- | ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | med  | `KeyUsage` as `<real>0.0</real>` made `BigInt()` throw, so the whole domain was skipped (fail open)        | Confirmed: `tsIsGoodCfNum` accepts any CFNumber that converts to SInt32 without loss (`OSX/libsecurity_keychain/lib/TrustSettings.cpp:337-358`), and trustd reads it as SInt64 (`trust/trustd/SecPolicyServer.c:3179`), so 0.0 is 0 and 8.0 is SignCert | Fixed  |
| 2   | low  | `DisableUserTrustSettings` as `<real>+infinity</real>` read as NaN (false), CoreFoundation gives -1 (true) | Confirmed: `plutil` writes infinities as `+infinity` / `-infinity`, which `Number()` does not parse; `getBoolValue` casts to char (`OSX/libsecurity_utilities/lib/simpleprefs.cpp:223-226`), saturating as measured in the eighth review                | Fixed  |

Fix in `bays/proxy/src/main/ca.ts`: `keyUsageApplies()` reads the value through
`Number()` (a valid real is an exact SInt32); `userTrustSettingsDisabled()` maps
`infinity` before converting. Tests (red before): reals 0.0 and 8.0 in "checks a
self-signed root as its own server certificate without SignCert", ±infinity in "reads
DisableUserTrustSettings as Security.framework does".

Open after four rounds: whether a fifth Codex round on this state reports no findings is
not known. Not observed in any round: a live trustd evaluation with changed settings
(that would change the keychain).
