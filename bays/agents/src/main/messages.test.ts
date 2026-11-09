import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from './messages';

afterEach(() => setLocale('de'));

describe('agent bay main texts', () => {
  it('are complete sentences in English', () => {
    setLocale('en');
    expect([
      t.backedUpAs('state.json.corrupt-1'),
      t.shellFailed('ENOENT'),
      t.projectExists('/code/shop'),
      t.notARepository('/tmp/x'),
      t.symlink('.mcp.json'),
      t.unknownProject('p1'),
      t.notOrphan('hangar/x'),
      t.invalidEnvName('1X'),
      t.reservedEnvName('HANGAR_X'),
      t.envValueNotText('FOO'),
      t.restarted,
    ]).toEqual([
      'Backed up as state.json.corrupt-1',
      'Shell could not start: ENOENT',
      'Project is already added: /code/shop',
      'Not a Git repository: /tmp/x',
      '.mcp.json is a symbolic link; Hangar does not write into it.',
      'Unknown project: p1',
      'Not an orphaned Hangar branch: hangar/x',
      'Invalid variable name: 1X',
      'Variable is reserved: HANGAR_X',
      'Value of FOO must be text',
      'Hangar restarted',
    ]);
  });

  it('are bracketed in the pseudo-locale, with values unchanged', () => {
    setLocale('en-XA');
    expect(t.unknownProject('p1')).toBe('[Úñkñówñ prójéçt: p1~~~~~~~~]');
  });
});
