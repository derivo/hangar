import { describe, expect, it } from 'vitest';
import { defaultShell, spawnNodePty } from './pty';

describe('defaultShell', () => {
  it('uses $SHELL as login shell on unix', () => {
    expect(defaultShell('darwin', { SHELL: '/bin/zsh' })).toEqual({
      file: '/bin/zsh',
      args: ['-l'],
    });
  });

  it('falls back to the account shell, then /bin/sh', () => {
    expect(defaultShell('darwin', {}, () => '/usr/bin/fish')).toEqual({
      file: '/usr/bin/fish',
      args: ['-l'],
    });
    expect(defaultShell('darwin', {}, () => null)).toEqual({ file: '/bin/sh', args: ['-l'] });
  });

  it('starts no login shell on Linux: /etc/profile there resets PATH and drops the CLI', () => {
    expect(defaultShell('linux', { SHELL: '/bin/bash' })).toEqual({ file: '/bin/bash', args: [] });
    expect(defaultShell('linux', {}, () => null)).toEqual({ file: '/bin/sh', args: [] });
  });

  it('uses COMSPEC or PowerShell on Windows', () => {
    expect(defaultShell('win32', { COMSPEC: 'cmd.exe' })).toEqual({ file: 'cmd.exe', args: [] });
    expect(defaultShell('win32', {})).toEqual({ file: 'powershell.exe', args: [] });
  });
});

describe.skipIf(process.platform === 'win32')('spawnNodePty (real shell)', () => {
  it('runs a command in a real pseudo terminal', async () => {
    const pty = spawnNodePty({
      file: '/bin/sh',
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HANGAR_PROBE: 'pty-ok' },
      cols: 80,
      rows: 24,
    });
    let out = '';
    const exited = new Promise<number>((resolve) => pty.onExit(resolve));
    pty.onData((d) => (out += d));
    pty.resize(100, 30);
    pty.write('echo "$HANGAR_PROBE"; exit 3\r');
    expect(await exited).toBe(3);
    expect(out).toContain('pty-ok');
    pty.kill();
  });
});
