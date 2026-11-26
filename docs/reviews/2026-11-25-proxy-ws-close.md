# Review: proxy WebSocket close after 1009 (2026-11-25)

Reviewer: Codex (`codex exec -s read-only`), on `git diff origin/main...HEAD` of
branch `fix/proxy-ws-close` (commit a765d5b). Both findings were checked against
mitmproxy 12.3.1 and the code before they were adopted; both held.

## Background

The integration test "ends a 20 MB message with 1009" failed once on macOS CI: the
client never saw the close frame. Findings before the review, with mitmproxy 12.3.1:

- The addon closed both connections at once, while the client was still sending.
  When the client handler cancelled itself, the `CancelledError` arrived while it
  waited for the `server_event` lock (`proxy/server.py`, `handle_connection`, the
  `await self.server_event(...)` outside the `try`). The handler then skipped
  `writer.close()`, and the client socket stayed open (seen with `lsof` and a
  traceback in every local run). ADR 0049 had noted "about 4 MB left each time,
  cause not checked".
- When the close did go through, the client got `EPIPE` on its remaining writes
  (macOS keeps the close frame readable in the kernel, checked with a socket
  script), and Node destroys the socket on the write error, possibly before it
  reads the frame. The test hid this with an empty `on('error')`.
- `CloseTcpConnection(half_close=True)` is no fix: `HttpStream` turns every
  `CloseConnection` of a WebSocket into a protocol error, which `Http1Server` and
  `Http1Client` answer with a full close (`proxy/layers/http/__init__.py`,
  `_http1.py`).

The CI failure itself was not reproduced. A test that reads only after the limit
fails on the old addon every time (client never closed), so it shows the leak,
not the reset.

## Findings

| #   | Sev. | Finding                                                                                                                 | Checked                                                                                                      | Change                                                                                                                                                       |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | P2   | Closing the client after its close answer ended the server connection before the server answered                        | `handle_client` cancels the wakeup timers and every other handler once the client handler ends (`server.py`) | The client is closed last: after both sides answered or ended, or after `WS_CLOSE_WAIT`                                                                      |
| 2   | P2   | The answering test also passed when the addon ignored the close answer, since the 2 s timer closed within the 10 s wait | Mutation: `_closing` ignoring `DataReceived` passed before                                                   | The test server answers close frames; with an answering client both sides must close within 1.5 s of reading. The same mutation now fails (2038 ms measured) |

Codex could not open loopback sockets in its sandbox, so it did not judge the
determinism of the network test.
