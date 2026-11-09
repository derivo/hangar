import { parseOptions } from './options';
import { startServer } from './server';

try {
  const tick = Number(process.env.HANGAR_TICK_MS) || undefined;
  const server = await startServer({ ...parseOptions(process.argv.slice(2)), tickMs: tick });
  const stop = () => void server.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (e) {
  console.error(`hangar-server: ${(e as Error).message}`);
  process.exit(1);
}
