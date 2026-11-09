// pnpm pack:bay <bay-id> [--key <file>] – signed `.bay` package (ADR 0033).
// pnpm pack:bay --keygen <file>         – new Ed25519 signing key.
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { packBay } from '../packages/host/src/bay-package.ts';

/** Runs the command in the repository `root`; returns the lines to print. */
export function packCommand(
  args: string[],
  env: Record<string, string | undefined>,
  root: string,
): string[] {
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const keygen = option('--keygen');
  if (keygen) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    writeFileSync(keygen, pem, { flag: 'wx', mode: 0o600 });
    return [`public key: ${publicKey.export({ format: 'jwk' }).x}`];
  }
  const id = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!id) throw new Error('Usage: pnpm pack:bay <bay-id> [--key <file>] | --keygen <file>');
  const keyFile = option('--key') ?? env.HANGAR_BAY_KEY;
  if (!keyFile) throw new Error('No signing key: --key <file> or HANGAR_BAY_KEY');
  const dir = readdirSync(join(root, 'bays'))
    .map((name) => join(root, 'bays', name))
    .find((d) => {
      const manifest = join(d, 'manifest.json');
      return existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).id === id;
    });
  if (!dir) throw new Error(`No bay with the id ${id} under bays/`);

  const pkg = packBay(dir, createPrivateKey(readFileSync(keyFile)));
  const file = `dist/bays/${pkg.id}/${pkg.version}.bay`;
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), pkg.bytes);
  writeFileSync(join(root, `${file}.sig`), pkg.signature);
  const { bytes: _bytes, ...entry } = pkg;
  return [JSON.stringify({ ...entry, file })];
}

if (import.meta.main) {
  try {
    for (const line of packCommand(process.argv.slice(2), process.env, process.cwd())) {
      console.log(line);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
