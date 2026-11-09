import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Workspace } from './Workspace';

/** Observed elements and their callbacks, so a test can report a size change. */
const observed = new Map<Element, () => void>();
let cell = { width: 20, height: 18.5 };

beforeEach(() => {
  observed.clear();
  cell = { width: 20, height: 18.5 };
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe(el: Element) {
      observed.set(el, this.callback);
    }
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...cell, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect,
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
});

afterEach(() => vi.restoreAllMocks());

const noop = () => {};

describe('Workspace', () => {
  it('measures the terminal cell again once the font changes', () => {
    render(
      <Workspace
        state={{ projects: [], sessions: [] } as never}
        grid={{ fields: [null], focus: 0 }}
        api={{} as never}
        terminals={{} as never}
        run={async () => {}}
        onFocusField={noop}
        onAddField={noop}
        onCloseField={noop}
        undocked={[]}
        onUndock={noop}
        onBringBack={noop}
      />,
    );
    // Measured with a fallback font before the theme was applied: 60 columns do not fit twice.
    const add = screen.getByRole('button', { name: 'Feld hinzufügen' });
    expect(add).toHaveAttribute('aria-disabled', 'true');

    cell = { width: 7.8, height: 17 };
    const probe = document.querySelector('.cell-probe')!;
    act(() => observed.get(probe)!());
    expect(add).toHaveAttribute('aria-disabled', 'false');
  });

  it('adds one field for a double click', async () => {
    cell = { width: 7.8, height: 17 };
    const onAddField = vi.fn();
    render(
      <Workspace
        state={{ projects: [], sessions: [] } as never}
        grid={{ fields: [null], focus: 0 }}
        api={{} as never}
        terminals={{} as never}
        run={async () => {}}
        onFocusField={noop}
        onAddField={onAddField}
        onCloseField={noop}
        undocked={[]}
        onUndock={noop}
        onBringBack={noop}
      />,
    );
    await userEvent.dblClick(screen.getByRole('button', { name: 'Feld hinzufügen' }));
    expect(onAddField).toHaveBeenCalledTimes(1);
  });
});
