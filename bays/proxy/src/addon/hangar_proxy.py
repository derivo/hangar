"""Addon of the proxy bay for mitmdump (ADR 0049).

Commands arrive as JSON lines on stdin, events leave as JSON lines on stdout.
mitmproxy's own log goes to stderr, so stdout carries only these lines.
Supports mitmproxy >=12.3,<13: the WebSocket limit wraps a private method.
"""

import asyncio
import base64
import json
import logging
import re
import sys
import threading
from collections import deque
from urllib.parse import unquote_plus

from mitmproxy import ctx, http, version
from mitmproxy.addons.termlog import TermLogHandler
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers import websocket as wsl
from wsproto.connection import ConnectionState
from wsproto.events import CloseConnection

BODY_LIMIT = 1024 * 1024
WS_LIMIT = 16 * 1024 * 1024
WS_CLOSE_WAIT = 2  # seconds a peer gets to answer the 1009 close frame
MAX_LINES = 1000
MAX_BYTES = 8 * 1024 * 1024
SECRET = re.compile(r"token|secret|key|auth", re.I)
SECRET_HEADERS = {"authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"}
SPEC = "regular@127.0.0.1:"


class Out:
    """Bounded queue in front of stdout: a slow reader never blocks the proxy."""

    def __init__(self, stream):
        self.stream = stream
        self.lines = deque()
        self.bytes = 0
        self.dropped = 0
        self.cond = threading.Condition()
        threading.Thread(target=self.run, daemon=True).start()

    def put(self, obj, force=False):
        # ensure_ascii (the default) keeps characters and bytes equal.
        line = json.dumps(obj, separators=(",", ":")) + "\n"
        with self.cond:
            # Replies may use twice the room, so events cannot starve them.
            room = 2 if force else 1
            if len(self.lines) >= room * MAX_LINES or self.bytes + len(line) > room * MAX_BYTES:
                self.dropped += 1
                return
            self.lines.append(line)
            self.bytes += len(line)
            self.cond.notify()

    def run(self):
        while True:
            with self.cond:
                while not self.lines and not self.dropped:
                    self.cond.wait()
                if self.lines:
                    line = self.lines.popleft()
                    self.bytes -= len(line)
                else:
                    line = json.dumps({"type": "dropped", "count": self.dropped}) + "\n"
                    self.dropped = 0
            self.stream.write(line)
            self.stream.flush()


out = Out(sys.stdout)
# Anything else printed goes to stderr.
sys.stdout = sys.stderr


def mask(value):
    return f"•••• ({len(value)} chars)"


def redact_headers(headers):
    return [
        [k, mask(v) if k.lower() in SECRET_HEADERS or SECRET.search(k) else v]
        for k, v in headers.items(multi=True)
    ]


def redact_url(url):
    scheme, sep, rest = url.partition("://")
    if not sep:
        return url
    authority, slash, path = rest.partition("/")
    if "@" in authority:
        user, _, host = authority.rpartition("@")
        authority = mask(user) + "@" + host
    path, hashsign, fragment = path.partition("#")
    path, q, query = path.partition("?")
    if query:
        parts = []
        for piece in query.split("&"):
            key, eq, value = piece.partition("=")
            secret = eq and SECRET.search(unquote_plus(key))
            parts.append(key + eq + mask(value) if secret else piece)
        query = "&".join(parts)
    return f"{scheme}://{authority}{slash}{path}{q}{query}{hashsign}{fragment}"


def encode(data):
    return base64.b64encode(data[:BODY_LIMIT]).decode()


def port_of(conn):
    return conn.proxy_mode.custom_listen_port


def meta(flow):
    return flow.metadata.setdefault("hangar", {"up": 0, "down": 0})


# The WebSocket limit (ADR 0049, "Capture"): mitmproxy collects the fragments of an
# unfinished message in frame_buf before any hook. relay_messages is wrapped because
# start() reassigns _handle_event per instance.
_relay = wsl.WebsocketLayer.relay_messages


