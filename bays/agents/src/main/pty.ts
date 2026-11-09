import { userInfo } from 'node:os';
import * as nodePty from 'node-pty';

/** The subset of a pseudo terminal the bay uses; faked in unit tests. */
export interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type SpawnPty = (options: SpawnOptions) => PtyProcess;

export const spawnNodePty: SpawnPty = ({ file, args, cwd, env, cols, rows }) => {
  const pty = nodePty.spawn(file, args, { name: 'xterm-256color', cwd, env, cols, rows });
  return {
    onData: (listener) => void pty.onData(listener),
    onExit: (listener) => void pty.onExit((e) => listener(e.exitCode)),
    write: (data) => pty.write(data),
    resize: (c, r) => pty.resize(c, r),
    kill: () => pty.kill(),
  };
};

/** The user's default shell, started as login shell so it reads the user's profile. */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  osShell: () => string | null = () => userInfo().shell,
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: env.COMSPEC ?? 'powershell.exe', args: [] };
  // Login shell like Terminal on macOS. Not on Linux: /etc/profile there sets PATH anew and
  // drops the CLI folder; Linux terminals start interactive shells without login anyway.
  return { file: env.SHELL || osShell() || '/bin/sh', args: platform === 'linux' ? [] : ['-l'] };
}
