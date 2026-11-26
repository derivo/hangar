import { useEffect, useState } from 'react';
import { t } from '../messages';
import type {
  AppSettings,
  BaySettingsView,
  LanguageSetting,
  SettingValue,
  ShellApi,
  UpdateChannel,
} from '../shared';
import { BayCatalog } from './BayCatalog';
import { BaySwitches } from './BaySwitches';
import { Jobs } from './Jobs';
import { Notifications } from './Notifications';
import { Permissions } from './Permissions';
import { UpdateCheck } from './Updates';
import { Workspaces } from './Workspaces';

interface Props {
  api: Pick<
    ShellApi,
    | 'getPermissions'
    | 'revoke'
    | 'setGrant'
    | 'getSettings'
    | 'setUpdateChannel'
    | 'setLanguage'
    | 'getJobs'
    | 'setJobPaused'
    | 'runJob'
    | 'removeJob'
    | 'onJobs'
    | 'getBaySettings'
    | 'setBaySetting'
    | 'getState'
    | 'onState'
    | 'setBayInSidebar'
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
    | 'getBayCatalog'
    | 'prepareBay'
    | 'confirmBay'
    | 'cancelBay'
    | 'rollbackBay'
    | 'getLocalServer'
    | 'setLocalServer'
    | 'relaunch'
    | 'getNotifications'
    | 'onNotifications'
    | 'testNotification'
    | 'openNotificationSettings'
    | 'getUpdate'
    | 'onUpdate'
    | 'checkForUpdates'
    | 'installUpdate'
  >;
}

/**
 * Scrolls the section's first heading to the top and moves the focus there, so the keyboard
 * continues there. focus() alone only scrolls a heading that is out of view: on a tall window
 * a click on a visible section did nothing.
 */
function jump(e: React.MouseEvent, id: string) {
  const heading = document.getElementById(id)?.querySelector('h2');
  if (!heading) return;
  e.preventDefault();
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start' });
}

