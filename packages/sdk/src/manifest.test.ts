import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest';

const valid = {
  id: 'dev.hangar.agents',
  name: 'Agents',
  version: '0.1.0',
  minHangarVersion: '0.1.0',
  icon: 'icon.svg',
  ui: 'dist/ui/index.html',
  main: 'dist/main/index.js',
  functions: [{ name: 'session.setStatus', sensitive: false }],
};

describe('parseManifest', () => {
  it('accepts a complete manifest', () => {
    expect(parseManifest(valid)).toEqual({ ok: true, manifest: valid });
  });

  it('defaults functions to an empty list and sensitive to false', () => {
    const { functions: _f, main: _m, ...rest } = valid;
    const result = parseManifest({ ...rest, functions: [{ name: 'a.b' }] });
    expect(result).toEqual({
      ok: true,
      manifest: { ...rest, functions: [{ name: 'a.b', sensitive: false }] },
    });
    expect(parseManifest(rest)).toMatchObject({ ok: true, manifest: { functions: [] } });
  });

  it.each([
    ['id without reverse domain', { id: 'agents' }, 'id'],
    ['id with upper case', { id: 'Dev.Hangar.Agents' }, 'id'],
    ['empty name', { name: '' }, 'name'],
    ['version not semver', { version: '1.0' }, 'version'],
    ['minHangarVersion not semver', { minHangarVersion: 'latest' }, 'minHangarVersion'],
    ['minHangarVersion with leading zero', { minHangarVersion: '01.0.0' }, 'minHangarVersion'],
    ['UNC path', { ui: '\\\\server\\share\\index.html' }, 'ui'],
    ['ui escapes bay folder', { ui: '../evil/index.html' }, 'ui'],
    ['absolute main path', { main: '/etc/passwd' }, 'main'],
    ['function name with slash', { functions: [{ name: 'a/b' }] }, 'functions'],
    ['unknown host module', { hostModules: ['camera'] }, 'hostModules'],
    ['id with the reserved prefix remote.', { id: 'remote.anna.agents' }, 'id'],
    ['uses without a function', { uses: ['dev.hangar.browser'] }, 'uses'],
    ['uses with a bad bay id', { uses: ['browser/page.open'] }, 'uses'],
    ['uses with a wildcard', { uses: ['*'] }, 'uses'],
    ['uses with a wildcard function', { uses: ['dev.hangar.browser/*'] }, 'uses'],
    ['agentSessions not a boolean', { agentSessions: 'yes' }, 'agentSessions'],
    ['dataVersion not an integer', { dataVersion: 1.5 }, 'dataVersion'],
    ['negative dataVersion', { dataVersion: -1 }, 'dataVersion'],
  ])('rejects %s', (_label, override, field) => {
    const result = parseManifest({ ...valid, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(field);
  });

  it('accepts functions callable by other instances, but not sensitive ones (ADR 0011)', () => {
    const shared = { name: 'status.read', sensitive: false, remote: true };
    expect(parseManifest({ ...valid, functions: [shared] })).toEqual({
      ok: true,
      manifest: { ...valid, functions: [shared] },
    });
    expect(parseManifest({ ...valid, functions: [{ ...shared, sensitive: true }] })).toEqual({
      ok: false,
      error: 'functions: Function "status.read" cannot be sensitive and remote',
    });
  });

  it('accepts functions only for bays, not open to agents or remote (ADR 0021)', () => {
    const inner = { name: 'secret.resolve', sensitive: true, bayOnly: true };
    expect(parseManifest({ ...valid, functions: [inner] })).toEqual({
      ok: true,
      manifest: { ...valid, functions: [inner] },
    });
    for (const extra of [
      { openToAgents: true, sensitive: false },
      { remote: true, sensitive: false },
    ])
      expect(parseManifest({ ...valid, functions: [{ ...inner, ...extra }] })).toEqual({
        ok: false,
        error: 'functions: Function "secret.resolve" is only for bays',
      });
  });

  it('accepts the host module secrets (ADR 0021)', () => {
    expect(parseManifest({ ...valid, hostModules: ['secrets'] })).toMatchObject({ ok: true });
  });

  it('accepts uses, agentSessions and dataVersion (ADR 0012)', () => {
    const extra = {
      uses: ['dev.hangar.browser/page.open'],
      agentSessions: true,
      dataVersion: 2,
    };
    expect(parseManifest({ ...valid, ...extra })).toEqual({
      ok: true,
      manifest: { ...valid, ...extra },
    });
  });

  it('accepts the host modules browser and workspaces', () => {
    expect(parseManifest({ ...valid, hostModules: ['browser', 'workspaces'] })).toEqual({
      ok: true,
      manifest: { ...valid, hostModules: ['browser', 'workspaces'] },
    });
  });

  it('accepts functions open to agents, but not sensitive ones (ADR 0016)', () => {
    const open = { name: 'tab.open', sensitive: false, openToAgents: true };
    expect(parseManifest({ ...valid, functions: [open] })).toEqual({
      ok: true,
      manifest: { ...valid, functions: [open] },
    });
    expect(parseManifest({ ...valid, functions: [{ ...open, sensitive: true }] })).toEqual({
      ok: false,
      error: 'functions: Function "tab.open" cannot be sensitive and open to agents',
    });
  });

  it('accepts boolean settings with labels in German and English (ADR 0023)', () => {
    const settings = [
      {
        key: 'copyOnSelect',
        type: 'boolean',
        default: false,
        label: { de: 'Markieren kopiert', en: 'Selecting copies' },
        description: { de: 'Für neue Sessions', en: 'For new sessions' },
      },
    ];
    expect(parseManifest({ ...valid, settings })).toEqual({
      ok: true,
      manifest: { ...valid, settings },
    });
    const one = settings[0]!;
    for (const bad of [
      [{ ...one, type: 'string' }],
      [{ ...one, default: 'no' }],
      [{ ...one, key: 'a b' }],
      [{ ...one, label: { de: 'nur Deutsch' } }],
      [one, one],
    ]) {
      expect(parseManifest({ ...valid, settings: bad })).toMatchObject({ ok: false });
    }
  });

  it('accepts text settings with a text default (ADR 0025)', () => {
    const settings = [
      { key: 'prompt', type: 'text', default: '%~ %# ', label: { de: 'Prompt', en: 'Prompt' } },
    ];
    expect(parseManifest({ ...valid, settings })).toEqual({
      ok: true,
      manifest: { ...valid, settings },
    });
    expect(
      parseManifest({ ...valid, settings: [{ ...settings[0], default: true }] }),
    ).toMatchObject({ ok: false });
  });

  it('accepts SemVer build metadata', () => {
    expect(parseManifest({ ...valid, version: '1.0.0-beta.1+build.7' }).ok).toBe(true);
  });

  it('rejects duplicate function names', () => {
    const result = parseManifest({
      ...valid,
      functions: [{ name: 'a.b' }, { name: 'a.b' }],
    });
    expect(result).toEqual({ ok: false, error: 'functions: Duplicate function name "a.b"' });
  });

  it('rejects non-objects', () => {
    expect(parseManifest(null).ok).toBe(false);
  });
});
