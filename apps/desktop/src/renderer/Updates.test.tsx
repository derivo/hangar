import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UpdateCheck } from './Updates';
import type { UpdateStatus } from '../shared';

function setup(first: UpdateStatus) {
  let push: (s: UpdateStatus) => void = () => {};
  const api = {
    getUpdate: vi.fn(async () => first),
    onUpdate: vi.fn((listener: (s: UpdateStatus) => void) => {
      push = listener;
      return () => {};
    }),
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
  };
  render(<UpdateCheck api={api} />);
  return { api, push: (s: UpdateStatus) => act(() => push(s)) };
}

describe('UpdateCheck', () => {
  it('checks on demand and shows each step of the updater', async () => {
    const { api, push } = setup({ state: 'idle' });
    const check = await screen.findByRole('button', { name: 'Nach Updates suchen' });
    await userEvent.click(check);
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    push({ state: 'checking' });
    expect(screen.getByText('Suche nach Updates …')).toBeVisible();
    expect(check).toBeDisabled();
    push({ state: 'current' });
    expect(screen.getByText('Hangar ist aktuell.')).toBeVisible();
    expect(check).toBeEnabled();
    push({ state: 'available', version: '1.0.0' });
    expect(screen.getByText('Update 1.0.0 ist verfügbar.')).toBeVisible();
    // The download starts right away; its first progress event can take a while.
    expect(check).toBeDisabled();
    push({ state: 'downloading', version: '1.0.0', percent: 41 });
    expect(screen.getByText('Update 1.0.0 wird geladen: 41 %')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Download' })).toHaveAttribute('value', '41');
    expect(check).toBeDisabled();
    push({ state: 'error', message: 'Could not get code signature' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Update fehlgeschlagen: Could not get code signature',
    );
  });

  it('installs a downloaded update on request, once per click burst', async () => {
    const { api } = setup({ state: 'ready', version: '1.0.0' });
    expect(await screen.findByText('Update 1.0.0 ist bereit.')).toBeVisible();
    // Installs on the next quit anyway; a new check could only lose it.
    expect(screen.getByRole('button', { name: 'Nach Updates suchen' })).toBeDisabled();
    const install = screen.getByRole('button', { name: 'Neu starten und installieren' });
    fireEvent.click(install, { detail: 1 });
    fireEvent.click(install, { detail: 2 });
    expect(api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('offers the release page when macOS cannot install the update itself', async () => {
    const { push } = setup({ state: 'ready', version: '0.9.0' });
    await screen.findByText('Update 0.9.0 ist bereit.');
    push({ state: 'manual', version: '0.9.0' });
    expect(
      screen.getByText(
        'Dieses Update lässt sich auf macOS nicht automatisch installieren, weil Hangar nicht signiert ist.',
      ),
    ).toBeVisible();
    const link = screen.getByRole('link', { name: 'Version 0.9.0 herunterladen' });
    expect(link).toHaveAttribute('href', 'https://github.com/derivo/hangar/releases/tag/v0.9.0');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('button', { name: 'Neu starten und installieren' })).toBeNull();
    // A later release may be signed: checking again stays possible.
    expect(screen.getByRole('button', { name: 'Nach Updates suchen' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says that updates exist only in the packaged app', async () => {
    setup({ state: 'unsupported' });
    expect(await screen.findByText('Updates gibt es nur in der installierten App.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Nach Updates suchen' })).toBeDisabled();
  });
});
