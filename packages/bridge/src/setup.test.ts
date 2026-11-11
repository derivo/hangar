import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  choosePackage,
  linuxPackages,
  parseSetupAddress,
  probeMachine,
  remoteListen,
  serverLog,
  serverUpdate,
  uninstallServer,
  setUpServer,
  sshRemote,
  unit,
  type LinuxPackage,
  type Machine,
  type Remote,
} from './setup';

const fakeSsh = join(__dirname, '../fixtures/fake-ssh.mjs');
const PROBE_OUT = [
  'uname=Linux x86_64',
  'glibc=glibc 2.36',
  'home=/home/anna',
  'user=anna',
  'systemd=yes',
  'linger=no',
  'path=/usr/local/bin:/usr/bin:/bin',
  'git=yes',
  '',
].join('\n');
const pkg: LinuxPackage = {
  arch: 'x64',
  file: '/pkg/x64.tar.gz',
  build: '1.0.0+abcd1234',
  glibc: '2.34',
};
const machine: Machine = {
  system: 'Linux',
  arch: 'x86_64',
  glibc: '2.36',
  home: '/home/anna',
  user: 'anna',
  systemd: true,
  linger: false,
  path: '/usr/bin',
  git: true,
  runtimes: [],
};
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

/** A machine that answers the setup's scripts by what they contain. */
function fakeMachine(answers: {
  probe?: string;
  pty?: string;
  install?: number;
  started?: string;
}) {
  return vi.fn<Remote>(async (script) => {
    if (script.includes('uname -sm')) return ok(answers.probe ?? PROBE_OUT);
    if (script.includes('pty-ok')) return ok(answers.pty ?? 'pty-ok\n');
    if (script.includes('HANGAR_UNIT'))
      return { code: answers.install ?? 0, stdout: '', stderr: 'Failed to connect to bus' };
    if (script.includes('pair-code" ] &&'))
      return answers.started === undefined
        ? ok('{"port":4711,"fingerprint":"SHA256:f"}\nABCD-EFGH\n')
        : { code: 3, stdout: answers.started, stderr: '' };
    return ok();
  });
}

