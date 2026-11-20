import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { t } from '../messages';
import type {
  ShellApi,
  WorkspaceActivity,
  WorkspaceInvite,
  WorkspacesSettingsView,
} from '../shared';

type Api = Pick<
  ShellApi,
  | 'getWorkspaces'
  | 'connectRelay'
  | 'createWorkspace'
  | 'inviteToWorkspace'
  | 'joinWorkspace'
  | 'acceptMember'
  | 'rejectMember'
  | 'removeMember'
  | 'setWorkspaceShare'
  | 'setWorkspaceTrust'
  | 'getWorkspaceActivity'
  | 'acceptInbox'
  | 'rejectInbox'
  | 'onWorkspaces'
>;

/** Same rule as the relay (`apps/relay/src/relay.ts`). */
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function shownError(message: string): string {
  message = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (message === 'Invalid relay address') return t.relayInvalid;
  if (message === 'Invalid workspace name') return t.workspaceNameInvalid;
  if (message.startsWith('No open inbox entry')) return t.inboxGone;
  if (message.startsWith('Access denied')) return t.inboxDenied;
  return t.relayErrors[message] ?? message;
}

/** One run of an action at a time (ADR 0028); a failed check or answer becomes `error`. */
function useAction() {
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const run = (check: string | undefined, action: () => Promise<void>) => {
    if (busy.current) return;
    setError(check);
    if (check) return;
    busy.current = true;
    void action()
      .catch((e: Error) => setError(shownError(e.message)))
      .finally(() => (busy.current = false));
  };
  return [error, run] as const;
}

const Alert = ({ error }: { error?: string }) =>
  error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;

/** The second click of a double click submits nothing (ADR 0028). */
const Submit = ({ label }: { label: string }) => (
  <button type="submit" className="button" onClick={(e) => e.detail > 1 && e.preventDefault()}>
    {label}
  </button>
);

/** Relay, this instance and its workspaces (ADR 0030). */
export function Workspaces({ api }: { api: Api }) {
  const [view, setView] = useState<WorkspacesSettingsView>();
  // Only the newest load counts.
  const loads = useRef(0);
  const load = useCallback(() => {
    const n = ++loads.current;
    void api.getWorkspaces().then((v) => n === loads.current && setView(v));
  }, [api]);
  useEffect(() => {
    load();
    return api.onWorkspaces(load);
  }, [api, load]);

  if (!view) return null;
  return (
    <>
      <h2>{t.workspaces}</h2>
      <p className="muted">{t.workspacesHint}</p>
      <ul className="facts">
        <li>
          <span>{t.thisInstance}</span>
          <b>{view.name}</b>
        </li>
        <li>
          <span>{t.fingerprint}</span>
          <b>{view.fingerprint}</b>
        </li>
      </ul>
      <RelayForm api={api} view={view} />
      {view.workspaces.map((w) => (
        <Workspace key={w.name} api={api} workspace={w} view={view} />
      ))}
      <Activity api={api} />
      <div className="settings-row">
        <CreateForm api={api} />
        <JoinForm api={api} />
      </div>
    </>
  );
}

function RelayForm({ api, view }: { api: Api; view: WorkspacesSettingsView }) {
  const [address, setAddress] = useState(view.relay ?? '');
  const [error, run] = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = address.trim();
    run(url ? undefined : t.relayMissing, () => api.connectRelay(url));
  };
  return (
    <form className="workspace-form" aria-labelledby="relay-title" onSubmit={submit} noValidate>
      <h3 id="relay-title">{t.relay}</h3>
      <label className="field">
        {t.relayAddress}
        <input
          value={address}
          placeholder="wss://relay.example.com"
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      <p role="status" className="muted">
        {t.relayStatus[view.status]}
        {view.error && ` – ${shownError(view.error)}`}
      </p>
      <Alert error={error} />
      <Submit label={t.relayConnect} />
    </form>
  );
}

