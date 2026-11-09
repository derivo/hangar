import { readFileSync } from 'node:fs';
import { parseOptions } from './options';
import { startRelay } from './relay';

try {
  const options = parseOptions(process.argv.slice(2), process.env);
  const { tlsFiles } = options;
  const tls = tlsFiles && {
    cert: readFileSync(tlsFiles.cert, 'utf8'),
    key: readFileSync(tlsFiles.key, 'utf8'),
  };
  const relay = await startRelay({
    ...options,
    ...(tls && { tls }),
    log: (line) => console.log(line),
  });
  const stop = () => void relay.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (e) {
  console.error(`hangar-relay: ${(e as Error).message}`);
  process.exit(1);
}
