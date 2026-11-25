import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Overview } from './Overview';
import type { OverviewView } from '../shared';

const view: OverviewView = {
  version: '0.1.0',
  git: { installed: true, name: 'Ada Lovelace', email: 'ada@example.invalid' },
  bays: [{ id: 'dev.hangar.agents', name: 'Agents', version: '0.1.0' }],
  errors: [{ label: 'Kaputte Bay', error: 'id: must be in reverse-domain style' }],
};

const renderOverview = (data: OverviewView) =>
  render(<Overview api={{ getOverview: vi.fn(async () => data) }} />);

describe('Overview', () => {
  it('shows the Hangar version with the project page, git identity and the installed bays', async () => {
    renderOverview(view);
    expect(await screen.findByRole('heading', { name: 'Hangar-Übersicht' })).toBeVisible();
    const version = screen.getByRole('list', { name: 'Version' });
    expect(version).toHaveTextContent(/^Hangar0\.1\.0Projektseitegithub\.com\/derivo\/hangar$/);
    expect(within(version).getByRole('link', { name: 'github.com/derivo/hangar' })).toHaveAttribute(
      'href',
      'https://github.com/derivo/hangar',
    );
    const git = screen.getByRole('list', { name: 'Git' });
    expect(git).toHaveTextContent('NameAda Lovelace');
    expect(git).toHaveTextContent('E-Mailada@example.invalid');
    const row = screen.getByRole('row', { name: /Agents/ });
    expect(within(row).getByText('dev.hangar.agents')).toBeVisible();
    expect(within(row).getByText('0.1.0')).toBeVisible();
    expect(screen.getByText('Kaputte Bay: id: must be in reverse-domain style')).toBeVisible();
  });

  it('says what is missing in the git identity and how to set it', async () => {
    renderOverview({ ...view, git: { installed: true, name: 'Ada' } });
    const git = await screen.findByRole('list', { name: 'Git' });
    expect(git).toHaveTextContent('E-Mailnicht gesetzt');
    expect(screen.getByText('git config --global user.email "…"')).toBeVisible();
  });

  it('says when git is not installed', async () => {
    renderOverview({ ...view, git: { installed: false }, errors: [] });
    expect(await screen.findByText('Git ist nicht installiert oder nicht im PATH.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Nicht geladen' })).toBeNull();
  });
});
