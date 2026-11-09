import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
const { promptSpec } = await import('./prompter');

const target = 'dev.hangar.vault/secret.read';

describe('promptSpec', () => {
  it('names the server a question comes from (phase 11b)', () => {
    const spec = promptSpec(
      {
        caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's' },
        target,
        sensitive: true,
        kind: 'grant',
      },
      'Testserver',
    );
    expect(spec.detail).toBe(
      'Auf dem Server „Testserver“: Ein Agent in einer Session von „dev.hangar.agents“ möchte „dev.hangar.vault/secret.read“ aufrufen.',
    );
  });

  it('names instance and workspace of a remote caller (ADR 0011)', () => {
    const spec = promptSpec({
      caller: {
        kind: 'remote',
        bayId: 'dev.hangar.agents',
        instance: '0123456789abcdef'.repeat(4),
        workspace: 'Team',
      },
      target: 'dev.hangar.agents/status.read',
      sensitive: false,
      kind: 'grant',
    });
    expect(spec.detail).toBe(
      'Die Instanz „0123456789abcdef…“ im Workspace „Team“ möchte über die Bay „dev.hangar.agents“ „dev.hangar.agents/status.read“ aufrufen. Die Entscheidung wird gespeichert.',
    );
    expect(spec.buttons.map((b) => b.decision)).toEqual(['allow', 'deny']);
  });

  it('names agents and bays of the local server, and offers a session to its agents (ADR 0036)', () => {
    const agent = promptSpec({
      caller: { kind: 'local-server', bayId: 'dev.hangar.agents', sessionId: 's' },
      target,
      sensitive: true,
      kind: 'grant',
    });
    expect(agent.detail).toBe(
      'Ein Agent in einer Session von „dev.hangar.agents“ im lokalen Server möchte „dev.hangar.vault/secret.read“ aufrufen.',
    );
    expect(agent.buttons[1]).toEqual({ label: 'Für diese Session', decision: 'session' });
    const bay = promptSpec({
      caller: { kind: 'local-server', bayId: 'dev.x' },
      target,
      sensitive: true,
      kind: 'grant',
    });
    expect(bay.detail).toBe(
      'Die Bay „dev.x“ im lokalen Server möchte „dev.hangar.vault/secret.read“ aufrufen.',
    );
    expect(bay.buttons[1]!.label).toBe('Nur dieses Mal');
  });

  it('offers allow/deny for non-sensitive first access by a bay', () => {
    const spec = promptSpec({
      caller: { kind: 'bay', bayId: 'dev.hangar.browser' },
      target,
      sensitive: false,
      kind: 'grant',
    });
    expect(spec.detail).toBe(
      'Die Bay „dev.hangar.browser“ möchte „dev.hangar.vault/secret.read“ aufrufen. Die Entscheidung wird gespeichert.',
    );
    expect(spec.buttons.map((b) => b.decision)).toEqual(['allow', 'deny']);
  });

  it('offers once/session/every-time for sensitive functions', () => {
    const spec = promptSpec({
      caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's' },
      target,
      sensitive: true,
      kind: 'grant',
    });
    expect(spec.detail).toContain('Ein Agent in einer Session von „dev.hangar.agents“');
    expect(spec.buttons).toEqual([
      { label: 'Dauerhaft erlauben', decision: 'allow' },
      { label: 'Für diese Session', decision: 'session' },
      { label: 'Bei jedem Zugriff fragen', decision: 'ask' },
      { label: 'Ablehnen', decision: 'deny' },
    ]);
    const bay = promptSpec({
      caller: { kind: 'bay', bayId: 'b.c' },
      target,
      sensitive: true,
      kind: 'grant',
    });
    expect(bay.buttons[1]!.label).toBe('Nur dieses Mal');
  });

  it('asks a plain confirmation for mode "ask"', () => {
    const spec = promptSpec({
      caller: { kind: 'bay', bayId: 'b.c' },
      target,
      sensitive: true,
      kind: 'confirm',
    });
    expect(spec.message).toBe('Zugriff bestätigen');
    expect(spec.buttons.map((b) => b.decision)).toEqual(['allow', 'deny']);
  });
});

describe('askWithDialog', () => {
  type Options = { cancelId: number; signal?: AbortSignal };
  const electron = async () =>
    (await import('electron')) as unknown as {
      BrowserWindow: { getAllWindows(): unknown[] };
      dialog: { showMessageBox: (...a: unknown[]) => Promise<{ response: number }> };
    };
  const request = {
    caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's' },
    target,
    sensitive: true,
    kind: 'grant',
  } as const;
  /** Like Electron: the box stays open until the signal aborts, then answers `cancelId`. */
  const untilAborted = vi.fn(
    (...args: unknown[]) =>
      new Promise<{ response: number }>((resolve) => {
        const options = args.at(-1) as Options;
        options.signal?.addEventListener('abort', () => resolve({ response: options.cancelId }));
      }),
  );

  // With a parent window: on macOS the signal does nothing for a box without one (electron.d.ts).
  it('closes the dialog of a server question as denied when its connection ends (phase 11b)', async () => {
    const e = await electron();
    e.BrowserWindow.getAllWindows = () => [{ id: 1 }];
    e.dialog.showMessageBox = untilAborted;
    const { askWithDialog } = await import('./prompter');
    const controller = new AbortController();
    let decision: string | undefined;
    const asked = askWithDialog(request, 'Testserver', controller.signal).then(
      (d) => (decision = d),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(decision).toBeUndefined();
    controller.abort();
    await asked;
    expect(decision).toBe('deny');
  });

  it('asks over the first window and answers the chosen button', async () => {
    const e = await electron();
    const window = { id: 1 };
    e.BrowserWindow.getAllWindows = () => [window];
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    e.dialog.showMessageBox = showMessageBox;
    const { askWithDialog } = await import('./prompter');
    await expect(askWithDialog(request)).resolves.toBe('session');
    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.not.objectContaining({ signal: expect.anything() }),
    );
  });

  it('asks without a parent before any window exists', async () => {
    const e = await electron();
    e.BrowserWindow.getAllWindows = () => [];
    const showMessageBox = vi.fn(async () => ({ response: 3 }));
    e.dialog.showMessageBox = showMessageBox;
    const { askWithDialog } = await import('./prompter');
    await expect(askWithDialog(request)).resolves.toBe('deny');
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ cancelId: 3 }));
  });
});
