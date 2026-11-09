// `pnpm test:container` (Phase 15): the image of the Hangar Relay, which the script has just built
// as `hangar-relay:test`. Not part of `pnpm test`: it needs Docker and openssl.
import { execFileSync } from 'node:child_process';
import { randomBytes, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  createIdentity,
  signedChallenge,
  Workspace,
  type FromRelay,
} from '../../packages/relay/src';

const IMAGE = process.env.HANGAR_RELAY_IMAGE ?? 'hangar-relay:test';
const TOKEN = randomBytes(16).toString('hex');
const name = `hangar-relay-smoke-${randomBytes(4).toString('hex')}`;
const volume = `${name}-data`;
const tls = mkdtempSync(join(tmpdir(), 'hangar-relay-tls-'));
const anna = createIdentity('anna');

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
const status = () => docker('inspect', '--format', '{{.State.Health.Status}}', name).trim();
// Fixed before the start: the relay binds proofs to the address instances use (HANGAR_RELAY_URL).
let port = 0;
const url = () => `wss://127.0.0.1:${port}`;

/** Connects over TLS with the test certificate and proves Anna's key. */
async function connect() {
  const ws = new WebSocket(url(), {
    ca: readFileSync(join(tls, 'cert.pem')),
  });
  const inbox: FromRelay[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d)) as FromRelay));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const next = async <T extends FromRelay['type']>(type: T) => {
    await vi.waitFor(() => expect(inbox.some((m) => m.type === type)).toBe(true));
    return inbox.splice(
      inbox.findIndex((m) => m.type === type),
      1,
    )[0] as Extract<FromRelay, { type: T }>;
  };
  ws.send(JSON.stringify({ type: 'hello', versions: [1], identity: anna.document }));
  const { nonce } = await next('challenge');
  const sig = sign(null, signedChallenge(nonce, url()), anna.signKey).toString('base64url');
  ws.send(JSON.stringify({ type: 'prove', sig }));
  return { ws, next, ready: await next('ready') };
}

beforeAll(async () => {
  const free = createServer();
  await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
  port = (free.address() as { port: number }).port;
  await new Promise((r) => free.close(r));
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    join(tls, 'key.pem'),
    '-out',
    join(tls, 'cert.pem'),
  ]);
  // Readable by uid 1000 in the container, whoever owns the files on the host. mkdtemp creates
  // the folder with 0700: on Linux (CI) the container could not even open it, Docker Desktop
  // on macOS does not check this.
  chmodSync(tls, 0o755);
  chmodSync(join(tls, 'key.pem'), 0o644);
  docker(
    'run',
    '-d',
    '--name',
    name,
    '-e',
    `HANGAR_RELAY_TOKEN=${TOKEN}`,
    '-e',
    `HANGAR_RELAY_URL=${url()}`,
    '-v',
    `${volume}:/data`,
    '-v',
    `${tls}:/tls:ro`,
    '-p',
    `127.0.0.1:${port}:7430`,
    IMAGE,
  );
  await vi
    .waitFor(() => expect(status()).toBe('healthy'), { timeout: 60_000, interval: 500 })
    .catch((e: Error) => {
      // CI shows only the assertion otherwise; the relay's own error is in its log.
      const log = execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: 'pipe' });
      throw new Error(`${e.message}\n--- docker logs ${name} ---\n${log}`, { cause: e });
    });
});

afterAll(() => {
  docker('rm', '-f', name);
  docker('volume', 'rm', volume);
});

it('runs without root and keeps its data folder to itself', () => {
  expect(docker('exec', name, 'id', '-u').trim()).toBe('1000');
  expect(docker('exec', name, 'stat', '-c', '%U %a', '/data').trim()).toBe('node 700');
});

it('speaks TLS, creates a workspace and still knows it after a restart', async () => {
  const first = await connect();
  expect(first.ready.workspaces).toEqual([]);
  const list = Workspace.found('team', anna).list;
  first.ws.send(JSON.stringify({ type: 'create', id: 1, workspace: 'team', token: TOKEN, list }));
  expect(await first.next('result')).toEqual({ type: 'result', id: 1, ok: true });
  first.ws.close();

  docker('restart', name);
  await vi.waitFor(() => expect(status()).toBe('healthy'), { timeout: 60_000, interval: 500 });
  const again = await connect();
  expect(again.ready.workspaces).toEqual([{ workspace: 'team', list }]);
  again.ws.close();
  expect(docker('exec', name, 'stat', '-c', '%a', '/data/relay.json').trim()).toBe('600');
  expect(docker('logs', name)).not.toContain(TOKEN);
});
