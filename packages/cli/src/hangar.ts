import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readInput, run, statusline } from './cli.ts';

if (process.argv[2] === 'statusline') {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  process.stdout.write(
    await statusline(stdin, process.env, {
      fetch,
      home: homedir(),
      readFile: (path) => readFileSync(path, 'utf8'),
      exec: (command, input, cwd) =>
        new Promise((resolve, reject) => {
          const child = spawn(command, {
            shell: true,
            cwd,
            env: { ...process.env, HANGAR_STATUSLINE: '1' },
            stdio: ['pipe', 'pipe', 'inherit'],
          });
          let out = '';
          child.stdout.on('data', (d: Buffer) => (out += d));
          child.on('error', reject);
          child.on('close', () => resolve(out));
          child.stdin.end(input);
        }),
    }),
  );
} else {
  const result = await run(process.argv.slice(2), process.env, fetch, undefined, () =>
    readInput(process.stdin),
  );
  // An input left open (`--hook`) would keep the process alive.
  process.stdin.destroy();
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
