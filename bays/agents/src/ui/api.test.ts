import { describe, expect, it, vi } from 'vitest';
import type { HangarUiApi } from '@hangar/sdk';
import { agentsApi } from './api';

describe('agentsApi.snapshot', () => {
  it('falls back to the buffer of an older server, without a position', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'session.snapshot') throw new Error('No handler for session.snapshot');
      return 'history';
    });
    const api = agentsApi({ invoke } as unknown as HangarUiApi);
    expect(await api.snapshot('s1')).toEqual({ data: 'history' });
    expect(invoke).toHaveBeenLastCalledWith('session.buffer', 's1');
  });
});
