import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Quotas } from '../main/types';
import { QuotaBar } from './QuotaBar';

const NOW = new Date(2026, 9, 30, 18, 0).getTime();
const at = (hours: number, minutes: number) =>
  new Date(2026, 9, 30, hours, minutes).getTime() / 1000;

function renderBar(initial: Quotas) {
  let push: (q: Quotas) => void = () => {};
  const api = {
    quota: vi.fn(async () => initial),
    onQuota: vi.fn((l: (q: Quotas) => void) => {
      push = l;
      return () => {};
    }),
  };
  render(<QuotaBar api={api} now={() => NOW} />);
  return { push: (q: Quotas) => act(() => push(q)) };
}

describe('QuotaBar (ADR 0024)', () => {
  it('shows what is left of the 5-hour limit and when it resets, per provider', async () => {
    renderBar({
      claude: { usedPercent: 6, resetsAt: at(20, 40) },
      codex: { usedPercent: 9.4, resetsAt: at(22, 7) },
    });
    const bar = await screen.findByRole('group', { name: 'Kontingente' });
    const claude = within(bar).getByRole('meter', { name: 'Claude 5h' });
    expect(claude).toHaveAttribute('aria-valuenow', '94');
    expect(claude).toHaveAttribute('aria-valuetext', '94 % frei, Reset 20:40');
    expect(bar).toHaveTextContent('Claude5h94 % freiReset 20:40');
    expect(within(bar).getByRole('meter', { name: 'Codex 5h' })).toHaveAttribute(
      'aria-valuenow',
      '91',
    );
    expect(bar).toHaveTextContent('Reset 22:07');
  });

  it('shows the weekly limit after the 5-hour limit: share free and reset with date', async () => {
    renderBar({
      claude: {
        usedPercent: 6,
        resetsAt: at(20, 40),
        week: { usedPercent: 15, resetsAt: new Date(2026, 10, 3, 9, 0).getTime() / 1000 },
      },
      codex: { usedPercent: 9, week: { usedPercent: 40, resetsAt: at(17, 0) } },
    });
    const bar = await screen.findByRole('group', { name: 'Kontingente' });
    const week = within(bar).getByRole('meter', { name: 'Claude 7d' });
    expect(week).toHaveAttribute('aria-valuenow', '85');
    expect(week).toHaveAttribute('aria-valuetext', '85 % frei, Reset 03.11. 09:00');
    expect(bar).toHaveTextContent('Reset 20:407d85 %Reset 03.11. 09:00');
    // A passed weekly reset counts as free, without a reset.
    expect(within(bar).getByRole('meter', { name: 'Codex 7d' })).toHaveAttribute(
      'aria-valuetext',
      '100 % frei',
    );
  });

  it('counts a window whose reset has passed as free and follows updates', async () => {
    const { push } = renderBar({ codex: { usedPercent: 80, resetsAt: at(17, 0) } });
    const codex = await screen.findByRole('meter', { name: 'Codex 5h' });
    expect(codex).toHaveAttribute('aria-valuenow', '100');
    expect(codex).toHaveAttribute('aria-valuetext', '100 % frei');
    expect(screen.queryByRole('meter', { name: 'Claude 5h' })).toBeNull();

    push({ codex: { usedPercent: 80, resetsAt: at(19, 0) }, claude: { usedPercent: 50 } });
    expect(screen.getByRole('meter', { name: 'Codex 5h' })).toHaveAttribute('aria-valuenow', '20');
    expect(screen.getByRole('meter', { name: 'Claude 5h' })).toHaveAttribute(
      'aria-valuetext',
      '50 % frei',
    );
  });

  it('shows a passed reset without waiting for new values', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = NOW;
    let push: (q: Quotas) => void = () => {};
    const api = {
      quota: vi.fn(async () => ({ codex: { usedPercent: 80, resetsAt: at(18, 1) } })),
      onQuota: vi.fn((l: (q: Quotas) => void) => ((push = l), () => {})),
    };
    render(<QuotaBar api={api} now={() => now} />);
    const codex = await screen.findByRole('meter', { name: 'Codex 5h' });
    expect(codex).toHaveAttribute('aria-valuenow', '20');
    now += 2 * 60_000;
    act(() => void vi.advanceTimersByTime(60_000));
    expect(codex).toHaveAttribute('aria-valuenow', '100');
    expect(push).toBeDefined();
    vi.useRealTimers();
  });

  it('is not there without any value', async () => {
    renderBar({});
    await act(async () => {});
    expect(screen.queryByRole('group', { name: 'Kontingente' })).toBeNull();
  });
});
