import { createServer } from 'node:net';
import { PORT_BLOCK } from './types';
import { t } from './messages';

export { PORT_BLOCK };

const FIRST_PORT = 40_000;

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once('error', () => resolve(false))
      .listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Finds the first block that overlaps no other session's block and whose base port
 * is not currently bound by some process.
 */
export async function allocatePortBase(
  used: Set<number>,
  { start = FIRST_PORT, isFree = isPortFree } = {},
): Promise<number> {
  for (let port = start; port + PORT_BLOCK <= 65_535; port += PORT_BLOCK) {
    // Older sessions start off the grid of blocks; each still owns a full block from its base.
    const taken = [...used].some((u) => u < port + PORT_BLOCK && u + PORT_BLOCK > port);
    if (!taken && (await isFree(port))) return port;
  }
  throw new Error(t.noFreePort);
}
