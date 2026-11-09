import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface RelayCliOptions {
  /** Folder of `relay.json`. */
  data: string;
  file: string;
  host: string;
  port: number;
  operatorToken: string;
  /** Public address from `HANGAR_RELAY_URL`; proofs are bound to it. */
  origin?: string;
  tlsFiles?: { cert: string; key: string };
}

/**
 * `hangar-relay --data <folder> [--listen <host>:<port>] [--tls-cert <pem> --tls-key <pem>]`;
 * the operator token comes from `HANGAR_RELAY_TOKEN`, never from the command line.
 */
export function parseOptions(argv: string[], env: NodeJS.ProcessEnv): RelayCliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      listen: { type: 'string', default: '127.0.0.1:7430' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data <folder> is required');
  if (!env.HANGAR_RELAY_TOKEN) throw new Error('HANGAR_RELAY_TOKEN is required');
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(values.listen);
  if (!match) throw new Error('--listen must be <host>:<port>, e.g. 127.0.0.1:7430');
  const cert = values['tls-cert'];
  const key = values['tls-key'];
  if (!cert !== !key) throw new Error('--tls-cert and --tls-key belong together');
  const host = match[1]!;
  const url = env.HANGAR_RELAY_URL;
  if (url !== undefined && !/^wss?:\/\/[^/\s]+/.test(url))
    throw new Error('HANGAR_RELAY_URL must be a ws:// or wss:// address');
  if (!url && !['127.0.0.1', '::1', 'localhost'].includes(host))
    throw new Error(
      'HANGAR_RELAY_URL is required beyond loopback, e.g. wss://relay.example.com:7430',
    );
  const data = resolve(values.data);
  return {
    data,
    file: join(data, 'relay.json'),
    host,
    port: Number(match[2]),
    operatorToken: env.HANGAR_RELAY_TOKEN,
    ...(url && { origin: url }),
    ...(cert && key && { tlsFiles: { cert, key } }),
  };
}
