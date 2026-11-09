// Test helper: a BayContext whose agent bay knows two sessions in two projects.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { BayContext, BayFunction, CallInfo } from '@hangar/sdk';

/** shop is shared with the workspaces, blog is not. */
export const PROJECTS = [
  { id: 'p1', name: 'shop', shared: true },
  { id: 'p2', name: 'blog', shared: false },
];
/** Sessions of the agent bay: s1 and s2 in shop, s3 in blog. */
export const SESSIONS: Record<string, { projectId: string; project: string; name: string }> = {
  s1: { projectId: 'p1', project: 'shop', name: 'Login' },
  s2: { projectId: 'p1', project: 'shop', name: 'Suche' },
  s3: { projectId: 'p2', project: 'blog', name: 'Feed' },
};

export function fakeContext(dataDir = mkdtempSync(join(tmpdir(), 'hangar-board-'))) {
  const ended: ((s: { bayId: string; sessionId: string }) => void)[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const functions = new Map<string, BayFunction>();
  const ctx = {
    bayId: 'dev.hangar.board',
    dataDir,
    hangarVersion: '0.1.0',
    locale: 'de',
    provide: vi.fn((name: string, fn: BayFunction) => void functions.set(name, fn)),
    call: vi.fn(async (target: string, args?: unknown): Promise<never> => {
      if (target === 'dev.hangar.agents/project.list') return PROJECTS as never;
      const id = (args as { sessionId: string }).sessionId;
      if (target === 'dev.hangar.agents/session.info' && SESSIONS[id]) return SESSIONS[id] as never;
      throw new Error('Unknown session');
    }),
    notify: vi.fn(),
    setBadge: vi.fn(),
    setRunning: vi.fn(),
    registerAgentSession: vi.fn(),
    unregisterAgentSession: vi.fn(),
    onAgentSessionEnded: (listener: (s: { bayId: string; sessionId: string }) => void) =>
      void ended.push(listener),
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
  const agent = (sessionId: string): CallInfo => ({
    caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId },
  });
  /** An agent of another instance in workspace `team` (ADR 0037, Nachtrag). */
  const remote = (sessionId?: string, instance = 'SHA256:anna0123456789abcdef'): CallInfo => ({
    caller: {
      kind: 'remote',
      instance,
      workspace: 'team',
      bayId: 'dev.hangar.agents',
      ...(sessionId && { sessionId }),
    },
  });
  const call = async (name: string, args: unknown, info: CallInfo) => {
    const fn = functions.get(name);
    if (!fn) throw new Error(`no function ${name}`);
    return fn(args, info);
  };
  /** The agent bay ended a session. */
  const endSession = (sessionId: string, bayId = 'dev.hangar.agents') =>
    ended.forEach((l) => l({ bayId, sessionId }));
  return { ctx, invoke, call, agent, remote, endSession, dataDir };
}
