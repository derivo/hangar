import { describe, expect, it, vi } from 'vitest';
import { TerminalRegistry, type TerminalHandle } from './terminals';
import type { Snapshot } from './api';

function setup() {
  let resolveSnapshot: (s: Snapshot) => void = () => {};
  const api = {
    input: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    snapshot: vi.fn(() => new Promise<Snapshot>((r) => (resolveSnapshot = r))),
  };
  const handles: (TerminalHandle & {
    written: string[];
    selection: string;
    emit(d: string): void;
    /** Set to hold back the end of a write, as xterm parses asynchronously. */
    held?: () => void;
    hold: boolean;
  })[] = [];
  const registry = new TerminalRegistry(api, () => {
    let listener: (d: string) => void = () => {};
    const h = {
      written: [] as string[],
      selection: '',
      getSelection: () => h.selection,
      open: vi.fn(),
      hold: false,
      held: undefined as (() => void) | undefined,
      write: (d: string, done?: () => void) => {
        h.written.push(d);
        if (h.hold && done) h.held = done;
        else done?.();
      },
      onData: (l: (d: string) => void) => void (listener = l),
      fit: vi.fn(() => ({ cols: 80, rows: 24 })),
      focus: vi.fn(),
      dispose: vi.fn(),
      emit: (d: string) => listener(d),
    };
    handles.push(h);
    return h;
  });
  // Without `end`, as an older server answers (`session.buffer`).
  const resolveBuffer = (data: string, end?: number) => resolveSnapshot({ data, end });
  return { api, registry, handles, resolveBuffer };
}

