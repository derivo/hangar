import { describe, expect, it } from 'vitest';
import { formatEnv, parseEnv } from './env-text';

describe('env text', () => {
  it('parses KEY=value lines, trimming and skipping comments', () => {
    expect(parseEnv('# c\n FOO = bar \n\nURL=http://x?a=b\nEMPTY=')).toEqual({
      FOO: 'bar',
      URL: 'http://x?a=b',
      EMPTY: '',
    });
  });

  it('rejects lines without key', () => {
    expect(() => parseEnv('FOO')).toThrow('Zeile ohne "=": FOO');
    expect(() => parseEnv('=x')).toThrow('Zeile ohne "="');
  });

  it('formats back to lines', () => {
    expect(formatEnv({ A: '1', B: '' })).toBe('A=1\nB=');
  });

  it('reads @secret:NAME as a reference to a password and writes it back (ADR 0021)', () => {
    const env = parseEnv('GH = @secret:GITHUB_TOKEN\nA=1');
    expect(env).toEqual({ GH: { secret: 'GITHUB_TOKEN' }, A: '1' });
    expect(formatEnv(env)).toBe('GH=@secret:GITHUB_TOKEN\nA=1');
  });
});
