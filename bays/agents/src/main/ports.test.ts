import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { allocatePortBase, isPortFree, PORT_BLOCK } from './ports';

describe('ports', () => {
  it('detects a port in use', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as { port: number };
    expect(await isPortFree(port)).toBe(false);
    server.close();
    await new Promise((r) => server.once('close', r));
    expect(await isPortFree(port)).toBe(true);
  });

  it('skips blocks used by other sessions and busy ports', async () => {
    const busy = new Set([41_200]);
    const base = await allocatePortBase(new Set([41_000, 41_100]), {
      start: 41_000,
      isFree: async (p) => !busy.has(p),
    });
    expect(PORT_BLOCK).toBe(100);
    expect(base).toBe(41_300);
  });

  it('skips blocks that overlap a session from the time of smaller blocks', async () => {
    // An old base is shown with a full block too: 40 010–40 109 reaches into 40 100.
    expect(await allocatePortBase(new Set([40_010]), { isFree: async () => true })).toBe(40_200);
    expect(await allocatePortBase(new Set([40_090]), { isFree: async () => true })).toBe(40_200);
    expect(await allocatePortBase(new Set([40_100]), { isFree: async () => true })).toBe(40_000);
  });

  it('gives up after the port range is exhausted', async () => {
    await expect(
      allocatePortBase(new Set(), { start: 65_530, isFree: async () => false }),
    ).rejects.toThrow('Kein freier Port');
  });
});
