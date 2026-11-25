// The engine with a real mitmdump and the addon (ADR 0049, step 2, acceptance criterion 2).
// Skipped with the reason in its name when mitmdump or openssl is missing; CI installs both.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type IncomingHttpHeaders } from 'node:http';
import { createServer as createHttpsServer, get as httpsGet } from 'node:https';
import { connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { Ca } from './ca';
import { findMitmdump, MitmEngine } from './engine';
import type { AddonEvent } from './protocol';

const ADDON = resolve(import.meta.dirname, '../addon/hangar_proxy.py');
const missing = (() => {
  try {
    findMitmdump('');
  } catch {
    return 'mitmdump not found';
  }
  try {
    execFileSync('openssl', ['version']);
  } catch {
    return 'openssl not found';
  }
  return '';
})();
// CI installs both: there a skip would hide a missing test.
if (missing && process.env.CI) throw new Error(`engine integration test: ${missing}`);

const dir = mkdtempSync(join(tmpdir(), 'hangar-proxy-it-'));
const file = (name: string) => join(dir, name);
const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });

/** A test CA and a certificate for 127.0.0.1 signed by it. */
function certificates() {
  openssl(
    ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2'],
    ...['-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Hangar test CA'],
    ...['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'],
  );
  writeFileSync(
    file('ext.cnf'),
    'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' +
      'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n',
  );
  openssl(
    ...['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key'],
    '-out',
    'srv.csr',
    '-subj',
    '/CN=127.0.0.1',
  );
  openssl(
    ...['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial'],
    ...['-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf'],
  );
  return { key: readFileSync(file('srv.key')), cert: readFileSync(file('srv.pem')) };
}

const listening = (server: Server) =>
  new Promise<number>((done) =>
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)),
  );
const basic = (password: string) => `Basic ${Buffer.from(`hangar:${password}`).toString('base64')}`;

// --- WebSocket frames (RFC 6455), enough for this test
function frame(opcode: number, payload: Buffer, fin = true, masked = true): Buffer {
  const len = payload.length;
  const head =
    len < 126
      ? [len]
      : len < 65536
        ? [126, len >> 8, len & 255]
        : [127, 0, 0, 0, 0, len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255];
  const mask = masked ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(0);
  const body = Buffer.from(payload.map((b, i) => (masked ? b ^ mask[i % 4]! : b)));
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | head[0]!, ...head.slice(1)]),
    mask,
    body,
  ]);
}

/** Collects frames from a socket: `{ opcode, payload }`. */
function frames(socket: Socket, onFrame: (opcode: number, payload: Buffer) => void) {
  let buf = Buffer.alloc(0);
  socket.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1]! & 127;
      let at = 2;
      if (len === 126) [len, at] = [buf.readUInt16BE(2), 4];
      else if (len === 127) [len, at] = [Number(buf.readBigUInt64BE(2)), 10];
      const masked = (buf[1]! & 128) !== 0;
      const start = at + (masked ? 4 : 0);
      if (buf.length < start + len) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(start, start + len));
      if (masked) for (let i = 0; i < len; i++) payload[i]! ^= mask[i % 4]!;
      onFrame(buf[0]! & 15, payload);
      buf = buf.subarray(start + len);
    }
  });
}

/** Reads up to the end of an HTTP head from a raw socket. */
const head = (socket: Socket) =>
  new Promise<{ status: number; bytes: number; text: string }>((done, fail) => {
    let text = '';
    const onData = (d: Buffer) => {
      text += d.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const rest = Buffer.from(text.slice(end + 4), 'latin1');
      if (rest.length) socket.unshift(rest);
      done({ status: Number(text.split(' ')[1]), bytes: end + 4, text: text.slice(0, end) });
    };
    socket.on('data', onData);
    socket.once('error', fail);
  });

