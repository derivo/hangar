// Test helper: a BayContext with a reversible fake keychain.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { BayContext, BayFunction, BaySecrets, CallInfo } from '@hangar/sdk';

/** "Encrypts" by reversing and prefixing, so the file never holds the plain value. */
export const fakeSecrets = (): BaySecrets => ({
  encrypt: vi.fn((text: string) => `enc:${[...text].reverse().join('')}`),
  decrypt: vi.fn((data: string) => [...data.slice(4)].reverse().join('')),
});

export function fakeContext(
  secrets: BaySecrets | undefined = fakeSecrets(),
  dataDir = mkdtempSync(join(tmpdir(), 'hangar-secrets-')),
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const functions = new Map<string, BayFunction>();
  const ctx = {
    bayId: 'dev.hangar.secrets',
    dataDir,
    hangarVersion: '0.1.0',
    locale: 'de',
    ...(secrets && { secrets }),
    provide: vi.fn((name: string, fn: BayFunction) => void functions.set(name, fn)),
    call: vi.fn(),
    notify: vi.fn(),
    setBadge: vi.fn(),
    setRunning: vi.fn(),
    registerAgentSession: vi.fn(),
    unregisterAgentSession: vi.fn(),
    onAgentSessionEnded: vi.fn(),
    onLocaleChange: vi.fn(),
    settings: { get: vi.fn(() => false), onChange: vi.fn() },
    pickFolder: vi.fn(),
    labelSessions: vi.fn(),
    jobs: { onRun: vi.fn(), add: vi.fn(), list: vi.fn(), remove: vi.fn() },
    ui: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        void handlers.set(channel, handler),
      send: vi.fn(),
    },
  } satisfies BayContext;
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler ${channel}`);
    return handler(...args);
  };
  const bay: CallInfo = { caller: { kind: 'bay', bayId: 'dev.hangar.agents' } };
  const call = async (name: string, args: unknown, info: CallInfo = bay) => {
    const fn = functions.get(name);
    if (!fn) throw new Error(`no function ${name}`);
    return fn(args, info);
  };
  return { ctx, invoke, call, dataDir };
}
