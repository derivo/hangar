# ADR 0043 – Browser bay: the person trusts a refused certificate

Status: accepted 2026-11-13. Extends [ADR 0042](0042-browser-errors-find-external.md).

## Context

Dev servers often run with a self-signed certificate. Since ADR 0042 the browser
bay shows `ERR_CERT_AUTHORITY_INVALID` clearly, but the page stays blocked, for
the person and for the agent that needs it. The person decided (2026-11-13):
the person may trust such a certificate by a click, per host and certificate
fingerprint, until Hangar quits, and the trust also applies to agent tabs.
Agents can never trust a certificate themselves.

## Decision

- **The host refuses an unknown certificate and remembers it on the tab.**
  `webContents` event `certificate-error` of the main frame sets
  `BrowserTab.certificate` (`host` without port, `fingerprint` as Electron gives
  it, `sha256/…`) until the next load starts.
- **`BayBrowser.trustCertificate(id, { host, fingerprint })`** adds
  `host fingerprint` of that certificate to a set in memory and loads the page
  again. The UI passes host and fingerprint it showed; if the tab holds another
  host or certificate by then (an agent navigated meanwhile), the call fails and
  trusts nothing. The
  certificate is dropped when another main-frame navigation starts, the load
  error when another page commits. From then on
  `certificate-error` with that host and fingerprint answers `true`, in every
  tab and partition, for the main frame and subframes. Chromium then remembers
  the allowed certificate in the partition, so subresources (scripts, styles)
  of the host load too. Another certificate of the same host, or the
  certificate for another host, is refused again. Nothing is stored: the set
  ends when Hangar quits.
- **Only the person:** the browser bay offers the button "Trust this host" on
  the error page, next to the host, the fingerprint and the note that the trust
  lasts until Hangar quits and covers agent tabs. It calls the UI channel
  `tab.trustCertificate`. The bay provides no function for agents; agents see
  `certificate` in their tab but cannot act on it.

## Alternatives

- **`session.setCertificateVerifyProc`:** checked in Electron 45.1.0 – the
  result of a refused verification is cached by the network service; neither a
  reload nor setting the procedure again lets a trusted certificate through.
- **Trust per host without fingerprint:** a changed certificate (another
  server, an attacker) would pass unnoticed.
- **Stored trust across restarts:** more convenient, but a stale exception
  stays forever; can follow with a list to revoke in the settings.
- **A function for agents:** an agent could switch off TLS checks for any host
  it is led to.

## Consequences

- `BayBrowser` gains `trustCertificate`, `BrowserTab` gains `certificate`; the
  fake in `bays/browser/src/main/test-ctx.ts` follows.
- The trust is global within the host, not per bay: the browser bay is the only
  bay with the `browser` host module that shows pages to the person.
- No revoke short of quitting Hangar.
- "Agents can never trust" holds for the browser bay, which offers no such
  function; it is not a host guarantee for every bay with the `browser` host
  module (bay main parts run unsandboxed in the host anyway).
