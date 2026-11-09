import { describe, expect, it } from 'vitest';
import { shellCommand } from './job-process';

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
