import { useEffect, useRef, useState, type DragEvent } from 'react';
import type {
  Selection,
  ShellApi,
  ShellState,
  SidebarBay,
  SidebarBayError,
  SidebarShortcut,
  ThemeSetting,
} from '../shared';
import { t } from '../messages';

interface Props {
  state: ShellState;
  api: Pick<
    ShellApi,
    | 'getSettings'
    | 'setTheme'
    | 'addBay'
    | 'bayMenu'
    | 'setModal'
    | 'probeServer'
    | 'setupServer'
    | 'pairServer'
    | 'cancelProbe'
    | 'serverMenu'
    | 'pickShortcut'
    | 'addUrlShortcut'
    | 'openShortcut'
    | 'shortcutMenu'
    | 'moveBay'
    | 'moveShortcut'
  >;
  onSelect(selection: Selection): void;
}

/**
 * Drag an item onto another of its list to put it there (ADR 0038). One per list, so a
 * shortcut never lands among the bays; a drop from outside (a file) does nothing.
 */
function useReorder(move: (id: string, index: number) => void) {
  const dragged = useRef<{ id: string; index: number } | undefined>(undefined);
  const [over, setOver] = useState<{ id: string; after: boolean }>();
  return (id: string, index: number) => ({
    className: over?.id === id ? (over.after ? 'drop-after' : 'drop-target') : undefined,
    onDragStart: () => (dragged.current = { id, index }),
    onDragEnd: () => {
      dragged.current = undefined;
      setOver(undefined);
    },
    onDragOver: (e: DragEvent) => {
      if (!dragged.current || dragged.current.id === id) return;
      e.preventDefault();
      setOver({ id, after: dragged.current.index < index });
    },
    onDragLeave: () => setOver(undefined),
    onDrop: () => {
      setOver(undefined);
      const from = dragged.current;
      if (from && from.id !== id) move(from.id, index);
    },
  });
}

type ReorderProps = ReturnType<ReturnType<typeof useReorder>>;

const NEXT_THEME: Record<ThemeSetting, ThemeSetting> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/** Half-filled ring for system, sun for light, moon for dark. */
const THEME_ICONS: Record<ThemeSetting, string> = {
  system: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 0 16z',
  light:
    'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z',
  dark: 'M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5z',
};

const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

/** The message of an error from the main process, in the app language where known. */
function shownError(e: Error): string {
  const message = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (message.startsWith('Invalid address:')) return t.invalidAddress;
  if (message.startsWith('Cannot reach')) return t.unreachable;
  if (message.startsWith('SSH failed: ')) return t.sshFailed(message.slice('SSH failed: '.length));
  if (message === 'Wrong pairing code') return t.wrongCode;
  if (message === 'Pairing has ended') return t.pairingEnded;
  if (message === 'Invalid URL') return t.invalidUrl;
  return message;
}

/** Why the setup on a Linux machine stopped (`packages/bridge/src/setup.ts`, ADR 0041). */
function setupError(e: Error): string {
  const message = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const e2 = t.setupErrors;
  const m = (re: RegExp) => re.exec(message);
  let found;
  if (message.startsWith('Invalid address:')) return t.invalidSetupAddress;
  if ((found = m(/^Not a Linux machine: (.*)$/))) return e2.notLinux(found[1]!);
  if ((found = m(/^Unsupported architecture: (.*)$/))) return e2.arch(found[1]!);
  if ((found = m(/^No package for (\S+) in this build$/))) return e2.noPackage(found[1]!);
  if (message === 'No glibc on the machine') return e2.noGlibc;
  if ((found = m(/^glibc (\S+) is older than (\S+)$/))) return e2.glibc(found[1]!, found[2]!);
  if (message === 'No systemd user services on the machine') return e2.noSystemd;
  if (message === 'git not found on the machine') return e2.noGit;
  if ((found = m(/^node-pty does not start on the machine: (.*)$/s))) return e2.pty(found[1]!);
  if ((found = m(/^The server did not start: (.*)$/s))) return e2.notStarted(found[1]!);
  return shownError(e);
}

