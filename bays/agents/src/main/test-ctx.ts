// Test helper: an in-memory BayContext.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { Scheduler } from '@hangar/scheduler';
import type { BayContext, BayFunction, SettingValue, UiLocale } from '@hangar/sdk';

export function fakeContext(locale: UiLocale = 'de') {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const functions = new Map<string, BayFunction>();
  const dataDir = mkdtempSync(join(tmpdir(), 'hangar-ctx-'));
  const scheduler = new Scheduler({ file: join(dataDir, 'jobs.json') });
  const bayId = 'dev.hangar.agents';
  /** Values `ctx.settings.get` returns; tests change them. */
  const settingValues: Record<string, SettingValue> = { copyOnSelect: true, prompt: '' };
  const ctx = {
    bayId,
    dataDir,
    hangarVersion: '0.1.0',
    locale,
    provide: vi.fn((name: string, fn: BayFunction, _schema?: Record<string, unknown>): void => {
      functions.set(name, fn);
    }),
    call: vi.fn(),
    notify: vi.fn(),
    setBadge: vi.fn(),
    setRunning: vi.fn(),
    registerAgentSession: vi.fn((sessionId: string) => ({
      token: `token-${sessionId}`,
      mcpUrl: 'http://127.0.0.1:1/mcp',
      cliDir: '/hangar/bin',
    })),
    unregisterAgentSession: vi.fn(),
    onAgentSessionEnded: vi.fn(),
    onLocaleChange: vi.fn((_listener: (locale: UiLocale) => void) => {}),
    settings: {
      get: vi.fn((key: string) => settingValues[key] ?? false),
      onChange: vi.fn((_listener: (change: { key: string; value: SettingValue }) => void) => {}),
    },
    pickFolder: vi.fn(async (): Promise<string | undefined> => undefined),
    labelSessions: vi.fn(),
    jobs: {
      onRun: (handler) => scheduler.handle(bayId, handler),
      add: (job) => scheduler.add(bayId, job),
      list: () => scheduler.list(bayId),
      remove: (id) => scheduler.remove(id),
    },
    ui: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        void handlers.set(channel, handler),
      send: vi.fn(),
    },
  } satisfies BayContext;
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler ${channel}`);
    return handler(...args);
  };
  return { ctx, invoke, functions, scheduler, settingValues };
}
