import type { AgentsApi } from './api';
import { t } from './messages';

/** The part of an xterm.js terminal the registry needs (faked in tests). */
export interface TerminalHandle {
  open(element: HTMLElement): void;
  /** `done` runs once xterm has parsed the data. */
  write(data: string, done?: () => void): void;
  onData(listener: (data: string) => void): void;
  /** Fits to the container; returns the new size. */
  fit(): { cols: number; rows: number } | undefined;
  focus(): void;
  /** Selected text; empty without a selection. */
  getSelection(): string;
  dispose(): void;
}

/**
 * What xterm answers to a query: device attributes and status (`c`, `n`, `R`), window reports
 * (`t`), modes (`$y`), colors (OSC `rgb:`) and settings (DECRQSS). ponytail: F3 with a modifier
 * (`ESC[1;2R` …) looks like a cursor report and is dropped while a scrollback is replayed.
 */
const ANSWER =
  // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
  /^\x1b(\[[?>]?[\d;]*[cnRt]|\[\??[\d;]*\$y|\][\d;]*rgb:[^\x07\x1b]*(\x07|\x1b\\)|P[01]\$r[^\x1b]*\x1b\\)$/;

interface Entry {
  handle: TerminalHandle;
  element: HTMLDivElement;
  ready: boolean;
  /** Live output that arrived before the snapshot; what is newer than it is written after it. */
  early: { data: string; end?: number }[];
  /** The scrollback is being parsed; answers to queries meanwhile are not keystrokes. */
  replaying: boolean;
  /** Selecting copies to the clipboard (per session, ADR 0023). */
  copy: boolean;
}

/**
 * Keeps one terminal per session alive while the user switches between sessions or moves
 * one to another field of the grid, so nothing is re-rendered from scratch. A new terminal first replays the session's
 * scrollback; live output that arrived before it is kept only if it is newer than the snapshot.
 */
export class TerminalRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly api: Pick<AgentsApi, 'input' | 'resize' | 'snapshot'>,
    private readonly create: () => TerminalHandle,
  ) {}

  attach(id: string, container: HTMLElement): void {
    let entry = this.entries.get(id);
    if (!entry) {
      const element = document.createElement('div');
      element.className = 'terminal-host';
      const handle = this.create();
      entry = { handle, element, ready: false, early: [], replaying: false, copy: true };
      this.entries.set(id, entry);
      container.appendChild(element);
      handle.open(element);
      const created = entry;
      // Replaying old queries (e.g. ESC[c) makes xterm answer again; the shell would print it.
      // Keys and pastes typed meanwhile go through.
      handle.onData(
        (data) => (!created.replaying || !ANSWER.test(data)) && void this.api.input(id, data),
      );
      // Copy on select: a selection made with the left button goes to the clipboard on
      // release, even outside the terminal. Capture runs before xterm.
      const note = document.createElement('div');
      note.className = 'copy-note';
      note.setAttribute('role', 'status');
      element.appendChild(note);
      let hide: ReturnType<typeof setTimeout> | undefined;
      const copied = () => {
        note.textContent = t.copied;
        clearTimeout(hide);
        hide = setTimeout(() => (note.textContent = ''), 1200);
      };
      const copy = () => {
        const current = this.entries.get(id);
        const text = current?.handle === handle && current.copy ? handle.getSelection() : '';
        if (text) void navigator.clipboard.writeText(text).then(copied);
      };
      element.addEventListener(
        'mousedown',
        (e) => e.button === 0 && window.addEventListener('mouseup', copy, { once: true }),
        { capture: true },
      );
      void this.api.snapshot(id).then(({ data, end }) => {
        created.replaying = true;
        handle.write(data, () => (created.replaying = false));
        // Without `end` (older server) the snapshot contains the early output, as before.
        if (end !== undefined) {
          for (const e of created.early)
            if (e.end !== undefined && e.end > end) handle.write(e.data);
        }
        created.early = [];
        created.ready = true;
      });
    } else if (entry.element.parentElement !== container) {
      container.appendChild(entry.element);
    }
    // A field shows one terminal; terminals in other fields stay visible.
    for (const [other, e] of this.entries) {
      if (e.element.parentElement === container) e.element.hidden = other !== id;
    }
    this.fit(id);
  }

  setCopyOnSelect(id: string, on: boolean): void {
    const entry = this.entries.get(id);
    if (entry) entry.copy = on;
  }

  focus(id: string): void {
    this.entries.get(id)?.handle.focus();
  }

  fit(id: string): void {
    const size = this.entries.get(id)?.handle.fit();
    if (size) void this.api.resize(id, size.cols, size.rows);
  }

  write(id: string, data: string, end?: number): void {
    const entry = this.entries.get(id);
    if (entry?.ready) entry.handle.write(data);
    else entry?.early.push({ data, end });
  }

  dispose(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.handle.dispose();
    entry.element.remove();
    this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }
}