export function Settings({ api }: Props) {
  const sections = [
    ['settings-general', t.settingsGeneral],
    ['settings-bays', t.settingsBays],
    ['settings-workspaces', t.workspaces],
    ['settings-permissions', t.permissions],
    ['settings-jobs', t.jobs],
  ] as const;
  const [settings, setSettings] = useState<AppSettings>();
  useEffect(() => void api.getSettings().then(setSettings), [api]);
  const [local, setLocal] = useState<Awaited<ReturnType<Props['api']['getLocalServer']>>>(null);
  useEffect(() => void api.getLocalServer().then(setLocal), [api]);
  const [bays, setBays] = useState<BaySettingsView[]>([]);
  useEffect(() => void api.getBaySettings().then(setBays), [api]);

  const changeBaySetting = (bayId: string, key: string, value: SettingValue) => {
    setBays((all) =>
      all.map((b) =>
        b.bayId !== bayId
          ? b
          : { ...b, settings: b.settings.map((s) => (s.key === key ? { ...s, value } : s)) },
      ),
    );
    void api.setBaySetting(bayId, key, value);
  };

  const changeChannel = (updateChannel: UpdateChannel) => {
    setSettings((s) => s && { ...s, updateChannel });
    void api.setUpdateChannel(updateChannel);
  };
  const changeLocal = (enabled: boolean) => {
    if (!enabled && !window.confirm(t.localServerOffConfirm)) return;
    setLocal((l) => l && { ...l, enabled });
    void api.setLocalServer(enabled);
  };
  const changeLanguage = (language: LanguageSetting) => {
    setSettings((s) => s && { ...s, language });
    void api.setLanguage(language);
  };

  return (
    <section className="settings" aria-labelledby="settings-title">
      <h1 id="settings-title">{t.settings}</h1>
      <nav className="settings-nav" aria-label={t.settingsSections}>
        <ul>
          {sections.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} onClick={(e) => jump(e, id)}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-body">
        <section id="settings-general" aria-labelledby="settings-general-title">
          <h2 id="settings-general-title">{t.settingsGeneral}</h2>
          <div className="settings-row">
            <div className="settings-card">
              <h3>{t.language}</h3>
              <p className="muted">{t.languageHint}</p>
              <label className="field">
                {t.language}
                <select
                  value={settings?.language ?? 'system'}
                  disabled={!settings}
                  onChange={(e) => changeLanguage(e.target.value as LanguageSetting)}
                >
                  <option value="system">{t.languageSystem}</option>
                  {/* Each language in its own name, so it can be found in any language. */}
                  <option value="de" lang="de">
                    Deutsch
                  </option>
                  <option value="en" lang="en">
                    English
                  </option>
                </select>
              </label>
            </div>
            <div className="settings-card">
              <h3>{t.updates}</h3>
              <p className="muted">{t.updatesHint}</p>
              <label className="field">
                {t.updateChannel}
                <select
                  value={settings?.updateChannel ?? 'stable'}
                  disabled={!settings}
                  onChange={(e) => changeChannel(e.target.value as UpdateChannel)}
                >
                  <option value="stable">{t.channelStable}</option>
                  <option value="beta">{t.channelBeta}</option>
                </select>
              </label>
              <UpdateCheck api={api} />
            </div>
          </div>
          {local && (
            <div className="settings-card">
              <h3>{t.localServer}</h3>
              <div className="check-field">
                <label>
                  <input
                    type="checkbox"
                    checked={local.enabled}
                    disabled={local.forced}
                    aria-describedby="local-server-hint"
                    onChange={(e) => changeLocal(e.target.checked)}
                  />
                  {t.localServerSwitch}
                </label>
                <p id="local-server-hint" className="muted">
                  {t.localServerSwitchHint}
                </p>
                {local.forced && <p className="muted">{t.localServerForced}</p>}
                {local.enabled !== local.active && (
                  <p className="local-server-pending">
                    {t.afterRelaunch}{' '}
                    <button type="button" className="button" onClick={() => api.relaunch()}>
                      {t.relaunch}
                    </button>
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="settings-card">
            <Notifications api={api} />
          </div>
        </section>
        <section id="settings-bays" aria-labelledby="settings-bays-title">
          <h2 id="settings-bays-title">{t.settingsBays}</h2>
          <div className="settings-card">
            <BaySwitches api={api} />
          </div>
          {bays.length > 0 && (
            <div className="settings-card">
              <h3>{t.baySettings}</h3>
              {bays.map((bay) => (
                <div key={bay.bayId} className="bay-settings">
                  <h4>{bay.name}</h4>
                  {bay.settings.map((s) => {
                    const hint = `bay-setting-${bay.bayId}-${s.key}`;
                    const describedBy = s.description ? hint : undefined;
                    return (
                      <div key={s.key} className="check-field">
                        {typeof s.value === 'string' ? (
                          <label className="field">
                            {s.label}
                            <input
                              type="text"
                              value={s.value}
                              spellCheck={false}
                              aria-describedby={describedBy}
                              onChange={(e) => changeBaySetting(bay.bayId, s.key, e.target.value)}
                            />
                          </label>
                        ) : (
                          <label>
                            <input
                              type="checkbox"
                              checked={s.value}
                              aria-describedby={describedBy}
                              onChange={(e) => changeBaySetting(bay.bayId, s.key, e.target.checked)}
                            />
                            {s.label}
                          </label>
                        )}
                        {s.description && (
                          <p id={hint} className="muted">
                            {s.description}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <div className="settings-card">
            <BayCatalog key={settings?.updateChannel} api={api} />
          </div>
        </section>
        <div id="settings-workspaces">
          <Workspaces api={api} />
        </div>
        <div id="settings-permissions">
          <Permissions api={api} />
        </div>
        <div id="settings-jobs">
          <Jobs api={api} />
        </div>
      </div>
    </section>
  );
}
