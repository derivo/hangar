import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BrowserApi } from './api';
import type { TabView } from '../main/types';
import { t } from './messages';

interface Props {
  api: BrowserApi;
  tab: TabView;
  /** Changes when Cmd/Ctrl+F is pressed again: the field takes the focus back. */
  focusKey: number;
  onClose(): void;
}

/** Cmd (Ctrl elsewhere) without Ctrl (Cmd elsewhere), as the host checks it for the page. */
export const isModKey = (e: { metaKey: boolean; ctrlKey: boolean }) =>
  navigator.platform.startsWith('Mac') ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

/** Find in the page of a tab (ADR 0042); the host highlights, the result comes with the tab. */
export function FindBar({ api, tab, focusKey, onClose }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), [focusKey]);
  // Leaving (closed, another tab): the highlight goes. The tab may be closed already.
  useEffect(() => () => void api.stopFind(tab.id).catch(() => {}), [api, tab.id]);

  const change = (value: string) => {
    setText(value);
    // The tab may be gone meanwhile (closed by an agent).
    void (value ? api.find(tab.id, value) : api.stopFind(tab.id)).catch(() => {});
  };
  const step = (forward: boolean) => {
    if (text) void api.find(tab.id, text, { forward, next: true }).catch(() => {});
  };
  const keyDown = (e: KeyboardEvent) => {
    // Enter only in the field: on a button it is that button's click.
    const enter = e.key === 'Enter' && e.target === input.current;
    if (enter || (isModKey(e) && e.key.toLowerCase() === 'g')) {
      e.preventDefault();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') onClose();
  };

  const result =
    text && tab.find && (tab.find.matches ? `${tab.find.active}/${tab.find.matches}` : t.noMatches);
  return (
    // Keys on the whole bar: its buttons take Esc and Cmd/Ctrl+G too.
    <div className="findbar" onKeyDown={keyDown}>
      <input
        ref={input}
        className="address"
        type="search"
        aria-label={t.find}
        value={text}
        onChange={(e) => change(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <span role="status" className="muted">
        {result}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label={t.findPrevious}
        title={t.findPrevious}
        onClick={() => step(false)}
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t.findNext}
        title={t.findNext}
        onClick={() => step(true)}
      >
        ↓
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t.findClose}
        title={t.findClose}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
