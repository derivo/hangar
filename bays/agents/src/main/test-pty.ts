// Test helper: a scriptable fake pseudo terminal.
import type { PtyProcess, SpawnOptions, SpawnPty } from './pty';

export interface FakePty extends PtyProcess {
  options: SpawnOptions;
  written: string[];
  size: [number, number];
  killed: boolean;
  emitData(data: string): void;
  emitExit(code: number): void;
}

export interface FakeSpawn extends SpawnPty {
  all: FakePty[];
  /** Makes the next spawn calls throw this error. */
  fail?: Error;
  /** Clears `fail` after the first failure. */
  failOnce?: boolean;
}

export function fakeSpawn(): FakeSpawn {
  const all: FakePty[] = [];
  const fake: FakeSpawn = Object.assign(
    (options: SpawnOptions) => {
      if (fake.fail) {
        const error = fake.fail;
        if (fake.failOnce) fake.fail = undefined;
        throw error;
      }
      let onData: (d: string) => void = () => {};
      let onExit: (c: number) => void = () => {};
      const pty: FakePty = {
        options,
        written: [],
        size: [options.cols, options.rows],
        killed: false,
        onData: (l) => (onData = l),
        onExit: (l) => (onExit = l),
        write: (d) => pty.written.push(d),
        resize: (c, r) => (pty.size = [c, r]),
        kill: () => {
          pty.killed = true;
          onExit(0);
        },
        emitData: (d) => onData(d),
        emitExit: (c) => onExit(c),
      };
      all.push(pty);
      return pty;
    },
    { all },
  );
  return fake;
}
