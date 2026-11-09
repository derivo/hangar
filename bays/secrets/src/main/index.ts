import { join } from 'node:path';
import type { BayMain } from '@hangar/sdk';
import { messages } from './messages';
import { Vault } from './vault';

const isNames = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((n) => typeof n === 'string');

/** Passwords for the shells of agent sessions, only as environment variables (ADR 0021). */
const bay: BayMain = {
  activate(ctx) {
    const vault = new Vault(join(ctx.dataDir, 'vault.json'), ctx.secrets, messages(ctx.locale));
    const changed = () => ctx.ui.send('state', vault.list());
    // Only for bays (manifest `bayOnly`): agents never see these, nor the values.
    ctx.provide('secret.list', () => vault.list(), { type: 'object', properties: {} });
    ctx.provide(
      'secret.resolve',
      (args) => {
        const names = (args as { names?: unknown } | null)?.names;
        if (!isNames(names)) throw new Error('names must be a list of names');
        return vault.resolve(names);
      },
      {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' } } },
        required: ['names'],
      },
    );
    ctx.ui.handle('list', () => vault.list());
    ctx.ui.handle('save', (entry) => {
      const { name, value, description } = entry as {
        name: string;
        value?: string;
        description: string;
      };
      vault.save(name, value, description);
      changed();
    });
    ctx.ui.handle('remove', (name) => {
      vault.remove(name as string);
      changed();
    });
  },
};

export default bay;