function BayButton({
  bay,
  label,
  selected,
  onSelect,
  onMenu,
  drag,
}: {
  bay: SidebarBay;
  label: string;
  selected: boolean;
  onSelect(): void;
  onMenu?(): void;
  drag?: ReorderProps;
}) {
  return (
    <li {...drag}>
      <button
        type="button"
        className="sidebar-item"
        draggable={drag ? true : undefined}
        title={label}
        aria-label={bay.badge > 0 ? t.badge(label, bay.badge) : label}
        aria-current={selected ? 'page' : undefined}
        data-testid={`bay-${bay.id}`}
        onClick={onSelect}
        onContextMenu={(e) => {
          if (!onMenu) return;
          e.preventDefault();
          onMenu();
        }}
      >
        <img src={bay.icon} alt="" className="sidebar-icon" />
      </button>
      {/* Outside the button, so the badge can overhang its corner. */}
      {bay.badge > 0 && (
        <span className="badge" data-testid={`badge-${bay.id}`} aria-hidden="true">
          {badgeText(bay.badge)}
        </span>
      )}
    </li>
  );
}

/** Globe for websites, a page for paths without a system icon. */
const SHORTCUT_GLYPHS = {
  url: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15 15 0 0 0-1.4-3.9A8 8 0 0 1 18.9 8zM12 4.1c.8 1.2 1.5 2.5 1.9 3.9h-3.8c.4-1.4 1.1-2.7 1.9-3.9zM4.3 14a8 8 0 0 1 0-4h3.4a16 16 0 0 0 0 4zm.8 2h3a15 15 0 0 0 1.4 3.9A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.9A15 15 0 0 0 8.1 8zM12 19.9c-.8-1.2-1.5-2.5-1.9-3.9h3.8c-.4 1.4-1.1 2.7-1.9 3.9zM14.3 14H9.7a14 14 0 0 1 0-4h4.6a14 14 0 0 1 0 4zm.2 5.9a15 15 0 0 0 1.4-3.9h3a8 8 0 0 1-4.4 3.9zm1.8-5.9a16 16 0 0 0 0-4h3.4a8 8 0 0 1 0 4z',
  path: 'M6 2h8l6 6v14H6zm2 2v16h10V9h-5V4z',
};

function ShortcutButton({
  shortcut: s,
  api,
  drag,
}: {
  shortcut: SidebarShortcut;
  api: Pick<ShellApi, 'openShortcut' | 'shortcutMenu'>;
  drag: ReorderProps;
}) {
  return (
    <li {...drag}>
      <button
        type="button"
        draggable
        className="sidebar-item"
        title={`${s.name}\n${s.target}`}
        aria-label={t.openShortcut(s.name)}
        // The further clicks of a double click (detail 2, 3 …) do not open it again.
        onClick={(e) => e.detail <= 1 && api.openShortcut(s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          api.shortcutMenu(s.id);
        }}
      >
        {s.icon ? (
          <img src={s.icon} alt="" className="sidebar-icon" />
        ) : (
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d={SHORTCUT_GLYPHS[s.url ? 'url' : 'path']} />
          </svg>
        )}
      </button>
    </li>
  );
}

function ErrorItem({ error: e }: { error: SidebarBayError }) {
  return (
    <li>
      <span
        className="sidebar-item sidebar-error"
        role="img"
        aria-label={`${e.label}: ${e.error}`}
        title={`${e.label}: ${e.error}`}
      >
        !
      </span>
    </li>
  );
}

