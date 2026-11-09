import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { shellCommand, startJobProcess } from './job-process';

describe('shellCommand', () => {
  it('runs POSIX shells with their login arguments and -c', () => {
    expect(shellCommand({ file: '/bin/zsh', args: ['-l'] }, 'pnpm test')).toEqual({
      file: '/bin/zsh',
      args: ['-l', '-c', 'pnpm test'],
      verbatim: false,
    });
  });

  it('quotes the whole command for cmd.exe, as Node does for shell: true', () => {
    expect(
      shellCommand({ file: 'C:\\Windows\\System32\\cmd.exe', args: [] }, 'echo "a b"'),
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"echo "a b""'],
      verbatim: true,
    });
  });

  it.each(['powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '/usr/bin/pwsh'])(
    'runs %s without profile',
    (file) => {
      expect(shellCommand({ file, args: [] }, 'pnpm test')).toEqual({
        file,
        args: ['-NoProfile', '-Command', 'pnpm test'],
        verbatim: false,
      });
    },
  );
});

describe.runIf(process.platform === 'win32')('startJobProcess on Windows', () => {
  it('ends the children of the command too, not only cmd.exe', async () => {
    // Without the whole tree ended, the second ping keeps the output pipe open for ~5 s.
    const job = startJobProcess({
      shell: { file: process.env.COMSPEC ?? 'cmd.exe', args: [] },
      command: 'ping -n 6 127.0.0.1 >nul & ping -n 6 127.0.0.1 >nul',
      cwd: tmpdir(),
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 300,
    });
    const started = Date.now();
    await expect(job.done).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
