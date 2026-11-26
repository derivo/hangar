import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BaySwitches } from './BaySwitches';
import type { ShellState } from '../shared';

const bay = (id: string, name: string) => ({ id, name, icon: 'data:image/svg+xml;base64,' });

const state = (on: string[][], off: string[][]): ShellState => ({
  bays: on.map(([id, name]) => ({ ...bay(id!, name!), badge: 0 })),
  servers: [],
  errors: [],
  shortcuts: [],
  selected: 'settings',
  available: off.map(([id, name]) => bay(id!, name!)),
});

const setup = (first: ShellState) => {
  let push: (s: ShellState) => void = () => {};
  const api = {
    getState: vi.fn(async () => first),
    onState: vi.fn((listener: (s: ShellState) => void) => {
      push = listener;
      return () => {};
    }),
    setBayInSidebar: vi.fn(async () => {}),
  };
  render(<BaySwitches api={api} />);
  return { api, push: (s: ShellState) => act(() => push(s)) };
};

describe('BaySwitches', () => {
  it('lists every found bay by name with a switch that says whether it is in the sidebar', async () => {
    // Sorted by name, so a row does not move when it is switched.
    setup(
      state(
        [
          ['dev.hangar.board', 'Board'],
          ['dev.hangar.agents', 'Agents'],
        ],
        [['dev.hangar.browser', 'Browser']],
      ),
    );
    expect(await screen.findByRole('heading', { name: 'In der Leiste', level: 3 })).toBeVisible();
    const switches = await screen.findAllByRole('switch');
    expect(switches.map((s) => s.textContent)).toEqual(['Agents', 'Board', 'Browser']);
    expect(screen.getByRole('switch', { name: 'Agents' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Browser' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('puts a bay into the sidebar and takes it out; the state follows the sidebar', async () => {
    const { api, push } = setup(
      state([['dev.hangar.agents', 'Agents']], [['dev.hangar.browser', 'Browser']]),
    );
    await userEvent.click(await screen.findByRole('switch', { name: 'Browser' }));
    expect(api.setBayInSidebar).toHaveBeenCalledWith('dev.hangar.browser', true);
    await userEvent.click(screen.getByRole('switch', { name: 'Agents' }));
    expect(api.setBayInSidebar).toHaveBeenCalledWith('dev.hangar.agents', false);
    // Removed elsewhere (right click): the switch follows.
    push(
      state(
        [],
        [
          ['dev.hangar.agents', 'Agents'],
          ['dev.hangar.browser', 'Browser'],
        ],
      ),
    );
    expect(screen.getByRole('switch', { name: 'Agents' })).toHaveAttribute('aria-checked', 'false');
  });

  it('works with the keyboard: Space and Enter', async () => {
    const { api } = setup(state([], [['dev.hangar.browser', 'Browser']]));
    (await screen.findByRole('switch', { name: 'Browser' })).focus();
    await userEvent.keyboard(' ');
    expect(api.setBayInSidebar).toHaveBeenLastCalledWith('dev.hangar.browser', true);
    await userEvent.keyboard('{Enter}');
    expect(api.setBayInSidebar).toHaveBeenCalledTimes(2);
  });

  it('switches a bay once until the answer and shows a failed start', async () => {
    const { api } = setup(state([], [['dev.hangar.browser', 'Browser']]));
    let fail: (e: Error) => void = () => {};
    api.setBayInSidebar.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject)) as Promise<void>,
    );
    const sw = await screen.findByRole('switch', { name: 'Browser' });
    await userEvent.click(sw);
    await userEvent.click(sw);
    expect(api.setBayInSidebar).toHaveBeenCalledTimes(1);
    await act(async () =>
      fail(
        new Error("Error invoking remote method 'shell:bayInSidebar': Error: Start failed: boom"),
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Start failed: boom');
  });
});
