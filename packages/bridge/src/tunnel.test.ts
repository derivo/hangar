import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAddress, openTunnel, sshArgs } from './tunnel';

const fakeSsh = join(__dirname, '../fixtures/fake-ssh.mjs');

describe('parseAddress', () => {
  it('connects to loopback directly', () => {
    expect(parseAddress('127.0.0.1:7420')).toEqual({ url: 'ws://127.0.0.1:7420/connect' });
    expect(parseAddress(' ws://localhost:7420/connect ')).toEqual({
      url: 'ws://localhost:7420/connect',
    });
    expect(parseAddress('[::1]:7420')).toEqual({ url: 'ws://[::1]:7420/connect' });
  });

  it('reaches any other host through SSH', () => {
    expect(parseAddress('heimserver:7420')).toEqual({ ssh: { host: 'heimserver', port: 7420 } });
    expect(parseAddress('anna@home.example.org:7420')).toEqual({
      ssh: { user: 'anna', host: 'home.example.org', port: 7420 },
    });
  });

  it.each([
    '',
    'heimserver',
    'heimserver:0',
    'heimserver:65536',
    '-oProxyCommand=evil:7420',
    'anna@-oProxyCommand=evil:7420',
    '-l@heimserver:7420',
    'a b:7420',
    'ws://heimserver:7420',
  ])('rejects %j', (address) => {
    expect(() => parseAddress(address)).toThrow(`Invalid address: ${address.trim()}`);
  });
});

describe('sshArgs', () => {
  it('forwards a local loopback port to the server loopback and ends with stdin', () => {
    expect(sshArgs({ user: 'anna', host: 'heimserver', port: 7420 }, 50123)).toEqual([
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'RemoteCommand=none',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-L',
      '127.0.0.1:50123:127.0.0.1:7420',
      '--',
      'anna@heimserver',
      'cat',
    ]);
    expect(sshArgs({ host: 'heimserver', port: 7420 }, 50123).at(-2)).toBe('heimserver');
  });

  it('overrides ssh settings of the user that would detach the tunnel from the app', () => {
    // A config that runs a command and shares a long-lived master connection.
    const config = join(mkdtempSync(join(tmpdir(), 'hangar-ssh-config-')), 'config');
    writeFileSync(
      config,
      'Host *\n  RemoteCommand echo hi\n  ControlMaster auto\n' +
        '  ControlPath /tmp/hangar-%C\n  ControlPersist yes\n',
    );
    const args = sshArgs({ host: 'heimserver', port: 7420 }, 50123);
    const effective = execFileSync('ssh', ['-G', '-F', config, ...args], { encoding: 'utf8' });
    // Unset settings are missing from the output; with `RemoteCommand` ssh would refuse `cat`.
    expect(effective).not.toMatch(/^remotecommand /m);
    expect(effective).toMatch(/^controlmaster false$/m);
    expect(effective).not.toMatch(/^controlpath /m);
  });
});

// The fake ssh is a script with a shebang, which Windows cannot start.
describe.skipIf(process.platform === 'win32')('openTunnel', () => {
  it('forwards a free local port to the remote port', async () => {
    const target = createServer((s) => s.end('hello'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const remote = (target.address() as { port: number }).port;
    const tunnel = await openTunnel({ host: 'heimserver', port: remote }, fakeSsh);
    try {
      expect(tunnel.port).not.toBe(remote);
      const socket = connect(tunnel.port, '127.0.0.1');
      let reply = '';
      for await (const chunk of socket) reply += String(chunk);
      expect(reply).toBe('hello');
    } finally {
      tunnel.close();
      target.close();
    }
  });

  it('ends the tunnel when the process that opened it dies', async () => {
    // A probe may reach the target just as the forwarder is killed: the reset is expected.
    const target = createServer((s) => s.on('error', () => {}).end('hello'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const remote = (target.address() as { port: number }).port;
    const opener = spawn(
      process.execPath,
      [join(__dirname, '../fixtures/open-tunnel.mjs'), fakeSsh, 'heimserver', String(remote)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const [chunk] = (await opener.stdout.take(1).toArray()) as Buffer[];
      const port = Number(String(chunk));
      opener.kill('SIGKILL');
      let open = true;
      for (let i = 0; i < 100 && open; i++) {
        await new Promise((r) => setTimeout(r, 50));
        open = await new Promise<boolean>((resolve) => {
          const socket = connect(port, '127.0.0.1');
          socket.once('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => resolve(false));
        });
      }
      expect(open).toBe(false);
    } finally {
      opener.kill('SIGKILL');
      target.close();
    }
  });

  it('names what ssh said when it fails', async () => {
    await expect(openTunnel({ host: 'unreachable.invalid', port: 7420 }, fakeSsh)).rejects.toThrow(
      'SSH failed: ssh: Could not resolve hostname unreachable.invalid: nodename nor servname provided',
    );
  });

  it('says when ssh cannot be started', async () => {
    await expect(
      openTunnel({ host: 'heimserver', port: 7420 }, '/nonexistent/ssh'),
    ).rejects.toThrow('SSH failed: spawn /nonexistent/ssh ENOENT');
  });
});
