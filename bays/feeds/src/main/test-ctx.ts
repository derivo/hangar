// Test helper: a BayContext that records functions and UI handlers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { BayContext, BayFunction, CallInfo } from '@hangar/sdk';

export function fakeContext(dataDir = mkdtempSync(join(tmpdir(), 'hangar-feeds-'))) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const functions = new Map<string, BayFunction>();
  const ctx = {
    bayId: 'dev.hangar.feeds',
    dataDir,
    hangarVersion: '0.1.0',
    locale: 'de',
    provide: vi.fn((name: string, fn: BayFunction) => void functions.set(name, fn)),
    call: vi.fn(),
    notify: vi.fn(),
    setBadge: vi.fn(),
    setRunning: vi.fn(),
    registerAgentSession: vi.fn(),
    unregisterAgentSession: vi.fn(),
    onAgentSessionEnded: vi.fn(),
    onLocaleChange: vi.fn(),
    settings: { get: vi.fn(), onChange: vi.fn() },
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
  const agent: CallInfo = {
    caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's1' },
  };
  const call = async (name: string, args: unknown = {}) => {
    const fn = functions.get(name);
    if (!fn) throw new Error(`no function ${name}`);
    return fn(args, agent);
  };
  return { ctx, invoke, call, dataDir };
}