/** A raw CONNECT through the proxy; resolves with the socket after the answer. */
async function tunnel(port: number, target: string, password: string) {
  const socket = connect(port, '127.0.0.1');
  const req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(password)}\r\n\r\n`;
  socket.write(req);
  const answer = await head(socket);
  return { socket, status: answer.status, sent: req.length, received: answer.bytes };
}

/** Opens a WebSocket through the proxy (plain HTTP); resolves after the 101. */
async function websocket(port: number, upstream: number, password: string, path = '/ws') {
  const socket = connect(port, '127.0.0.1');
  socket.write(
    `GET http://127.0.0.1:${upstream}${path} HTTP/1.1\r\nHost: 127.0.0.1:${upstream}\r\n` +
      `Proxy-Authorization: ${basic(password)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n',
  );
  const answer = await head(socket);
  expect(answer.status).toBe(101);
  // Compression is never negotiated, also when the server claims it unasked.
  expect(answer.text.toLowerCase()).not.toContain('sec-websocket-extensions');
  return socket;
}

const closed = (socket: Socket) =>
  new Promise<void>((done) => (socket.destroyed ? done() : socket.once('close', () => done())));

const freePort = async () => {
  const server = createHttpServer();
  const port = await listening(server);
  server.close();
  return port;
};

// The steps build on each other: listeners, then pass-through, then removal.
describe.skipIf(missing)(
  `engine with a real mitmdump${missing ? ` (skipped: ${missing})` : ''}`,
  { shuffle: false },
  () => {
    let engine: MitmEngine;
    let ca: Ca;
    const events: AddonEvent[] = [];
    const seen: IncomingHttpHeaders[] = [];
    const upgrades: IncomingHttpHeaders[] = [];
    const serverCloses: number[] = [];
    let plain: number;
    let secure: number;
    let pinned: number;
    let A: number;
    let B: number;
    const servers: Server[] = [];

    beforeAll(async () => {
      const tls = certificates();
      const handler = (
        req: { headers: IncomingHttpHeaders },
        res: import('node:http').ServerResponse,
      ) => {
        seen.push(req.headers);
        // 4 MB of zeros as a 4 KB gzip body: must reach the bay compressed.
        if ((req as { url?: string }).url === '/gzip') {
          const gz = gzipSync(Buffer.alloc(4 * 1024 * 1024));
          res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
          return void res.end(gz);
        }
        res.end('hello');
      };
      const http = createHttpServer(handler);
      // A WebSocket server that echoes text and records close codes.
      http.on('upgrade', (req, socket: Socket) => {
        upgrades.push(req.headers);
        const deflate = req.url === '/ws-deflate';
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
            (deflate ? 'Sec-WebSocket-Extensions: permessage-deflate\r\n' : '') +
            '\r\n',
        );
        // A compressed frame (RSV1) the proxy must not inflate.
        if (deflate) {
          const packed = frame(
            1,
            deflateRawSync(Buffer.from('inflated by the proxy')),
            true,
            false,
          );
          packed[0]! |= 0x40;
          socket.write(packed);
        }
        frames(socket, (opcode, payload) => {
          if (opcode === 1) socket.write(frame(1, payload, true, false));
          if (opcode === 8) serverCloses.push(payload.readUInt16BE(0));
        });
        socket.on('error', () => {});
      });
      const https = createHttpsServer(tls, handler);
      const pin = createHttpsServer(tls, (_req, res) => res.end('x'.repeat(5000)));
      servers.push(http, https, pin);
      [plain, secure, pinned] = await Promise.all(servers.map(listening));
      [A, B] = [await freePort(), await freePort()];

      const dataDir = mkdtempSync(join(tmpdir(), 'hangar-proxy-it-data-'));
      ca = new Ca(dataDir);
      engine = new MitmEngine({
        ca,
        addonPath: ADDON,
        mitmdumpPath: () => '',
        upstreamCaFile: () => file('ca.pem'),
      });
      engine.onEvent((e) => events.push(e));
    }, 60_000);

    afterAll(async () => {
      await engine?.stop();
      for (const s of servers as import('node:http').Server[]) {
        s.closeAllConnections();
        s.close();
      }
    });

    it('records proxied HTTP and HTTPS redacted, behind per-listener credentials', async () => {
      await engine.listen(A, 'pw-a');
      await engine.listen(B, 'pw-b');
      expect(engine.status()).toMatchObject({
        state: 'running',
        version: expect.stringMatching(/^12\./),
      });

      // Plain HTTP: wrong, missing or the other listener's password gets 407.
      const plainGet = (password?: string) =>
        new Promise<{ status: number; body: string }>((done, fail) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: A,
              path: `http://127.0.0.1:${plain}/x?access_token=query-secret-1&page=2&%74oken=enc-secret-2`,
              headers: {
                Authorization: 'Bearer header-secret',
                ...(password ? { 'Proxy-Authorization': basic(password) } : {}),
              },
            },
            (res) => {
              let body = '';
              res.on('data', (d) => (body += d));
              res.on('end', () => done({ status: res.statusCode!, body }));
            },
          );
          req.on('error', fail);
          req.end();
        });
      expect((await plainGet()).status).toBe(407);
      expect((await plainGet('wrong')).status).toBe(407);
      expect((await plainGet('pw-b')).status).toBe(407);
      expect(seen).toHaveLength(0);
      expect(await plainGet('pw-a')).toEqual({ status: 200, body: 'hello' });
      expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer header-secret' });
      expect(seen.at(-1)).not.toHaveProperty('proxy-authorization');

      // HTTPS: CONNECT with credentials, then a request in the tunnel.
      expect((await tunnel(A, `127.0.0.1:${secure}`, 'wrong')).status).toBe(407);
      const t = await tunnel(A, `127.0.0.1:${secure}`, 'pw-a');
      expect(t.status).toBe(200);
      const body = await new Promise<string>((done, fail) => {
        const tlsSocket = tlsConnect({
          socket: t.socket,
          host: '127.0.0.1',
          ca: readFileSync(ca.certFile),
        });
        httpsGet(
          {
            host: '127.0.0.1',
            port: secure,
            path: '/s',
            headers: { Authorization: 'Bearer tunnel-secret' },
            createConnection: () => tlsSocket,
          },
          (res) => {
            let text = '';
            res.on('data', (d) => (text += d));
            res.on('end', () => done(text));
          },
        ).on('error', fail);
      });
      expect(body).toBe('hello');
      expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer tunnel-secret' });
      expect(seen.at(-1)).not.toHaveProperty('proxy-authorization');
      t.socket.destroy();

      await vi.waitFor(() => expect(events.filter((e) => e.type === 'flow.done')).toHaveLength(2));
      const requests = events.filter((e) => e.type === 'flow.request');
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        port: A,
        method: 'GET',
        url: `http://127.0.0.1:${plain}/x?access_token=•••• (14 chars)&page=2&%74oken=•••• (12 chars)`,
      });
      expect(requests[0]!.type === 'flow.request' && requests[0].headers).toContainEqual([
        'Authorization',
        '•••• (20 chars)',
      ]);
      expect(requests[1]).toMatchObject({ port: A, url: `https://127.0.0.1:${secure}/s` });
      expect(events.find((e) => e.type === 'flow.response')).toMatchObject({
        status: 200,
        body: Buffer.from('hello').toString('base64'),
      });
      // Denied requests leave no flow, and no secret reaches the bay.
      const all = JSON.stringify(events);
      for (const secret of [
        'query-secret-1',
        'enc-secret-2',
        'header-secret',
        'tunnel-secret',
        'pw-a',
      ])
        expect(all).not.toContain(secret);
      expect(engine.status().warnings).toEqual({ broken: 0, unknown: 0, overflow: 0, dropped: 0 });
    });

    it('binds only loopback addresses', () => {
      const lines =
        process.platform === 'win32'
          ? execFileSync('powershell', [
              '-NoProfile',
              '-Command',
              `(Get-NetTCPConnection -State Listen -LocalPort ${A},${B}).LocalAddress`,
            ])
              .toString()
              .trim()
              .split(/\r?\n/)
          : execFileSync('lsof', ['-nP', `-iTCP:${A}`, `-iTCP:${B}`, '-sTCP:LISTEN', '-Fn'])
              .toString()
              .split('\n')
              .filter((l) => l.startsWith('n'))
              .map((l) => l.slice(1).replace(/:\d+$/, ''));
      expect(lines.length).toBeGreaterThan(0);
      expect(new Set(lines)).toEqual(new Set(['127.0.0.1']));
    });

    it('passes an ignored host through and counts its bytes', async () => {
      await engine.ignore([`^127\\.0\\.0\\.1:${pinned}$`]);
      const t = await tunnel(A, `127.0.0.1:${pinned}`, 'pw-a');
      expect(t.status).toBe(200);
      // The client sees the server's own certificate: no interception.
      const tlsSocket = tlsConnect({
        socket: t.socket,
        host: '127.0.0.1',
        ca: readFileSync(file('ca.pem')),
      });
      const body = await new Promise<string>((done, fail) => {
        httpsGet(
          {
            host: '127.0.0.1',
            port: pinned,
            path: '/',
            createConnection: () => tlsSocket,
            headers: { Connection: 'close' },
          },
          (res) => {
            let text = '';
            res.on('data', (d) => (text += d));
            res.on('end', () => done(text));
          },
        ).on('error', fail);
      });
      expect(body).toHaveLength(5000);
      const up = t.socket.bytesWritten - t.sent;
      const down = t.socket.bytesRead - t.received;
      await closed(t.socket);
      await vi.waitFor(() => expect(events.find((e) => e.type === 'tunnel')).toBeDefined());
      const row = events.find((e) => e.type === 'tunnel')!;
      expect(row).toMatchObject({ port: A, host: '127.0.0.1', hostPort: pinned, error: null });
      // The TLS bytes the client counted; only the close alerts (24 bytes each in TLS 1.3)
      // race the shutdown and may or may not be relayed.
      if (row.type !== 'tunnel') throw new Error('no tunnel row');
      expect(Math.abs(row.bytesUp - up)).toBeLessThanOrEqual(48);
      expect(Math.abs(row.bytesDown - down)).toBeLessThanOrEqual(48);
      expect(row.bytesDown).toBeGreaterThan(5000);
    });

    it('strips WebSocket compression and ends a 20 MB message with 1009', async () => {
      const socket = await websocket(A, plain, 'pw-a');
      expect(upgrades.at(-1)).not.toHaveProperty('sec-websocket-extensions');
      const fromProxy: number[] = [];
      frames(socket, (opcode, payload) => opcode === 8 && fromProxy.push(payload.readUInt16BE(0)));
      socket.on('error', () => {});
      const mb = Buffer.alloc(1024 * 1024, 'a');
      for (let i = 0; i < 20 && !socket.destroyed; i++) socket.write(frame(i ? 0 : 1, mb, false));
      await vi.waitFor(() => expect(events.find((e) => e.type === 'ws.tooLarge')).toBeDefined(), {
        timeout: 20_000,
      });
      await vi.waitFor(() => {
        expect(fromProxy).toEqual([1009]);
        expect(serverCloses).toEqual([1009]);
      });
    }, 30_000);

    it('hands compressed bodies on compressed, never inflated', async () => {
      const body = await new Promise<Buffer>((done, fail) => {
        request(
          {
            host: '127.0.0.1',
            port: A,
            path: `http://127.0.0.1:${plain}/gzip`,
            headers: { Host: `127.0.0.1:${plain}`, 'Proxy-Authorization': basic('pw-a') },
          },
          (res) => {
            const parts: Buffer[] = [];
            res.on('data', (d: Buffer) => parts.push(d));
            res.on('end', () => done(Buffer.concat(parts)));
          },
        )
          .on('error', fail)
          .end();
      });
      const gzipped = () =>
        events.findLast(
          (e) => e.type === 'flow.response' && e.headers.some(([, v]) => v === 'gzip'),
        );
      await vi.waitFor(() => expect(gzipped()).toBeDefined());
      const response = gzipped();
      expect(response).toMatchObject({ encoding: 'gzip', truncated: false });
      if (response?.type !== 'flow.response') throw new Error('no response');
      expect(Buffer.from(response.body!, 'base64')).toEqual(body);
    });

    it('drops a WebSocket compressed against the handshake', async () => {
      const socket = await websocket(A, plain, 'pw-a', '/ws-deflate');
      socket.on('error', () => {});
      await closed(socket);
      expect(JSON.stringify(events)).not.toContain(
        Buffer.from('inflated by the proxy').toString('base64'),
      );
    });

    it('closes the tunnels and WebSockets of a removed listener only', async () => {
      const a = await tunnel(A, `127.0.0.1:${secure}`, 'pw-a');
      const aTls: TLSSocket = tlsConnect({
        socket: a.socket,
        host: '127.0.0.1',
        ca: readFileSync(ca.certFile),
      });
      await new Promise((r) => aTls.once('secureConnect', r));
      const aWs = await websocket(A, plain, 'pw-a');
      const bWs = await websocket(B, plain, 'pw-b');
      const echoes: string[] = [];
      frames(bWs, (opcode, payload) => opcode === 1 && echoes.push(payload.toString()));

      await engine.unlisten(A);
      await Promise.all([closed(a.socket), closed(aWs)]);
      bWs.write(frame(1, Buffer.from('still here')));
      await vi.waitFor(() => expect(echoes).toEqual(['still here']));
      bWs.destroy();
    });

    it('reaches a public HTTPS host with the system roots', async () => {
      const t = await tunnel(B, 'example.com:443', 'pw-b');
      expect(t.status).toBe(200);
      const answer = await new Promise<{ status: number; body: string }>((done, fail) => {
        const tlsSocket = tlsConnect({
          socket: t.socket,
          servername: 'example.com',
          ca: readFileSync(ca.certFile),
        });
        httpsGet({ host: 'example.com', path: '/', createConnection: () => tlsSocket }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => done({ status: res.statusCode!, body }));
        }).on('error', fail);
      });
      // A 502 carries mitmproxy's reason, e.g. a certificate the upstream roots lack.
      expect(answer.status, answer.body.slice(0, 500)).toBe(200);
      t.socket.destroy();
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'flow.request', port: B, url: 'https://example.com/' }),
        ),
      );
    }, 30_000);
  },
);