describe('setup over ssh (ADR 0041)', () => {
  it('parses [user@]host and refuses ports and option-like names', () => {
    expect(parseSetupAddress(' anna@heimserver ')).toEqual({ user: 'anna', host: 'heimserver' });
    expect(parseSetupAddress('heimserver')).toEqual({ host: 'heimserver' });
    for (const bad of ['heimserver:7420', '-oProxyCommand=x', 'anna@', ''])
      expect(() => parseSetupAddress(bad)).toThrow('Invalid address');
  });

  it('reads the probe, including the runtimes already there', async () => {
    const remote = vi.fn<Remote>(async () => ok(`${PROBE_OUT}runtime=1.0.0+abcd1234\n`));
    expect(await probeMachine(remote)).toEqual({
      ...machine,
      path: '/usr/local/bin:/usr/bin:/bin',
      runtimes: ['1.0.0+abcd1234'],
    });
    remote.mockResolvedValueOnce(ok('uname=Linux aarch64\nglibc=\nlinger=yes\n'));
    expect(await probeMachine(remote)).toMatchObject({
      arch: 'aarch64',
      linger: true,
      systemd: false,
      git: false,
    });
    expect((await probeMachine(remote)).glibc).toBe('2.36');
  });

  // fake-ssh runs its command with /bin/sh, like the tunnel tests not on Windows.
  it.skipIf(process.platform === 'win32')(
    'takes the PATH of the login shell even when it greets first',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hangar-shell-'));
      const shell = join(dir, 'greeting-sh');
      writeFileSync(
        shell,
        '#!/bin/sh\necho Welcome to heimserver\nPATH=/greeted:$PATH exec /bin/sh "$@"\n',
        {
          mode: 0o755,
        },
      );
      vi.stubEnv('SHELL', shell);
      try {
        const { path } = await probeMachine(sshRemote({ host: 'heimserver' }, fakeSsh));
        expect(path.split(':')).toContain('/greeted');
        expect(path).not.toContain('Welcome');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('chooses the package or says exactly why not', () => {
    expect(choosePackage(machine, [pkg])).toBe(pkg);
    const refused =
      (m: Partial<Machine>, packages = [pkg]) =>
      () =>
        choosePackage({ ...machine, ...m }, packages);
    expect(refused({ system: 'Darwin' })).toThrow(/^Not a Linux machine: Darwin$/);
    expect(refused({ arch: 'riscv64' })).toThrow(/^Unsupported architecture: riscv64$/);
    expect(refused({ arch: 'aarch64' })).toThrow(/^No package for arm64 in this build$/);
    expect(refused({ glibc: undefined })).toThrow(/^No glibc on the machine$/);
    expect(refused({ glibc: '2.31' })).toThrow(/^glibc 2\.31 is older than 2\.34$/);
    expect(refused({ glibc: '1.99' })).toThrow(/^glibc 1\.99 is older than 2\.34$/);
    expect(choosePackage({ ...machine, glibc: '3.0' }, [pkg])).toBe(pkg);
    expect(refused({ systemd: false })).toThrow(/^No systemd user services on the machine$/);
    expect(refused({ git: false })).toThrow(/^git not found on the machine$/);
  });

  it('writes a unit with explicit paths, private files and the log next to the data', () => {
    const text = unit('1.0.0+abcd1234');
    expect(text).toContain(
      'ExecStart=%h/.local/share/hangar/runtime/1.0.0+abcd1234/node %h/.local/share/hangar/runtime/1.0.0+abcd1234/server/hangar-server.mjs --data %h/.local/share/hangar/data --root %h --bays %h/.local/share/hangar/runtime/1.0.0+abcd1234/bays --cli %h/.local/share/hangar/runtime/1.0.0+abcd1234/cli/hangar.mjs',
    );
    expect(text).toContain('UMask=0077');
    expect(text).toContain('StandardOutput=append:%h/.local/share/hangar/data/server.log');
    expect(text).not.toContain('~');
  });

  it('uploads a new build, checks node-pty, installs the unit and returns what it read', async () => {
    const remote = fakeMachine({});
    expect(await setUpServer(remote, [pkg])).toEqual({
      remoteData: '/home/anna/.local/share/hangar/data',
      port: 4711,
      fingerprint: 'SHA256:f',
      code: 'ABCD-EFGH',
      linger: false,
      user: 'anna',
      build: '1.0.0+abcd1234',
    });
    const upload = remote.mock.calls.find(([, input]) => input);
    expect(upload?.[1]).toBe('/pkg/x64.tar.gz');
    // Its own temp folder; a runtime another setup finished meanwhile stays (Codex).
    expect(upload?.[0]).toContain('.tmp.$$"');
    expect(upload?.[0]).toContain('[ -d "$HOME/.local/share/hangar/runtime/1.0.0+abcd1234" ] ||');
    const install = remote.mock.calls.find(([s]) => s.includes('HANGAR_UNIT'))![0];
    expect(install).toContain('PATH="/usr/local/bin:/usr/bin:/bin"');
    expect(install).toContain('rm -f "$HOME/.local/share/hangar/data/pair-code"');
    // Once it runs, runtimes the unit no longer starts go; uploads still running stay.
    const prune = remote.mock.calls.at(-1)![0];
    expect(prune).toContain(`'1.0.0+abcd1234'|"$cur"|*.tmp.*) ;;`);
  });

  it('does not upload a build that is there, and escapes quotes in the PATH', async () => {
    const remote = fakeMachine({
      probe: `${PROBE_OUT.replace('/bin\n', '/b"in\n')}runtime=1.0.0+abcd1234\n`,
    });
    await setUpServer(remote, [pkg]);
    expect(remote.mock.calls.some(([, input]) => input)).toBe(false);
    expect(remote.mock.calls.find(([s]) => s.includes('HANGAR_UNIT'))![0]).toContain('/b\\"in"');
  });

  it('stops with the reason when node-pty, the unit or the server fails', async () => {
    // Node ends an uncaught error with the stack and its version: the error line counts.
    const failing = vi.fn<Remote>(async (script) =>
      script.includes('pty-ok')
        ? {
            code: 1,
            stdout: '',
            stderr: [
              'node:internal/modules/cjs/loader:1228',
              '  throw err;',
              '',
              'Error: libstdc++.so.6: cannot open shared object file: No such file or directory',
              '    at Module._extensions..node (node:internal/modules/cjs/loader:1454:18)',
              '',
              'Node.js v24.22.3',
              '',
            ].join('\n'),
          }
        : fakeMachine({})(script),
    );
    await expect(setUpServer(failing, [pkg])).rejects.toThrow(
      /^node-pty does not start on the machine: Error: libstdc\+\+\.so\.6: cannot open shared object file: No such file or directory$/,
    );
    await expect(
      setUpServer(fakeMachine({ pty: '' }), [pkg]).catch((e: Error) => e.message),
    ).resolves.toMatch(/^node-pty does not start on the machine: /);
    await expect(setUpServer(fakeMachine({ install: 1 }), [pkg])).rejects.toThrow(
      'Installing the service failed: Failed to connect to bus',
    );
    await expect(
      setUpServer(fakeMachine({ started: 'Error: EACCES\n' }), [pkg], 500),
    ).rejects.toThrow('The server did not start: Error: EACCES');
    // Nothing on stdout: the last line of stderr, else the exit code.
    const silent = vi.fn<Remote>(async (script) =>
      script.includes('pair-code" ] &&')
        ? { code: 3, stdout: '', stderr: 'sh: tail: not found\n' }
        : script.includes('HANGAR_UNIT')
          ? { code: 0, stdout: '', stderr: '' }
          : fakeMachine({})(script),
    );
    await expect(setUpServer(silent, [pkg], 500)).rejects.toThrow(
      'The server did not start: sh: tail: not found',
    );
    const mute = vi.fn<Remote>(async (script) =>
      script.includes('HANGAR_UNIT')
        ? { code: 1, stdout: '', stderr: '' }
        : fakeMachine({})(script),
    );
    await expect(setUpServer(mute, [pkg])).rejects.toThrow(
      'Installing the service failed: exit code 1',
    );
    const upload = vi.fn<Remote>(async (script, input) =>
      input ? { code: 2, stdout: '', stderr: 'tar: unexpected EOF\n' } : fakeMachine({})(script),
    );
    await expect(setUpServer(upload, [pkg])).rejects.toThrow('Upload failed: tar: unexpected EOF');
  });

  it('compares the build the unit starts with the package for its architecture', async () => {
    const arm: LinuxPackage = { ...pkg, arch: 'arm64', build: '1.0.0+ffff0000' };
    const answer = (stdout: string) => vi.fn<Remote>(async () => ok(stdout));
    const running = answer('x86_64 0.9.0+00000000\n');
    await expect(serverUpdate(running, [arm, pkg])).resolves.toEqual({
      running: '0.9.0+00000000',
      ready: '1.0.0+abcd1234',
    });
    expect(running.mock.calls[0]![0]).toContain('hangar-server.service');
    await expect(serverUpdate(answer('x86_64 1.0.0+abcd1234\n'), [pkg])).resolves.toBeUndefined();
    // No unit, or no package for it in this build: nothing to offer.
    await expect(serverUpdate(answer('x86_64 \n'), [pkg])).resolves.toBeUndefined();
    await expect(serverUpdate(answer('aarch64 0.9.0+0\n'), [pkg])).resolves.toBeUndefined();
  });

  it('removes the unit and the runtimes, the data folder only when asked', async () => {
    const remote = vi.fn<Remote>(async () => ok());
    await uninstallServer(remote, { data: false });
    const [script] = remote.mock.calls[0]!;
    expect(script).toMatch(
      /^set -e\nif \[ -e "\$HOME\/\.config\/systemd\/user\/hangar-server\.service" \]; then systemctl --user disable --now hangar-server\.service; fi\n/,
    );
    expect(script).toContain('rm -f "$HOME/.config/systemd/user/hangar-server.service"');
    expect(script).toContain('"$HOME/.local/share/hangar/runtime"');
    expect(script).not.toContain('hangar/data');
    await uninstallServer(remote, { data: true });
    expect(remote.mock.calls[1]![0]).toContain('"$HOME/.local/share/hangar/data"');
    remote.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'rm: Permission denied\n' });
    await expect(uninstallServer(remote, { data: true })).rejects.toThrow(
      'Removing the server failed: rm: Permission denied',
    );
  });

  it('reads the last lines of the server log', async () => {
    const remote = vi.fn<Remote>(async () => ok('a\nb\n'));
    await expect(serverLog(remote, '/home/anna/.local/share/hangar/data')).resolves.toBe('a\nb');
    expect(remote.mock.calls[0]![0]).toBe(
      "tail -n 20 '/home/anna/.local/share/hangar/data/server.log'",
    );
  });

  it('reads the port of a running server, or says it is not running', async () => {
    const remote = vi.fn<Remote>(async () => ok('{"port":4711,"fingerprint":"SHA256:f"}'));
    await expect(remoteListen(remote, '/home/anna/.local/share/hangar/data')).resolves.toEqual({
      port: 4711,
      fingerprint: 'SHA256:f',
    });
    expect(remote.mock.calls[0]![0]).toBe("cat '/home/anna/.local/share/hangar/data/listen.json'");
    remote.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'No such file' });
    await expect(remoteListen(remote, '/x')).rejects.toThrow(
      'The server on the machine is not running',
    );
  });

  it('reads the packages of the build with their glibc and a build id per content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-packages-'));
    expect(await linuxPackages(dir, '1.0.0')).toEqual([]);
    const src = join(dir, 'src');
    mkdirSync(join(src, 'hangar-server'), { recursive: true });
    writeFileSync(join(src, 'hangar-server/requirements.json'), '{"glibc":"2.34"}');
    execFileSync('tar', [
      '-czf',
      join(dir, 'hangar-server-linux-arm64.tar.gz'),
      '-C',
      src,
      'hangar-server',
    ]);
    const [found] = await linuxPackages(dir, '1.0.0');
    expect(found).toMatchObject({ arch: 'arm64', glibc: '2.34' });
    expect(found!.build).toMatch(/^1\.0\.0\+[0-9a-f]{8}$/);
    writeFileSync(join(dir, 'hangar-server-linux-x64.tar.gz'), 'not a tar');
    await expect(linuxPackages(dir, '1.0.0')).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'runs scripts over ssh with stdin from a file, and reports a failing ssh',
    async () => {
      const remote = sshRemote({ user: 'anna', host: 'heimserver' }, fakeSsh);
      expect(await remote(`printf '%s\\n' "it's" && exit 4`)).toEqual({
        code: 4,
        stdout: "it's\n",
        stderr: '',
      });
      const input = join(mkdtempSync(join(tmpdir(), 'hangar-input-')), 'in');
      writeFileSync(input, 'from the file');
      expect((await remote('cat', input)).stdout).toBe('from the file');
      await expect(sshRemote({ host: 'unreachable.invalid' }, fakeSsh)('true')).rejects.toThrow(
        /^SSH failed: ssh: Could not resolve hostname/,
      );
      await expect(remote('exit 255')).rejects.toThrow(/^SSH failed: exit code 255$/);
      await expect(sshRemote({ host: 'x' }, '/nonexistent/ssh')('true')).rejects.toThrow(
        /^SSH failed: /,
      );
    },
  );
});