function Workspace({
  api,
  workspace: w,
  view,
}: {
  api: Api;
  workspace: WorkspacesSettingsView['workspaces'][number];
  view: WorkspacesSettingsView;
}) {
  const id = useId();
  const [error, run] = useAction();
  const [invite, setInvite] = useState<WorkspaceInvite>();
  const remove = (name: string, fingerprint: string) => {
    if (window.confirm(t.confirmRemoveMember(name, w.name)))
      run(undefined, () => api.removeMember(w.name, fingerprint));
  };
  return (
    <section className="workspace" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{w.name}</h3>
      {w.waiting ? (
        <p className="muted">{t.waitingForInviter}</p>
      ) : (
        <>
          <ul className="members" aria-label={t.members}>
            {w.members.map((m) => (
              <li key={m.fingerprint}>
                <span>
                  {m.name}
                  {m.fingerprint === view.fingerprint && ` ${t.you}`}
                </span>
                <code id={`${id}-${m.fingerprint}`}>{m.fingerprint}</code>
                {m.fingerprint !== view.fingerprint && (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={w.trusted.includes(m.fingerprint)}
                      aria-describedby={`${id}-${m.fingerprint} ${id}-trust`}
                      onChange={(e) =>
                        run(undefined, () =>
                          api.setWorkspaceTrust(w.name, m.fingerprint, e.target.checked),
                        )
                      }
                    />
                    {t.trustMember(m.name)}
                  </label>
                )}
                {m.fingerprint !== view.fingerprint && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => remove(m.name, m.fingerprint)}
                  >
                    {t.removeMember(m.name)}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p id={`${id}-trust`} className="muted">
            {t.trustHint}
          </p>
          {w.joined.map((m) => (
            <div key={m.fingerprint} className="join-request">
              <p>{t.wantsToJoin(m.name)}</p>
              <p className="fingerprint">
                <code>{m.fingerprint}</code>
              </p>
              {m.inviter && m.inviter !== view.fingerprint && (
                <p className="muted">
                  {t.invitedBy(
                    w.members.find((x) => x.fingerprint === m.inviter)?.name ?? m.inviter,
                  )}
                </p>
              )}
              <div className="picker-actions">
                {(!m.inviter || m.inviter === view.fingerprint) && (
                  <button
                    type="button"
                    className="button"
                    onClick={(e) =>
                      e.detail <= 1 && run(undefined, () => api.acceptMember(w.name, m.fingerprint))
                    }
                  >
                    {t.acceptMember(m.name)}
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  onClick={(e) =>
                    e.detail <= 1 && run(undefined, () => api.rejectMember(w.name, m.fingerprint))
                  }
                >
                  {t.rejectMember(m.name)}
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="button"
            onClick={(e) =>
              e.detail <= 1 &&
              run(undefined, async () => setInvite(await api.inviteToWorkspace(w.name)))
            }
          >
            {t.invite}
          </button>
          {invite && (
            <>
              <ul className="facts" aria-label={t.invitation}>
                <li>
                  <span>{t.workspace}</span>
                  <b>{invite.workspace}</b>
                </li>
                <li>
                  <span>{t.inviteToken}</span>
                  <b>{invite.token}</b>
                </li>
                <li>
                  <span>{t.fingerprint}</span>
                  <b>{invite.fingerprint}</b>
                </li>
              </ul>
              <p className="muted">{t.inviteHint}</p>
            </>
          )}
          <h4>{t.sharedFunctions}</h4>
          <p className="muted">{t.sharedFunctionsHint}</p>
          {view.functions.length === 0 && <p className="muted">{t.noRemoteFunctions}</p>}
          {view.functions.map((f) => (
            <div key={f.id} className="check-field">
              <label>
                <input
                  type="checkbox"
                  checked={w.shared.includes(f.id)}
                  aria-describedby={f.description && `${id}-${f.id}`}
                  onChange={(e) =>
                    run(undefined, () => api.setWorkspaceShare(w.name, f.id, e.target.checked))
                  }
                />
                {f.id}
              </label>
              {f.description && (
                <details className="function-description">
                  <summary aria-label={t.functionDescriptionFor(f.id)}>
                    {t.functionDescription}
                  </summary>
                  <p id={`${id}-${f.id}`} className="muted">
                    {f.description}
                  </p>
                </details>
              )}
            </div>
          ))}
        </>
      )}
      <Alert error={error} />
    </section>
  );
}

/** Inbox and log of workspace calls (ADR 0046). */
function Activity({ api }: { api: Api }) {
  const [activity, setActivity] = useState<WorkspaceActivity>();
  const [unreadable, setUnreadable] = useState<string>();
  const [workspace, setWorkspace] = useState('');
  const [instance, setInstance] = useState('');
  const [error, run] = useAction();
  const loads = useRef(0);
  const load = useCallback(() => {
    const n = ++loads.current;
    void api.getWorkspaceActivity().then(
      (a) => {
        if (n !== loads.current) return;
        setActivity(a);
        setUnreadable(undefined);
      },
      (e: Error) => {
        if (n !== loads.current) return;
        // No stale buttons for entries that may be gone (local server restarted, Codex).
        setActivity(undefined);
        setUnreadable(shownError(e.message));
      },
    );
  }, [api]);
  useEffect(() => {
    load();
    return api.onWorkspaces(load);
  }, [api, load]);
  if (unreadable)
    return (
      <section className="workspace" aria-labelledby="activity-title">
        <h3 id="activity-title">{t.activity}</h3>
        <p role="alert" className="error">
          {t.activityUnreadable(unreadable)}
        </p>
      </section>
    );
  if (!activity) return null;
  const decide = (action: () => Promise<void>) => run(undefined, () => action().finally(load));
  const from = (name: string | undefined, fp: string, ws: string) =>
    `${name ?? fp.slice(0, 16)} (${ws})`;
  const log = activity.log.filter(
    (e) => (!workspace || e.workspace === workspace) && (!instance || e.instance === instance),
  );
  const workspaces = [...new Set(activity.log.map((e) => e.workspace))];
  const instances = [...new Map(activity.log.map((e) => [e.instance, e.name])).entries()];
  return (
    <section className="workspace" aria-labelledby="activity-title">
      <h3 id="activity-title">{t.activity}</h3>
      <p className="muted">{t.activityHint}</p>
      <h4>{t.waiting}</h4>
      {activity.inbox.length >= 200 && <p role="status">{t.inboxFull}</p>}
      {activity.inbox.length === 0 ? (
        <p className="muted">{t.nothingWaiting}</p>
      ) : (
        <ul className="members inbox" aria-label={t.waiting}>
          {activity.inbox.map((e) => {
            // Text and sender: two entries may carry the same text (Codex).
            const what = `${e.preview || e.target} – ${from(e.name, e.instance, e.workspace)}`;
            return (
              <li key={e.id}>
                <span>{from(e.name, e.instance, e.workspace)}</span>
                <code>{e.target}</code>
                <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                <p>{e.preview}</p>
                <div className="picker-actions">
                  <button
                    type="button"
                    className="button"
                    aria-label={t.acceptInbox(what)}
                    onClick={(ev) => ev.detail <= 1 && decide(() => api.acceptInbox(e.id))}
                  >
                    {t.accept}
                  </button>
                  <button
                    type="button"
                    className="button"
                    aria-label={t.rejectInbox(what)}
                    onClick={(ev) => ev.detail <= 1 && decide(() => api.rejectInbox(e.id))}
                  >
                    {t.reject}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Alert error={error} />
      <h4>{t.log}</h4>
      {activity.log.length === 0 ? (
        <p className="muted">{t.noActivity}</p>
      ) : (
        <>
          <div className="picker-actions">
            <label className="field">
              {t.workspace}
              <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                <option value="">{t.all}</option>
                {workspaces.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t.instance}
              <select value={instance} onChange={(e) => setInstance(e.target.value)}>
                <option value="">{t.all}</option>
                {instances.map(([fp, name]) => (
                  <option key={fp} value={fp}>
                    {name ?? fp.slice(0, 16)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* Wider than the page at 200 %: scrollable by keyboard too (axe). */}
          <div className="table-scroll" role="region" aria-label={t.log} tabIndex={0}>
            <table className="permission-table" aria-label={t.log}>
              <thead>
                <tr>
                  <th scope="col">{t.time}</th>
                  <th scope="col">{t.direction}</th>
                  <th scope="col">{t.instance}</th>
                  <th scope="col">{t.outcome}</th>
                  <th scope="col">{t.functionName}</th>
                  <th scope="col">{t.text}</th>
                </tr>
              </thead>
              <tbody>
                {log.map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td>
                      <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                    </td>
                    <td>{t.directions[e.direction]}</td>
                    <td>{from(e.name, e.instance, e.workspace)}</td>
                    <td>{t.outcomes[e.outcome]}</td>
                    <td>
                      <code>{e.target}</code>
                    </td>
                    <td>{e.preview}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function CreateForm({ api }: { api: Api }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [error, run] = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const workspace = name.trim();
    const check = !workspace
      ? t.workspaceNameMissing
      : !WORKSPACE_NAME.test(workspace)
        ? t.workspaceNameInvalid
        : !token.trim()
          ? t.operatorTokenMissing
          : undefined;
    run(check, async () => {
      await api.createWorkspace(workspace, token.trim());
      setName('');
      setToken('');
    });
  };
  return (
    <form className="workspace-form" aria-labelledby="create-title" onSubmit={submit} noValidate>
      <h3 id="create-title">{t.createWorkspace}</h3>
      <label className="field">
        {t.workspaceName}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        {t.operatorToken}
        <input
          type="password"
          value={token}
          autoComplete="off"
          aria-describedby="operator-token-hint"
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <p id="operator-token-hint" className="muted">
        {t.operatorTokenHint}
      </p>
      <Alert error={error} />
      <Submit label={t.create} />
    </form>
  );
}

function JoinForm({ api }: { api: Api }) {
  const [workspace, setWorkspace] = useState('');
  const [token, setToken] = useState('');
  const [inviter, setInviter] = useState('');
  const [error, run] = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = workspace.trim();
    const fingerprint = inviter.trim().toLowerCase();
    const check = !name
      ? t.workspaceMissing
      : !WORKSPACE_NAME.test(name)
        ? t.workspaceNameInvalid
        : !token.trim()
          ? t.inviteTokenMissing
          : !fingerprint
            ? t.fingerprintMissing
            : !FINGERPRINT.test(fingerprint)
              ? t.fingerprintInvalid
              : undefined;
    run(check, async () => {
      await api.joinWorkspace(name, token.trim(), fingerprint);
      setWorkspace('');
      setToken('');
      setInviter('');
    });
  };
  return (
    <form className="workspace-form" aria-labelledby="join-title" onSubmit={submit} noValidate>
      <h3 id="join-title">{t.joinWorkspace}</h3>
      <label className="field">
        {t.workspace}
        <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
      </label>
      <label className="field">
        {t.inviteToken}
        <input
          value={token}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <label className="field">
        {t.inviterFingerprint}
        <input
          value={inviter}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="inviter-fingerprint-hint"
          onChange={(e) => setInviter(e.target.value)}
        />
      </label>
      <p id="inviter-fingerprint-hint" className="muted">
        {t.inviterFingerprintHint}
      </p>
      <Alert error={error} />
      <Submit label={t.join} />
    </form>
  );
}
