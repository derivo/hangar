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
import { Jobs } from './Jobs';
import { Notifications } from './Notifications';
import { Permissions } from './Permissions';
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
    | 'getWorkspaces'
    | 'connectRelay'
    | 'createWorkspace'
    | 'inviteToWorkspace'
    | 'joinWorkspace'
    | 'acceptMember'
    | 'rejectMember'
    | 'removeMember'
    | 'setWorkspaceShare'
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
  >;
}

export function Settings({ api }: Props) {
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
      <h2>{t.language}</h2>
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
      <h2>{t.updates}</h2>
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
      {local && (
        <>
          <h2>{t.localServer}</h2>
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
        </>
      )}
      <Notifications api={api} />
      {bays.length > 0 && (
        <>
          <h2>{t.baySettings}</h2>
          {bays.map((bay) => (
            <div key={bay.bayId} className="bay-settings">
              <h3>{bay.name}</h3>
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
        </>
      )}
      <BayCatalog key={settings?.updateChannel} api={api} />
      <Workspaces api={api} />
      <Permissions api={api} />
      <Jobs api={api} />
    </section>
  );
}
