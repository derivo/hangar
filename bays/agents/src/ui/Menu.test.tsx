import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuEntry } from './Menu';

afterEach(cleanup);

function renderMenu() {
  const onClose = vi.fn();
  const select = { a: vi.fn(), b: vi.fn(), red: vi.fn(), none: vi.fn(), c: vi.fn() };
  const entries: MenuEntry[] = [
    { kind: 'item', label: 'Alpha', onSelect: select.a },
    { kind: 'item', label: 'Beta', onSelect: select.b, disabled: true },
    {
      kind: 'swatches',
      label: 'Farbe',
      options: [
        { label: 'Keine', checked: false, onSelect: select.none },
        { label: 'Rot', color: 'var(--red)', checked: true, onSelect: select.red },
      ],
    },
    { kind: 'separator' },
    { kind: 'item', label: 'Gamma', onSelect: select.c, danger: true },
  ];
  render(
    <>
      <button type="button">draußen</button>
      <Menu label="Session Login" at={{ x: 10, y: 20 }} entries={entries} onClose={onClose} />
    </>,
  );
  return { onClose, select };
}

describe('Menu', () => {
  it('shows its entries as a menu at the given point and focuses the first', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: 'Session Login' });
    expect(menu).toHaveStyle({ left: '10px', top: '20px' });
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('group', { name: 'Farbe' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Rot' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Keine' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('moves with the arrow keys, Home and End, around both ends', async () => {
    renderMenu();
    const user = userEvent.setup();
    const focused = () => document.activeElement?.getAttribute('aria-label') ?? '';
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Beta' }));
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Keine');
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Rot');
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toBe('Keine');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Gamma' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Gamma' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
  });

  it('runs an entry by Enter, Space or click and closes first', async () => {
    const { onClose, select } = renderMenu();
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(select.a).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(select.a.mock.invocationCallOrder[0]!);
    await user.keyboard('{End}{ }');
    expect(select.c).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('menuitemradio', { name: 'Rot' }));
    expect(select.red).toHaveBeenCalledTimes(1);
  });

  it('runs no disabled entry', async () => {
    const { onClose, select } = renderMenu();
    const user = userEvent.setup();
    await user.click(screen.getByRole('menuitem', { name: 'Beta' }));
    await user.keyboard('{Enter}');
    expect(select.b).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape, Tab, a press outside and when the window loses focus', async () => {
    const { onClose } = renderMenu();
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    await user.keyboard('{Tab}');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'draußen' }));
    fireEvent.blur(window);
    expect(onClose).toHaveBeenCalledTimes(4);
    // A press inside the menu keeps it open.
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Alpha' }));
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});
