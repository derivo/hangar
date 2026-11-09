import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobView } from '@hangar/scheduler';
import { t } from '../messages';
import type { JobsView, ShellApi } from '../shared';

interface Props {
  api: Pick<ShellApi, 'getJobs' | 'setJobPaused' | 'runJob' | 'removeJob' | 'onJobs'>;
}

const when = (ms: number) => t.when(new Date(ms).toISOString());

function nextRun(job: JobView): string {
  if (!job.available) return t.bayNotLoaded;
  if (job.running) return t.jobRunning;
  if (job.paused) return t.jobPaused;
  return job.nextRun === undefined ? t.never : when(job.nextRun);
}

interface Group {
  key: string;
  title: string;
  jobs: JobView[];
  error?: string;
  server?: string;
}

/** Jobs of all bays (ADR 0013): state, runs, pause, run now, delete. */
export function Jobs({ api }: Props) {
  const [view, setView] = useState<JobsView>();
  const [error, setError] = useState('');
  // Only the newest load counts: an older one may answer last (a slow server).
  const loads = useRef(0);
  const load = useCallback(() => {
    const n = ++loads.current;
    void api.getJobs().then((v) => n === loads.current && setView(v));
  }, [api]);
  useEffect(() => {
    load();
    return api.onJobs(load);
  }, [api, load]);
  const pending = useRef(new Set<string>());

  if (!view) return null;
  const nameOf = (bayId: string) => view.bays.find((b) => b.id === bayId)?.name ?? bayId;
  // One run of each action per job: pressing it again before the answer does nothing.
  const act = (key: string, action: () => Promise<void>) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setError('');
    void action()
      .catch((e: Error) =>
        setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
      )
      .finally(() => {
        pending.current.delete(key);
        load();
      });
  };

  const table = (label: string, jobs: JobView[], server?: string) => {
    // Jobs here keep their one-argument calls; server jobs name their server.
    const at = server === undefined ? [] : [server];
    return (
      <div className="table-scroll">
        <table className="permission-table" aria-label={label}>
          <thead>
            <tr>
              <th scope="col">{t.job}</th>
              <th scope="col">{t.schedule}</th>
              <th scope="col">{t.nextRun}</th>
              <th scope="col">{t.lastRun}</th>
              <th scope="col">{t.result}</th>
              <td />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <th scope="row">
                  <code>{job.label}</code>
                  <span className="muted permission-description">{nameOf(job.bayId)}</span>
                </th>
                <td>
                  <code>{job.schedule}</code>
                </td>
                <td>{nextRun(job)}</td>
                <td>{job.lastRun ? when(job.lastRun.at) : t.notRunYet}</td>
                <td>
                  {job.lastRun &&
                    t.runResult(job.lastRun.ok, job.lastRun.durationMs, job.lastRun.output)}
                </td>
                <td>
                  <div className="job-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        act(`setJobPaused:${server ?? ''}:${job.id}`, () =>
                          api.setJobPaused(job.id, !job.paused, ...at),
                        )
                      }
                    >
                      {job.paused ? t.resume : t.pause}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={!job.available || job.running}
                      // The further clicks of a double click (detail 2, 3 …) do not run it again.
                      onClick={(e) =>
                        e.detail <= 1 &&
                        act(`runJob:${server ?? ''}:${job.id}`, () => api.runJob(job.id, ...at))
                      }
                    >
                      {t.runNow}
                    </button>
                    <button
                      type="button"
                      className="button"
                      // The further clicks of a double click (detail 2, 3 …) would delete again.
                      onClick={(e) =>
                        e.detail <= 1 &&
                        act(`removeJob:${server ?? ''}:${job.id}`, () =>
                          api.removeJob(job.id, ...at),
                        )
                      }
                    >
                      {t.deleteJob}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // With servers: one group per machine (phase 11d).
  const groups: Group[] = [
    { key: '', title: t.jobsHere, jobs: view.jobs },
    ...view.servers.map((s) => ({
      key: s.id,
      title: t.jobsOnServer(s.name),
      jobs: s.jobs,
      ...(s.error && { error: s.error }),
      server: s.id,
    })),
  ];

  return (
    <>
      <h2>{t.jobs}</h2>
      <p className="muted">{t.jobsHint}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view.servers.length === 0 ? (
        view.jobs.length === 0 ? (
          <p className="muted">{t.jobsEmpty}</p>
        ) : (
          table(t.jobs, view.jobs)
        )
      ) : (
        groups.map((group) => (
          <section key={group.key} aria-label={group.title}>
            <h3>{group.title}</h3>
            {group.error ? (
              <p className="error" role="alert">
                {group.error}
              </p>
            ) : group.jobs.length === 0 ? (
              <p className="muted">{t.noJobs}</p>
            ) : (
              table(group.title, group.jobs, group.server)
            )}
          </section>
        ))
      )}
    </>
  );
}
