import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import bay from './index';
import { fakeContext } from './test-ctx';

async function started(...args: Parameters<typeof fakeContext>) {
  const fake = fakeContext(...args);
  await bay.activate(fake.ctx);
  return fake;
}

describe('dev.hangar.secrets', () => {
  it('stores values encrypted, lists them without values and tells its UI', async () => {
    const { invoke, ctx, dataDir } = await started();
    await invoke('save', { name: 'GITHUB_TOKEN', value: 'ghp_geheim', description: 'CI' });
    expect(await invoke('list')).toEqual([
      { name: 'GITHUB_TOKEN', description: 'CI', updatedAt: expect.any(String) },
    ]);
    const file = readFileSync(join(dataDir, 'vault.json'), 'utf8');
    expect(file).not.toContain('ghp_geheim');
    expect(file).toContain('GITHUB_TOKEN');
    expect(ctx.ui.send).toHaveBeenLastCalledWith('state', await invoke('list'));
  });

  it('replaces a value, keeps it when only the description changes, and removes', async () => {
    const { invoke, call } = await started();
    await invoke('save', { name: 'A', value: 'eins', description: '' });
    await invoke('save', { name: 'A', value: 'zwei', description: '' });
    await invoke('save', { name: 'A', description: 'neu' });
    expect(await call('secret.resolve', { names: ['A'] })).toEqual({ A: 'zwei' });
    expect(await invoke('list')).toMatchObject([{ name: 'A', description: 'neu' }]);
    await invoke('remove', 'A');
    expect(await invoke('list')).toEqual([]);
  });

  it('keeps the vault across a restart', async () => {
    const first = await started();
    await first.invoke('save', { name: 'B', value: 'bleibt', description: '' });
    const second = await started(undefined, first.dataDir);
    expect(await second.call('secret.resolve', { names: ['B'] })).toEqual({ B: 'bleibt' });
  });

  it('rejects invalid names, empty values and a new entry without value', async () => {
    const { invoke } = await started();
    await expect(invoke('save', { name: '1X', value: 'v', description: '' })).rejects.toThrow(
      'Ungültiger Name: 1X',
    );
    await expect(invoke('save', { name: 'HANGAR_X', value: 'v', description: '' })).rejects.toThrow(
      'HANGAR_X ist für Hangar reserviert',
    );
    await expect(invoke('save', { name: 'X', value: '', description: '' })).rejects.toThrow(
      'Wert fehlt',
    );
    await expect(invoke('save', { name: 'X', description: '' })).rejects.toThrow('Wert fehlt');
    await expect(
      invoke('save', { name: 'X', value: 'v', description: 'd'.repeat(201) }),
    ).rejects.toThrow('Beschreibung zu lang');
  });

  it('speaks English errors in an English app', async () => {
    const fake = fakeContext();
    await bay.activate({ ...fake.ctx, locale: 'en' });
    await expect(fake.invoke('save', { name: '1X', value: 'v', description: '' })).rejects.toThrow(
      'Invalid name: 1X',
    );
    await expect(
      fake.invoke('save', { name: 'HANGAR_A', value: 'v', description: '' }),
    ).rejects.toThrow('HANGAR_A is reserved for Hangar');
  });

  it('offers list and resolve for bays; resolve names the missing entry', async () => {
    const { invoke, call, ctx } = await started();
    expect(ctx.provide).toHaveBeenCalledWith(
      'secret.list',
      expect.any(Function),
      expect.any(Object),
    );
    await invoke('save', { name: 'A', value: '1', description: 'x' });
    await invoke('save', { name: 'B', value: '2', description: '' });
    expect(await call('secret.list', {})).toEqual(await invoke('list'));
    expect(await call('secret.resolve', { names: ['B', 'A'] })).toEqual({ B: '2', A: '1' });
    await expect(call('secret.resolve', { names: ['A', 'GONE'] })).rejects.toThrow(
      'Unknown password: GONE',
    );
    for (const args of [{}, { names: 'A' }, { names: [1] }, null])
      await expect(call('secret.resolve', args)).rejects.toThrow('names must be a list of names');
  });

  it('resolves a password named like a property of every object', async () => {
    const { invoke, call } = await started();
    await invoke('save', { name: '__proto__', value: 'p', description: '' });
    const values = (await call('secret.resolve', { names: ['__proto__'] })) as object;
    expect(Object.entries(values)).toEqual([['__proto__', 'p']]);
  });

  it('stores nothing without a keychain', async () => {
    const { invoke, dataDir } = await started();
    const none = await started(
      {
        encrypt: () => {
          throw new Error('Kein Schlüsselbund');
        },
        decrypt: () => '',
      },
      dataDir,
    );
    await expect(none.invoke('save', { name: 'A', value: 'v', description: '' })).rejects.toThrow(
      'Kein Schlüsselbund',
    );
    expect(await invoke('list')).toEqual([]);
    // A host without the module (the server does not load the bay, ADR 0021).
    await invoke('save', { name: 'A', value: 'v', description: '' });
    const keyless = await started(null as never, dataDir);
    await expect(keyless.call('secret.resolve', { names: ['A'] })).rejects.toThrow(
      'Kein Schlüsselbund',
    );
    const without = await started(null as never);
    await expect(
      without.invoke('save', { name: 'A', value: 'v', description: '' }),
    ).rejects.toThrow('Kein Schlüsselbund');
  });
});
