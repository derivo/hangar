import { useCallback, useEffect, useRef, useState } from 'react';
import type { Grant, GrantMode } from '@hangar/bus';
import { t } from '../messages';
import type { PermissionsView, ShellApi } from '../shared';

interface Props {
  api: Pick<ShellApi, 'getPermissions' | 'revoke' | 'setGrant'>;
}

/** Modes the settings may set (ADR 0006): `ask` only for sensitive functions. */
const modesFor = (sensitive: boolean): GrantMode[] =>
  sensitive ? ['allow', 'ask', 'deny'] : ['allow', 'deny'];

/** Permissions grouped by caller: change, revoke, or set a rule before the first access. */
export function Permissions({ api }: Props) {
  const [view, setView] = useState<PermissionsView>();
  const [error, setError] = useState('');
  // Only the newest load counts: an older one may answer last.
  const loads = useRef(0);
  const load = useCallback(() => {
    const n = ++loads.current;
    void api.getPermissions().then((v) => n === loads.current && setView(v));
  }, [api]);
  useEffect(load, [load]);
  // One run of each action per rule: pressing it again before the answer does nothing.
  const pending = useRef(new Set<string>());
  const [caller, setCaller] = useState('');
  const [search, setSearch] = useState('');

  if (!view) return null;
  const nameOf = (bayId: string) => view.bays.find((b) => b.id === bayId)?.name ?? bayId;
  const fn = (id: string) => view.functions.find((f) => f.id === id);
  const grants = view.grants.filter(
    (g) =>
      (!caller || g.subject === caller) && g.target.toLowerCase().includes(search.toLowerCase()),
  );
  const subjects = [...new Set(grants.map((g) => g.subject))].sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b)),
  );
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
  const set = (subject: string, target: string, mode: GrantMode) =>
    act(`set|${subject}|${target}`, () => api.setGrant(subject, target, mode));
  const revoke = (g: Grant) =>
    act(`revoke|${g.subject}|${g.target}|${g.sessionId ?? ''}`, () => api.revoke(g));

  return (
    <>
      <h2>{t.permissions}</h2>
      <p className="muted">{t.permissionsHint}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="permission-filters">
        <label className="field">
          {t.showCaller}
          <select value={caller} onChange={(e) => setCaller(e.target.value)}>
            <option value="">{t.allCallers}</option>
            {view.bays.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t.searchFunction}
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      {view.grants.length === 0 && <p className="muted">{t.permissionsEmpty}</p>}
      {subjects.map((subject) => (
        <div key={subject} className="permission-group">
          <h3>
            {nameOf(subject)} <code>{subject}</code>
          </h3>
          <div className="table-scroll">
            <table className="permission-table" aria-label={nameOf(subject)}>
              <thead>
                <tr>
                  <th scope="col">{t.functionColumn}</th>
                  <th scope="col">{t.modeColumn}</th>
                  <th scope="col">{t.grantedAt}</th>
                  <th scope="col">{t.lastUsed}</th>
                  <td />
                </tr>
              </thead>
              <tbody>
                {grants
                  .filter((g) => g.subject === subject)
                  .map((g) => {
                    const spec = fn(g.target);
                    return (
                      <tr key={`${g.target}-${g.sessionId ?? ''}`}>
                        <th scope="row">
                          <code>{g.target}</code>
                          {spec?.sensitive && <span className="tag">{t.sensitive}</span>}
                          {spec?.description && (
                            <span className="muted permission-description">{spec.description}</span>
                          )}
                        </th>
                        <td>
                          {g.mode === 'session' ? (
                            t.sessionOnly(g.sessionLabel ?? g.sessionId!.slice(0, 8))
                          ) : (
                            <select
                              aria-label={t.modeColumn}
                              value={g.mode}
                              onChange={(e) =>
                                set(g.subject, g.target, e.target.value as GrantMode)
                              }
                            >
                              {modesFor(spec?.sensitive ?? false).map((m) => (
                                <option key={m} value={m}>
                                  {t.modes[m]}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td>{g.grantedAt ? t.when(g.grantedAt) : t.unknownTime}</td>
                        <td>{g.lastUsed ? t.when(g.lastUsed) : t.notUsed}</td>
                        <td>
                          <button type="button" className="button" onClick={() => revoke(g)}>
                            {t.revoke}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <RuleForm view={view} onSet={set} />
    </>
  );
}

function RuleForm({
  view,
  onSet,
}: {
  view: PermissionsView;
  onSet(subject: string, target: string, mode: GrantMode): void;
}) {
  const [subject, setSubject] = useState(view.bays[0]?.id ?? '');
  const [picked, setTarget] = useState(view.functions[0]?.id ?? '');
  const [mode, setMode] = useState<GrantMode>('allow');
  // A bay may always use its own non-sensitive functions (ADR 0006): no rule to set.
  const functions = view.functions.filter((f) => f.bayId !== subject || f.sensitive);
  const target = functions.some((f) => f.id === picked) ? picked : (functions[0]?.id ?? '');
  const sensitive = functions.find((f) => f.id === target)?.sensitive ?? false;
  const modes = modesFor(sensitive);
  const chosen = modes.includes(mode) ? mode : 'allow';
  if (view.functions.length === 0) return null;

  return (
    <fieldset className="permission-rule">
      <legend>{t.ruleTitle}</legend>
      <label className="field">
        {t.caller}
        <select value={subject} onChange={(e) => setSubject(e.target.value)}>
          {view.bays.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t.functionColumn}
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {functions.map((f) => (
            <option key={f.id} value={f.id}>
              {f.id}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t.modeColumn}
        <select value={chosen} onChange={(e) => setMode(e.target.value as GrantMode)}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {t.modes[m]}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="button" onClick={() => onSet(subject, target, chosen)}>
        {t.setRule}
      </button>
    </fieldset>
  );
}