def _limited_relay(self, event):
    yield from _relay(self, event)
    size = sum(sum(map(len, w.frame_buf)) for w in (self.client_ws, self.server_ws))
    if size <= WS_LIMIT:
        return
    for w in (self.client_ws, self.server_ws):
        w.frame_buf = [b""]
    for w in (self.server_ws, self.client_ws):
        if w.state in {ConnectionState.OPEN, ConnectionState.REMOTE_CLOSING}:
            yield w.send2(CloseConnection(code=1009, reason="message too big"))
    # A peer still sending gets a reset when we close now, and the reset can discard the
    # close frame before the peer reads it. So read on until its close answer, its EOF or
    # WS_CLOSE_WAIT. (Closing it while it still sends can also hit a cancel race in
    # mitmproxy 12.3.1's handle_connection that never closes the socket.)
    sides = (self.server_ws, self.client_ws)
    self.hangar_done = {w for w in sides if w.state is not ConnectionState.LOCAL_CLOSING}
    yield from _close_done(self)
    yield commands.RequestWakeup(WS_CLOSE_WAIT)
    self.flow.websocket.close_code = 1009
    self.flow.live = False
    self._handle_event = lambda event: _closing(self, event)
    out.put({"type": "ws.tooLarge", "id": self.flow.id, "buffered": size})
    yield wsl.WebsocketEndHook(self.flow)


def _close_done(self):
    if self.server_ws in self.hangar_done:
        yield commands.CloseConnection(self.server_ws.conn)
    # Closing the client ends the whole connection in mitmproxy, server included: last.
    if len(self.hangar_done) == 2:
        yield commands.CloseConnection(self.client_ws.conn)


def _closing(self, event):
    if isinstance(event, events.Wakeup):
        self.hangar_done = {self.server_ws, self.client_ws}
    elif isinstance(event, events.ConnectionEvent):
        w = self.client_ws if event.connection == self.context.client else self.server_ws
        if w in self.hangar_done:
            return
        if isinstance(event, events.DataReceived):
            w.receive_data(event.data)
            if not any(isinstance(e, CloseConnection) for e in w.events()):
                return
        self.hangar_done.add(w)
    else:
        return
    yield from _close_done(self)


wsl.WebsocketLayer.relay_messages = _limited_relay


