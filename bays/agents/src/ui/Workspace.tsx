import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { StateView } from '../main/types';
import type { AgentsApi } from './api';
import { capacity, layout, type Grid, type Size } from './grid';
import { sessionName, t } from './messages';
import { SessionPane, type PaneRequest } from './SessionPane';
import type { TerminalRegistry } from './terminals';

/** Smallest terminal a field may get, in characters. */
export const MIN_COLUMNS = 60;
export const MIN_ROWS = 16;
// Header, statusbar, padding and borders around the terminal of a field, in CSS pixels
// (e2e/grid.spec.ts checks that a field of the minimum size holds 60 × 16 characters).
// 60 × 16 lets two fields share a 16" laptop screen side by side (ADR 0010).
// At the minimum width the header wraps to three rows (description, actions, telemetry).
const CHROME = { width: 60, height: 280 };
// Cell size when the font cannot be measured (tests).
const FALLBACK_CELL = { width: 8, height: 16 };

interface Props {
  state: StateView;
  grid: Grid;
  api: Pick<AgentsApi, 'update' | 'restart' | 'closeSession' | 'addJob' | 'secrets'>;
  terminals: Pick<TerminalRegistry, 'attach' | 'fit' | 'focus' | 'setCopyOnSelect'>;
  run(action: () => Promise<unknown>, key?: string): Promise<void>;
  onFocusField(index: number): void;
  onAddField(): void;
  onCloseField(index: number): void;
  /** Sessions in their own window: their field keeps the place and offers to bring them back. */
  undocked: string[];
  /** What the context menu asked the pane of that session to show. */
  request?: PaneRequest;
  onRequestDone?(): void;
  onUndock(id: string): void;
  onBringBack(id: string): void;
}

/** The terminals side by side: fields as large as possible, never below 60 × 16 characters. */
export function Workspace({ state, grid, api, terminals, run, ...props }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  const [min, setMin] = useState<Size>({ width: 1, height: 1 });
  const [gap, setGap] = useState(0);
  const fullId = useId();

  useLayoutEffect(() => {
    const el = gridRef.current!;
    const probe = probeRef.current!;
    // The probe changes size when the theme CSS (inserted at dom-ready) or the web font
    // arrives after the first render; measuring only once kept a fallback font's cell.
    const measure = () => {
      const box = probe.getBoundingClientRect();
      const cell = box.width > 0 ? box : FALLBACK_CELL;
      setMin({
        width: MIN_COLUMNS * cell.width + CHROME.width,
        height: MIN_ROWS * cell.height + CHROME.height,
      });
      setGap(parseFloat(getComputedStyle(el).columnGap) || 0);
      setArea({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(probe);
    return () => observer.disconnect();
  }, []);

  const count = grid.fields.length;
  // Each field brings one gap; the area has one gap fewer than fields.
  const slotArea = { width: area.width + gap, height: area.height + gap };
  const slot = { width: min.width + gap, height: min.height + gap };
  const { columns } = layout(count, slotArea, slot);
  const full = count >= capacity(slotArea, slot);
  const several = count > 1;

  return (
    <div className="workspace">
      <div className="workspace-bar">
        {/* Focusable while locked: the reason is its description, not a lasting line. */}
        <span id={fullId} hidden>
          {t.gridFull(MIN_COLUMNS, MIN_ROWS)}
        </span>
        <button
          type="button"
          className="button"
          aria-disabled={full}
          aria-describedby={full ? fullId : undefined}
          title={full ? t.gridFull(MIN_COLUMNS, MIN_ROWS) : undefined}
          // The further clicks of a double click (detail 2, 3 …) do not add more fields.
          onClick={(e) => !full && e.detail <= 1 && props.onAddField()}
        >
          {t.addField}
        </button>
      </div>
      <div
        ref={gridRef}
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(${min.width}px, 1fr))`,
          gridAutoRows: `minmax(${min.height}px, 1fr)`,
        }}
      >
        {grid.fields.map((id, index) => {
          const session = state.sessions.find((s) => s.id === id);
          const focused = index === grid.focus;
          const close = several && (
            <button type="button" className="button" onClick={() => props.onCloseField(index)}>
              {t.closeField}
            </button>
          );
          return (
            <div
              key={id ?? `empty-${index}`}
              role="group"
              aria-label={t.field(index + 1)}
              className="field"
              data-focused={several && focused ? '' : undefined}
              onFocusCapture={() => !focused && props.onFocusField(index)}
              onPointerDown={() => !focused && props.onFocusField(index)}
            >
              {session && props.undocked.includes(session.id) ? (
                <div className="placeholder field-empty">
                  <p className="muted">{t.undocked(sessionName(session))}</p>
                  <div className="field-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() => props.onBringBack(session.id)}
                    >
                      {t.bringBack}
                    </button>
                    {close}
                  </div>
                </div>
              ) : session ? (
                <SessionPane
                  session={session}
                  projectName={state.projects.find((p) => p.id === session.projectId)?.name ?? ''}
                  active={focused}
                  api={api}
                  terminals={terminals}
                  run={run}
                  request={props.request?.id === session.id ? props.request : undefined}
                  onRequestDone={props.onRequestDone}
                  windowAction={
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t.undock}
                      title={t.undock}
                      onClick={() => props.onUndock(session.id)}
                    >
                      ↗
                    </button>
                  }
                  fieldActions={close}
                />
              ) : (
                <div className="placeholder field-empty">
                  <p className="muted">
                    {state.projects.length === 0 ? t.hintNoProject : t.hintSelect}
                  </p>
                  {close}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <span ref={probeRef} className="cell-probe" aria-hidden="true" />
    </div>
  );
}
