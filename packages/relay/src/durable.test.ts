import { fstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  fsyncSync: fsync,
}));

const { writeDurable } = await import('./replay');
const real = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', real);
  fsync.mockReset();
});

describe('writeDurable', () => {
  it('syncs the folder on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const file = join(mkdtempSync(join(tmpdir(), 'hangar-durable-')), 'state.json');
    writeDurable(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(fsync).toHaveBeenCalledOnce();
  });

  it('syncs the renamed file on Windows, which refuses fsync on a folder (EPERM)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fsync.mockImplementation((fd: number) => {
      if (fstatSync(fd).isDirectory())
        throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' });
    });
    const file = join(mkdtempSync(join(tmpdir(), 'hangar-durable-')), 'state.json');
    writeDurable(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(fsync).toHaveBeenCalledOnce();
  });
});
