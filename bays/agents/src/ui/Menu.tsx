import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';

export type MenuEntry =
  | { kind: 'item'; label: string; onSelect(): void; disabled?: boolean; danger?: boolean }
  | { kind: 'separator' }
  /** A row of choices, one checked (menuitemradio); `color` paints the swatch. */
  | {
      kind: 'swatches';
      label: string;
      options: { label: string; color?: string; checked: boolean; onSelect(): void }[];
    };

interface Props {
  label: string;
  /** Viewport point of the right click; the menu stays inside the window. */
  at: { x: number; y: number };
  entries: MenuEntry[];
  onClose(): void;
}

/** A context menu (WAI-ARIA menu): arrows, Home/End, Enter/Space; Escape, Tab or outside close it. */
export function Menu({ label, at, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => [
    ...ref.current!.querySelectorAll<HTMLElement>('[role=menuitem],[role=menuitemradio]'),
  ];
  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - width))}px`;
    el.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - height))}px`;
    items()[0]?.focus();
  }, [at]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current!.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const choose = (select: () => void, disabled?: boolean) => {
    if (disabled) return;
    // Close first: the trigger gets the focus back, an action may then move it on.
    onClose();
    select();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const step: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowRight: at + 1,
      ArrowUp: at - 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: all.length - 1,
    };
    if (e.key in step) {
      e.preventDefault();
      all[(step[e.key]! + all.length) % all.length]!.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      // The focus goes back to the trigger first, so Tab moves on from there (APG).
      onClose();
    }
  };
  const activate = (e: KeyboardEvent, select: () => void, disabled?: boolean) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    choose(select, disabled);
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="menu chamfer"
      style={{ left: at.x, top: at.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') return <div key={i} role="separator" />;
        if (entry.kind === 'swatches')
          return (
            <div key={i} role="group" aria-label={entry.label} className="menu-swatches">
              {entry.options.map((o) => (
                <div
                  key={o.label}
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={o.checked}
                  aria-label={o.label}
                  title={o.label}
                  className="menu-swatch"
                  style={o.color ? { background: o.color } : undefined}
                  onClick={() => choose(o.onSelect)}
                  onKeyDown={(e) => activate(e, o.onSelect)}
                />
              ))}
            </div>
          );
        return (
          <div
            key={i}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={entry.disabled || undefined}
            className={entry.danger ? 'menu-item menu-danger' : 'menu-item'}
            onClick={() => choose(entry.onSelect, entry.disabled)}
            onKeyDown={(e) => activate(e, entry.onSelect, entry.disabled)}
          >
            {entry.label}
          </div>
        );
      })}
    </div>
  );
}