export function Sidebar({ state, api, onSelect }: Props) {
  const [theme, setTheme] = useState<ThemeSetting>();
  useEffect(() => void api.getSettings().then((s) => setTheme(s.theme)), [api]);
  const switchTheme = () => {
    if (!theme) return;
    const next = NEXT_THEME[theme];
    setTheme(next);
    void api.setTheme(next);
  };
  const themeLabel = theme && t.themeToggle(t.themes[theme], t.themes[NEXT_THEME[theme]]);
  const dragBay = useReorder(api.moveBay);
  const dragShortcut = useReorder(api.moveShortcut);
  const local = state.localServer;
  const localLabel = (name: string) =>
    local?.status === 'connected'
      ? name
      : t.localBay(
          name,
          local?.status === 'connecting' ? t.localServerStarting : t.localServerDown,
        );
  // One list for the bays of the app and of the local server (ADR 0038).
  const bays = [
    ...state.bays.map((bay) => ({ bay, label: bay.name })),
    ...(local?.bays ?? []).map((bay) => ({ bay, label: localLabel(bay.name) })),
  ];
  const order = state.order ?? bays.map((b) => b.bay.id);
  bays.sort((a, b) => order.indexOf(a.bay.id) - order.indexOf(b.bay.id));

  return (
    <nav className="sidebar" aria-label={t.bays}>
      <button
        type="button"
        className="sidebar-item sidebar-mark"
        title={t.overview}
        aria-label={t.overview}
        aria-current={state.selected === 'overview' ? 'page' : undefined}
        onClick={() => onSelect('overview')}
      >
        <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
          <path d="M3 27V11l8-7h10l8 7v16h-7V15H10v12Z" fill="currentColor" />
        </svg>
      </button>
      <ul className="sidebar-list">
        {bays.map(({ bay, label }, index) => (
          <BayButton
            key={bay.id}
            bay={bay}
            label={label}
            selected={state.selected === bay.id}
            onSelect={() => onSelect(bay.id)}
            onMenu={() => api.bayMenu(bay.id)}
            drag={dragBay(bay.id, index)}
          />
        ))}
        {state.errors.map((e) => (
          <ErrorItem key={e.label} error={e} />
        ))}
        {state.servers.map((server) => {
          const status = server.restarting
            ? t.serverRestarting
            : t.serverStatus[server.status] +
              (server.error ? ` (${server.error})` : '') +
              (server.update ? `, ${t.newVersion}` : '');
          const label = t.server(server.name, status);
          return (
            <li key={server.id}>
              <button
                type="button"
                className="sidebar-item sidebar-server"
                data-status={server.status}
                title={label}
                aria-label={label}
                aria-haspopup="menu"
                onClick={() => api.serverMenu(server.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  api.serverMenu(server.id);
                }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M4 3h16v8H4zm2 2v4h12V5zm-2 8h16v8H4zm2 2v4h12v-4zm1-9h2v2H7zm0 10h2v2H7z"
                  />
                </svg>
              </button>
              <ul className="sidebar-list">
                {server.bays.map((bay) => (
                  <BayButton
                    key={bay.id}
                    bay={bay}
                    label={t.remoteBay(bay.name, server.name)}
                    selected={state.selected === bay.id}
                    onSelect={() => onSelect(bay.id)}
                  />
                ))}
                {server.errors.map((e) => (
                  <ErrorItem key={e.label} error={e} />
                ))}
              </ul>
            </li>
          );
        })}
        {state.shortcuts.length > 0 && (
          <li>
            <ul className="sidebar-list sidebar-shortcuts" aria-label={t.shortcuts}>
              {state.shortcuts.map((s, index) => (
                <ShortcutButton
                  key={s.id}
                  shortcut={s}
                  api={api}
                  drag={dragShortcut(s.id, index)}
                />
              ))}
            </ul>
          </li>
        )}
        <li>
          <BayPicker state={state} api={api} />
        </li>
      </ul>
      <button
        type="button"
        className="sidebar-item sidebar-theme"
        title={themeLabel}
        aria-label={themeLabel}
        disabled={!theme}
        onClick={switchTheme}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path fill="currentColor" fillRule="evenodd" d={THEME_ICONS[theme ?? 'system']} />
        </svg>
      </button>
      <button
        type="button"
        className="sidebar-item"
        title={t.settings}
        aria-label={t.settings}
        aria-current={state.selected === 'settings' ? 'page' : undefined}
        onClick={() => onSelect('settings')}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
          />
        </svg>
      </button>
    </nav>
  );
}

/** Plus under the bays; its modal lists the found bays not yet in the sidebar (ADR 0017). */
function BayPicker({ state, api }: Pick<Props, 'state' | 'api'>) {
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const [url, setUrl] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  // Counts openings, so an answer for a picker closed meanwhile does not touch a new one.
  const opening = useRef(0);

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    api.setModal(true);
    return () => api.setModal(false);
  }, [open, api]);

  const close = () => {
    setOpen(false);
    setPairing(false);
    setError(undefined);
    setUrl('');
  };
  // One action per opening: pressing again before the answer does nothing.
  const busy = useRef<number | undefined>(undefined);
  const current = async <T,>(start: () => Promise<T>, done: (value: T) => void) => {
    const at = opening.current;
    if (busy.current === at) return;
    busy.current = at;
    try {
      const value = await start();
      if (at === opening.current) done(value);
    } catch (e) {
      if (at === opening.current) setError(shownError(e as Error));
    } finally {
      if (busy.current === at) busy.current = undefined;
    }
  };
  const add = (id: string) => current(() => api.addBay(id), close);
  const pick = (kind: 'file' | 'folder') =>
    current(
      () => api.pickShortcut(kind),
      (added) => added && close(),
    );
  const addUrl = (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (!url.trim()) return setError(t.addressMissing);
    void current(() => api.addUrlShortcut(url.trim()), close);
  };

  return (
    <>
      <button
        type="button"
        className="sidebar-item sidebar-add"
        title={t.addBay}
        aria-label={t.addBay}
        onClick={() => {
          opening.current++;
          setOpen(true);
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path fill="currentColor" d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" />
        </svg>
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="picker"
          aria-labelledby="picker-title"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            close();
          }}
        >
          {pairing ? (
            <ServerPairing api={api} onDone={close} />
          ) : (
            <>
              <h2 id="picker-title">{t.addBay}</h2>
              <h3>{t.bays}</h3>
              {state.available.length === 0 ? (
                <p className="muted">{t.allBaysAdded}</p>
              ) : (
                <ul className="picker-list">
                  {state.available.map((bay) => (
                    <li key={bay.id}>
                      <button type="button" className="picker-bay" onClick={() => void add(bay.id)}>
                        <img src={bay.icon} alt="" />
                        <span>
                          {bay.name}
                          <small>{bay.id}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <h3>{t.shortcuts}</h3>
              <div className="picker-actions">
                <button type="button" className="button" onClick={() => void pick('file')}>
                  {t.pickFile}
                </button>
                <button type="button" className="button" onClick={() => void pick('folder')}>
                  {t.pickFolder}
                </button>
              </div>
              <form className="picker-url" onSubmit={addUrl} noValidate>
                <label className="field">
                  {t.website}
                  <input
                    type="url"
                    value={url}
                    spellCheck={false}
                    aria-describedby="picker-url-hint"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </label>
                <p id="picker-url-hint" className="muted">
                  {t.websiteHint}
                </p>
                <button type="submit" className="button">
                  {t.addWebsite}
                </button>
              </form>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="picker-actions">
                <button type="button" className="button" onClick={() => setPairing(true)}>
                  {t.connectServer}
                </button>
                <button type="button" className="button" onClick={close}>
                  {t.cancel}
                </button>
              </div>
            </>
          )}
        </dialog>
      )}
    </>
  );
}

/** Pairing inside the picker: name and address, then fingerprint and code (ADR 0019). */
function ServerPairing({
  api,
  onDone,
}: {
  api: Pick<ShellApi, 'probeServer' | 'pairServer' | 'cancelProbe' | 'setupServer'>;
  onDone(): void;
}) {
  // Set up on a Linux machine over ssh instead of connecting to a running server (ADR 0041).
  const [setup, setSetup] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setUpUser, setSetUpUser] = useState<string>();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [probe, setProbe] = useState<{ id: string; fingerprint: string }>();
  const [error, setError] = useState<string>();
  // However the dialog closes (Escape, Cancel), the probe ends; one that answers late too.
  const session = useRef<{ open: boolean; probe?: string }>({ open: true });
  useEffect(() => {
    const current = session.current;
    current.open = true;
    return () => {
      current.open = false;
      if (current.probe) api.cancelProbe(current.probe);
    };
  }, [api]);

  // Weiter and Koppeln wait for their answer: pressing again opens no second connection.
  const busy = useRef(false);
  const once = (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    void action()
      .catch((e: Error) => setError(shownError(e)))
      .finally(() => (busy.current = false));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    setError(undefined);
    if (!probe) {
      if (!name.trim()) return setError(t.nameMissing);
      if (!address.trim()) return setError(t.addressMissing);
      if (setup)
        return once(async () => {
          setSettingUp(true);
          try {
            const result = await api.setupServer(name.trim(), address.trim());
            if (!session.current.open) return;
            if (result.linger) onDone();
            else setSetUpUser(result.user);
          } catch (e) {
            throw new Error(setupError(e as Error), { cause: e });
          } finally {
            setSettingUp(false);
          }
        });
      return once(async () => {
        const p = await api.probeServer(address.trim());
        if (!session.current.open) return api.cancelProbe(p.id);
        session.current.probe = p.id;
        setProbe(p);
      });
    }
    if (!code.trim()) return setError(t.codeMissing);
    once(async () => {
      await api.pairServer(probe.id, name.trim(), code.trim());
      session.current.probe = undefined;
      onDone();
    });
  };

  if (setUpUser !== undefined)
    return (
      <div className="pairing">
        <h2 id="picker-title">{t.connectServer}</h2>
        <p role="status">{t.setUpDone}</p>
        <p>{t.lingerHint(setUpUser)}</p>
        <div className="picker-actions">
          <button type="button" className="button" autoFocus onClick={onDone}>
            {t.done}
          </button>
        </div>
      </div>
    );

  return (
    <form
      className="pairing"
      onSubmit={submit}
      noValidate
      // The setup goes on in the main process: Escape does not hide it while it runs.
      onKeyDown={(e) => {
        if (settingUp && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <h2 id="picker-title">{t.connectServer}</h2>
      {probe ? (
        <>
          <p>{t.fingerprintHint}</p>
          <p className="fingerprint">
            <code>{probe.fingerprint}</code>
          </p>
          <label className="field">
            {t.pairingCode}
            <input
              autoFocus
              value={code}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="pairing-code-hint"
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <p id="pairing-code-hint" className="muted">
            {t.pairingCodeHint}
          </p>
        </>
      ) : (
        <>
          <label className="field">
            {t.serverName}
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            {t.serverAddress}
            <input
              value={address}
              placeholder={setup ? 'anna@heimserver' : 'anna@heimserver:7420'}
              spellCheck={false}
              aria-describedby="server-address-hint"
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <p id="server-address-hint" className="muted">
            {setup ? t.setUpHint : t.serverAddressHint}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={setup}
              disabled={settingUp}
              onChange={(e) => setSetup(e.target.checked)}
            />
            {t.setUp}
          </label>
        </>
      )}
      {settingUp && <p role="status">{t.settingUp}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="picker-actions">
        <button
          type="submit"
          className="button"
          // The second click of a double click on Weiter would land on Koppeln (ADR 0028).
          onClick={(e) => e.detail > 1 && e.preventDefault()}
        >
          {probe ? t.pair : setup ? t.setUpButton : t.next}
        </button>
        <button type="button" className="button" disabled={settingUp} onClick={onDone}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
