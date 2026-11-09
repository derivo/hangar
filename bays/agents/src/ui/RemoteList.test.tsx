import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteList } from './RemoteList';
import { setLocale } from './messages';
import type { RemoteProject } from '../main/share';

afterEach(cleanup);

const anna = { workspace: 'team', instance: 'ab'.repeat(32), name: 'anna-mac' };
const projects: RemoteProject[] = [
  {
    ...anna,
    project: 'shop',
    sessions: [
      { branch: 'hangar/x', description: 'Login reparieren', status: 'waiting' },
      { branch: '', description: '', status: 'working' },
    ],
  },
  { ...anna, project: 'blog', sessions: [] },
];

describe('RemoteList (ADR 0030)', () => {
  it('shows nothing while no other instance shares anything', () => {
    setLocale('de');
    const { container } = render(<RemoteList projects={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists projects of other instances with origin, sessions, status and description', () => {
    setLocale('de');
    render(<RemoteList projects={projects} />);
    const region = screen.getByRole('region', { name: 'Andere Instanzen' });
    const shop = within(region).getByRole('listitem', { name: 'shop – anna-mac (team)' });
    expect(within(shop).getByText('Login reparieren')).toBeVisible();
    expect(within(shop).getByRole('img', { name: 'wartet auf Eingabe' })).toBeVisible();
    // Without description: the branch, or the project folder.
    expect(within(shop).getByText('Projektordner')).toBeVisible();
    expect(within(shop).getByRole('img', { name: 'arbeitet' })).toBeVisible();
    const blog = within(region).getByRole('listitem', { name: 'blog – anna-mac (team)' });
    expect(within(blog).getByText('Keine Sessions')).toBeVisible();
    // Nothing to click: what others share can only be read.
    expect(within(region).queryByRole('button')).toBeNull();
  });
});
