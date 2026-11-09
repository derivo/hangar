import { describe, expect, it } from 'vitest';
import { remoteProjects, sharedState } from './share';
import type { Project, SessionRecord } from './types';

const project = (id: string, shared?: boolean): Project => ({
  id,
  name: `app-${id}`,
  path: `/p/${id}`,
  ...(shared !== undefined && { shared }),
});
const session = (id: string, projectId: string, extra: Partial<SessionRecord> = {}) =>
  ({
    id,
    projectId,
    branch: `hangar/${id}`,
    description: '',
    status: 'idle',
    ...extra,
  }) as SessionRecord;

describe('sharedState', () => {
  it('holds only shared projects, with name, branch, description and status of their sessions', () => {
    expect(
      sharedState(
        [project('a', true), project('b'), project('c', false)],
        [
          session('s1', 'a', { description: 'Fix login', status: 'working' }),
          session('s2', 'b', { status: 'waiting' }),
          session('s3', 'a', { place: 'project', branch: '' }),
        ],
      ),
    ).toEqual({
      projects: [
        {
          name: 'app-a',
          sessions: [
            { branch: 'hangar/s1', description: 'Fix login', status: 'working' },
            { branch: '', description: '', status: 'idle' },
          ],
        },
      ],
    });
  });
});

describe('remoteProjects', () => {
  const from = { workspace: 'team', instance: 'f'.repeat(64), name: 'Anna' };

  it('lists the projects of other instances with their origin', () => {
    const state = sharedState(
      [project('a', true)],
      [session('s1', 'a', { description: 'Fix', status: 'waiting' })],
    );
    expect(remoteProjects([{ ...from, state }])).toEqual([
      {
        ...from,
        project: 'app-a',
        sessions: [{ branch: 'hangar/s1', description: 'Fix', status: 'waiting' }],
      },
    ]);
  });

  it('drops what does not fit and cuts long texts (the state is untrusted)', () => {
    const long = 'x'.repeat(500);
    expect(
      remoteProjects([
        { ...from, state: null },
        { ...from, state: { projects: 'no' } },
        {
          ...from,
          state: {
            projects: [
              null,
              { name: 5, sessions: [] },
              {
                name: long,
                sessions: [
                  { branch: 'b', description: 'd', status: 'exploding' },
                  { branch: 3, description: 'd', status: 'idle' },
                  { branch: 'b', description: long, status: 'done' },
                ],
              },
              { name: 'no-sessions', sessions: 'x' },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        ...from,
        project: 'x'.repeat(200),
        sessions: [{ branch: 'b', description: 'x'.repeat(200), status: 'done' }],
      },
      { ...from, project: 'no-sessions', sessions: [] },
    ]);
  });
});