describe('TerminalRegistry', () => {
  it('replays the scrollback before live output and forwards keystrokes', async () => {
    const { api, registry, handles, resolveBuffer } = setup();
    const container = document.createElement('div');
    registry.attach('s1', container);
    const term = handles[0]!;
    expect(term.open).toHaveBeenCalledWith(container.firstChild);
    expect(api.resize).toHaveBeenCalledWith('s1', 80, 24);

    registry.write('s1', 'early', 12); // already contained in the snapshot
    resolveBuffer('historyearly', 12);
    await Promise.resolve();
    await Promise.resolve();
    registry.write('s1', 'live', 16);
    expect(term.written).toEqual(['historyearly', 'live']);

    term.emit(' ');
    expect(api.input).toHaveBeenCalledWith('s1', ' ');
  });

  it('keeps live output that overtakes the snapshot on its way from a server', async () => {
    const { registry, handles, resolveBuffer } = setup();
    registry.attach('s1', document.createElement('div'));
    const term = handles[0]!;
    // The answer to the snapshot left the server before this output, but arrives after it.
    registry.write('s1', '$ echo hi', 9);
    registry.write('s1', '\r\nhi\r\n', 15);
    resolveBuffer('$ echo hi', 9);
    await Promise.resolve();
    await Promise.resolve();
    registry.write('s1', '$ ', 17);
    expect(term.written).toEqual(['$ echo hi', '\r\nhi\r\n', '$ ']);
  });

  it('drops early output when an older server sends no position', async () => {
    const { registry, handles, resolveBuffer } = setup();
    registry.attach('s1', document.createElement('div'));
    registry.write('s1', 'early');
    resolveBuffer('history early');
    await Promise.resolve();
    await Promise.resolve();
    registry.write('s1', 'live');
    expect(handles[0]!.written).toEqual(['history early', 'live']);
  });

  it('does not send the answers to queries in the replayed scrollback to the shell', async () => {
    const { api, registry, handles, resolveBuffer } = setup();
    registry.attach('s1', document.createElement('div'));
    const term = handles[0]!;
    term.hold = true;
    resolveBuffer('\x1b[c'); // a device attributes query from earlier output
    await Promise.resolve();
    await Promise.resolve();
    term.emit('\x1b[?1;2c'); // xterm answers while parsing the replay
    registry.write('s1', 'live'); // live output still shows meanwhile
    term.held?.();
    term.emit('x');
    expect(api.input.mock.calls).toEqual([['s1', 'x']]);
    expect(term.written).toEqual(['\x1b[c', 'live']);
  });

  it('forwards keystrokes typed before the scrollback has arrived', async () => {
    const { api, registry, handles, resolveBuffer } = setup();
    registry.attach('s1', document.createElement('div'));
    const term = handles[0]!;
    term.emit('l'); // the buffer request is still on its way, e.g. from a server
    expect(api.input.mock.calls).toEqual([['s1', 'l']]);
    resolveBuffer('history');
    await Promise.resolve();
    await Promise.resolve();
    term.emit('s');
    expect(api.input.mock.calls).toEqual([
      ['s1', 'l'],
      ['s1', 's'],
    ]);
  });

  it('shows briefly that the selection was copied', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { registry, handles } = setup();
    const container = document.createElement('div');
    registry.attach('s1', container);
    const host = container.firstChild as HTMLElement;
    const note = host.querySelector('[role="status"]')!;
    expect(note.textContent).toBe('');

    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    handles[0]!.selection = 'npm test';
    window.dispatchEvent(new MouseEvent('mouseup'));
    await vi.advanceTimersByTimeAsync(0);
    expect(note.textContent).toBe('In die Zwischenablage kopiert');
    await vi.advanceTimersByTimeAsync(1500);
    expect(note.textContent).toBe('');
    vi.useRealTimers();
  });

  it('copies the selection to the clipboard when the mouse is released', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { registry, handles } = setup();
    const container = document.createElement('div');
    document.body.appendChild(container);
    registry.attach('s1', container);
    const term = handles[0]!;
    const host = container.firstChild as HTMLElement;

    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    term.selection = 'npm test';
    window.dispatchEvent(new MouseEvent('mouseup')); // released outside the terminal
    expect(writeText).toHaveBeenCalledWith('npm test');

    // A click without selection and a release without a press in the terminal copy nothing.
    term.selection = '';
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    term.selection = 'other';
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(writeText).toHaveBeenCalledTimes(1);

    // Switched off for this session (ADR 0023): nothing goes to the clipboard.
    registry.setCopyOnSelect('s1', false);
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    term.selection = 'secret';
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(writeText).toHaveBeenCalledTimes(1);
    registry.setCopyOnSelect('s1', true);
    registry.setCopyOnSelect('unknown', false);

    // Right click keeps the clipboard; a disposed terminal copies nothing.
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    registry.dispose('s1');
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(writeText).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it('keeps terminals alive when switching and shows one terminal per field', () => {
    const { registry, handles } = setup();
    const a = document.createElement('div');
    const b = document.createElement('div');
    registry.attach('s1', a);
    registry.attach('s2', a);
    expect((a.children[0] as HTMLElement).hidden).toBe(true);
    expect((a.children[1] as HTMLElement).hidden).toBe(false);
    registry.attach('s1', b);
    expect(handles).toHaveLength(2);
    expect(b.children).toHaveLength(1);
    expect((b.firstChild as HTMLElement).hidden).toBe(false);
    // Another field keeps showing its own terminal.
    expect((a.firstChild as HTMLElement).hidden).toBe(false);
    expect(registry.has('s2')).toBe(true);
  });

  it('focuses a terminal only when asked, not when attaching', () => {
    const { registry, handles } = setup();
    registry.attach('s1', document.createElement('div'));
    expect(handles[0]!.focus).not.toHaveBeenCalled();
    registry.focus('s1');
    registry.focus('unknown');
    expect(handles[0]!.focus).toHaveBeenCalledTimes(1);
  });

  it('skips resize when the terminal cannot be measured', () => {
    const { api, registry, handles } = setup();
    registry.attach('s1', document.createElement('div'));
    api.resize.mockClear();
    vi.mocked(handles[0]!.fit).mockReturnValueOnce(undefined);
    registry.fit('s1');
    expect(api.resize).not.toHaveBeenCalled();
  });

  it('disposes terminals', () => {
    const { registry, handles } = setup();
    const c = document.createElement('div');
    registry.attach('s1', c);
    registry.dispose('s1');
    registry.dispose('unknown');
    registry.write('s1', 'x');
    expect(handles[0]!.dispose).toHaveBeenCalled();
    expect(c.children).toHaveLength(0);
    expect(registry.has('s1')).toBe(false);
  });
});