class HangarProxy:
    def __init__(self):
        self.creds = {}  # port -> expected Proxy-Authorization
        self.authed = set()  # client connection ids past an authenticated CONNECT
        self.capture = True

    def load(self, loader):
        for handler in logging.getLogger().handlers:
            if isinstance(handler, TermLogHandler):
                handler.file = sys.stderr
        dumper = ctx.master.addons.get("dumper")
        if dumper:
            dumper.outfp = sys.stderr

    def running(self):
        out.put({"type": "hello", "version": version.VERSION}, force=True)
        loop = asyncio.get_running_loop()
        threading.Thread(target=self.read, args=(loop,), daemon=True).start()

    def read(self, loop):
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
                if not isinstance(cmd, dict):
                    raise ValueError("not an object")
            except ValueError:
                out.put({"type": "warning", "message": "broken command line"}, force=True)
                continue
            asyncio.run_coroutine_threadsafe(self.command(cmd), loop)
        # The bay is gone: never outlive it.
        loop.call_soon_threadsafe(ctx.master.shutdown)

    async def command(self, cmd):
        op = cmd.get("op")
        try:
            if op == "listen":
                await self.listen(int(cmd["port"]), str(cmd["password"]))
            elif op == "unlisten":
                await self.unlisten(int(cmd["port"]))
            elif op == "capture":
                self.capture = bool(cmd["on"])
            elif op == "ignore":
                ctx.options.update(ignore_hosts=[str(h) for h in cmd["hosts"]])
            else:
                raise ValueError(f"unknown command {op}")
            out.put({"type": "reply", "id": cmd.get("id"), "ok": True}, force=True)
        except Exception as e:  # every failure is a reply, never a crash
            out.put({"type": "reply", "id": cmd.get("id"), "ok": False, "error": str(e)}, force=True)

    def ours(self):
        return [m for m in ctx.options.mode if m.startswith(SPEC)] if ctx.options.server else []

    async def settle(self, spec, gone=False):
        """Waits until the listener of `spec` is bound, failed or (gone) removed."""
        servers = ctx.master.addons.get("proxyserver").servers
        for _ in range(400):  # 4 s, below the bay's 5 s
            await asyncio.sleep(0.01)
            if servers.is_updating:
                continue
            inst = next((s for s in servers if s.mode.full_spec == spec), None)
            if gone and inst is None:
                return None
            if not gone and inst and (inst.is_running or inst.last_exception):
                return inst
        raise TimeoutError(f"{spec} did not settle")

    async def listen(self, port, password):
        spec = f"{SPEC}{port}"
        token = base64.b64encode(f"hangar:{password}".encode()).decode()
        self.creds[port] = f"Basic {token}"
        modes = self.ours()
        if spec not in modes:
            ctx.options.update(server=True, mode=modes + [spec])
        inst = await self.settle(spec)
        if not inst.is_running:
            self.creds.pop(port, None)
            ctx.options.update(mode=[m for m in self.ours() if m != spec])
            raise RuntimeError(str(inst.last_exception))

    async def unlisten(self, port):
        spec = f"{SPEC}{port}"
        self.creds.pop(port, None)
        ctx.options.update(mode=[m for m in self.ours() if m != spec])
        await self.settle(spec, gone=True)
        # Removing a listener closes only its socket; open connections go too.
        for handler in list(ctx.master.addons.get("proxyserver").connections.values()):
            if port_of(handler.client) == port:
                try:
                    handler.close_connection(handler.client)
                except (KeyError, AssertionError):
                    pass  # not started yet: it fails the credentials check

    # --- credentials per listener (ADR 0049, "Sessions")

    def allowed(self, flow):
        expected = self.creds.get(port_of(flow.client_conn))
        return expected is not None and flow.request.headers.get("Proxy-Authorization") == expected

    def deny(self, flow):
        meta(flow)["skip"] = True
        flow.response = http.Response.make(407, b"", {"Proxy-Authenticate": 'Basic realm="hangar"'})

    def http_connect(self, flow):
        meta(flow)["skip"] = True
        if not self.allowed(flow):
            self.deny(flow)
            return
        self.authed.add(flow.client_conn.id)
        flow.request.headers.pop("Proxy-Authorization", None)

    def client_disconnected(self, client):
        self.authed.discard(client.id)

    # --- HTTP

    def requestheaders(self, flow):
        m = meta(flow)
        if flow.request.method == "CONNECT" or m.get("skip"):
            return
        if flow.client_conn.id not in self.authed and not self.allowed(flow):
            self.deny(flow)
            return
        flow.request.headers.pop("Proxy-Authorization", None)
        if flow.request.headers.get("Upgrade", "").lower() == "websocket":
            # wsproto inflates permessage-deflate without a bound: no compression.
            flow.request.headers.pop("Sec-WebSocket-Extensions", None)
        length = flow.request.headers.get("Content-Length")
        chunked = "chunked" in flow.request.headers.get("Transfer-Encoding", "").lower()
        # HTTP/2 and 3 may send a body without either header.
        unknown = (
            length is None
            and not flow.request.http_version.startswith("HTTP/1")
            and flow.request.method not in ("GET", "HEAD", "OPTIONS")
        )
        if chunked or unknown or (length and length.isdigit() and int(length) > BODY_LIMIT):
            m["streamUp"] = True
            flow.request.stream = self.streamer(flow, "up")
            self.send_request(flow, None)

    def request(self, flow):
        m = meta(flow)
        if m.get("skip") or m.get("streamUp"):
            return
        raw = flow.request.raw_content or b""
        m["up"] = len(raw)
        self.send_request(flow, raw)

    def responseheaders(self, flow):
        m = meta(flow)
        if m.get("skip"):
            return
        headers = flow.response.headers
        if flow.response.status_code == 101:
            # A server may claim permessage-deflate unasked; mitmproxy would inflate it unbounded.
            headers.pop("Sec-WebSocket-Extensions", None)
        length = headers.get("Content-Length")
        sse = headers.get("Content-Type", "").lower().startswith("text/event-stream")
        unknown = length is None and flow.response.status_code not in (101, 204, 304)
        if sse or unknown or (length and length.isdigit() and int(length) > BODY_LIMIT):
            m["streamDown"] = True
            flow.response.stream = self.streamer(flow, "down")
            self.send_response(flow, None)

    def response(self, flow):
        m = meta(flow)
        if m.get("skip"):
            return
        if not m.get("streamDown"):
            raw = flow.response.raw_content or b""
            m["down"] = len(raw)
            self.send_response(flow, raw)
        if flow.websocket is None:
            self.send_done(flow)

    def error(self, flow):
        if not meta(flow).get("skip") and self.capture:
            out.put({"type": "flow.error", "id": flow.id, "error": flow.error.msg})

    def streamer(self, flow, direction):
        m = meta(flow)

        def forward(data):
            sent = m[direction]
            m[direction] = sent + len(data)
            if data and self.capture and sent < BODY_LIMIT:
                out.put(
                    {
                        "type": "stream.chunk",
                        "id": flow.id,
                        "direction": direction,
                        "data": base64.b64encode(data[: BODY_LIMIT - sent]).decode(),
                    }
                )
            return data

        return forward

    def send_request(self, flow, body):
        if not self.capture:
            return
        r = flow.request
        out.put(
            {
                "type": "flow.request",
                "id": flow.id,
                "port": port_of(flow.client_conn),
                "time": r.timestamp_start,
                "method": r.method,
                "url": redact_url(r.url),
                "headers": redact_headers(r.headers),
                "body": None if body is None else encode(body),
                "truncated": body is not None and len(body) > BODY_LIMIT,
                "encoding": r.headers.get("Content-Encoding"),
            }
        )

    def send_response(self, flow, body):
        if not self.capture:
            return
        r = flow.response
        out.put(
            {
                "type": "flow.response",
                "id": flow.id,
                "status": r.status_code,
                "headers": redact_headers(r.headers),
                "body": None if body is None else encode(body),
                "truncated": body is not None and len(body) > BODY_LIMIT,
                "encoding": r.headers.get("Content-Encoding"),
            }
        )

    def send_done(self, flow, **extra):
        if not self.capture:
            return
        m = meta(flow)
        out.put({"type": "flow.done", "id": flow.id, "bytesUp": m["up"], "bytesDown": m["down"], **extra})

    # --- WebSocket

    def websocket_message(self, flow):
        message = flow.websocket.messages[-1]
        flow.websocket.messages.clear()  # mitmproxy keeps no second history
        m = meta(flow)
        direction = "up" if message.from_client else "down"
        m[direction] += len(message.content)
        if self.capture:
            out.put(
                {
                    "type": "ws.message",
                    "id": flow.id,
                    "direction": direction,
                    "kind": "text" if message.is_text else "binary",
                    "data": encode(message.content),
                    "truncated": len(message.content) > BODY_LIMIT,
                }
            )

    def websocket_end(self, flow):
        if not meta(flow).get("skip"):
            self.send_done(flow, closeCode=flow.websocket.close_code)

    # --- pass-through hosts: bytes only, no content

    def tcp_message(self, flow):
        message = flow.messages[-1]
        flow.messages.clear()
        meta(flow)["up" if message.from_client else "down"] += len(message.content)

    def tcp_end(self, flow):
        if not self.capture:
            return
        m = meta(flow)
        host, port = flow.server_conn.address or ("", 0)
        out.put(
            {
                "type": "tunnel",
                "id": flow.id,
                "port": port_of(flow.client_conn),
                "time": flow.client_conn.timestamp_start,
                "host": host,
                "hostPort": port,
                "bytesUp": m["up"],
                "bytesDown": m["down"],
                "error": flow.error.msg if flow.error else None,
            }
        )

    tcp_error = tcp_end

    def tls_failed_client(self, data):
        if not self.capture:
            return
        server = data.context.server
        host, port = server.address or (server.sni or "", 0)
        out.put(
            {
                "type": "tls.failed",
                "port": port_of(data.context.client),
                "host": server.sni or host,
                "hostPort": port,
                "error": data.conn.error,
            }
        )


addons = [HangarProxy()]
