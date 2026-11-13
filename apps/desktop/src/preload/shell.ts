// Preload of the shell renderer (sidebar, settings).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { UiLocale } from '@hangar/sdk/i18n';
import type { ShellApi, ShellState } from '../shared';

const locale = ipcRenderer.sendSync('hangar:locale') as UiLocale;
window.addEventListener('DOMContentLoaded', () => (document.documentElement.lang = locale));

const api: ShellApi = {
  locale,
  getState: () => ipcRenderer.invoke('shell:state'),
  getOverview: () => ipcRenderer.invoke('shell:overview'),
  getPermissions: () => ipcRenderer.invoke('shell:permissions'),
  revoke: (grant) => ipcRenderer.invoke('shell:revoke', grant),
  setGrant: (subject, target, mode) => ipcRenderer.invoke('shell:setGrant', subject, target, mode),
  getJobs: () => ipcRenderer.invoke('shell:jobs'),
  setJobPaused: (id, paused, server) => ipcRenderer.invoke('shell:job.pause', id, paused, server),
  runJob: (id, server) => ipcRenderer.invoke('shell:job.run', id, server),
  removeJob: (id, server) => ipcRenderer.invoke('shell:job.remove', id, server),
  onJobs(listener) {
    const handler = () => listener();
    ipcRenderer.on('shell:jobs', handler);
    return () => ipcRenderer.removeListener('shell:jobs', handler);
  },
  getSettings: () => ipcRenderer.invoke('shell:settings'),
  setUpdateChannel: (channel) => ipcRenderer.invoke('shell:updateChannel', channel),
  setLanguage: (language) => ipcRenderer.invoke('shell:language', language),
  setTheme: (theme) => ipcRenderer.invoke('shell:theme', theme),
  getBaySettings: () => ipcRenderer.invoke('shell:baySettings'),
  setBaySetting: (bayId, key, value) => ipcRenderer.invoke('shell:baySetting', bayId, key, value),
  select: (selection) => ipcRenderer.send('shell:select', selection),
  addBay: (id) => ipcRenderer.invoke('shell:addBay', id),
  bayMenu: (id) => ipcRenderer.send('shell:bayMenu', id),
  moveBay: (id, index) => ipcRenderer.send('shell:moveBay', id, index),
  setModal: (open) => ipcRenderer.send('shell:modal', open),
  setHintHeight: (px) => ipcRenderer.send('shell:hintHeight', px),
  probeServer: (address) => ipcRenderer.invoke('shell:server.probe', address),
  setupServer: (name, address) => ipcRenderer.invoke('shell:server.setup', name, address),
  pairServer: (probeId, name, code) => ipcRenderer.invoke('shell:server.pair', probeId, name, code),
  cancelProbe: (probeId) => ipcRenderer.send('shell:server.cancel', probeId),
  serverMenu: (id) => ipcRenderer.send('shell:serverMenu', id),
  restartServer: (id) => ipcRenderer.invoke('shell:server.restart', id),
  restartLocalServer: () => ipcRenderer.invoke('shell:localServer.restart'),
  openLocalServerLog: () => ipcRenderer.send('shell:localServer.log'),
  getLocalServer: () => ipcRenderer.invoke('shell:localServer.setting'),
  setLocalServer: (enabled) => ipcRenderer.invoke('shell:localServer.enable', enabled),
  relaunch: () => ipcRenderer.send('shell:relaunch'),
  getNotifications: () => ipcRenderer.invoke('shell:notifications'),
  onNotifications(listener) {
    const handler = () => listener();
    ipcRenderer.on('shell:notifications', handler);
    return () => ipcRenderer.removeListener('shell:notifications', handler);
  },
  testNotification: () => ipcRenderer.invoke('shell:notifications.test'),
  openNotificationSettings: () => ipcRenderer.invoke('shell:notifications.settings'),
  pickShortcut: (kind) => ipcRenderer.invoke('shell:shortcut.pick', kind),
  addUrlShortcut: (url) => ipcRenderer.invoke('shell:shortcut.url', url),
  openShortcut: (id) => ipcRenderer.send('shell:shortcut.open', id),
  shortcutMenu: (id) => ipcRenderer.send('shell:shortcutMenu', id),
  moveShortcut: (id, index) => ipcRenderer.send('shell:moveShortcut', id, index),
  getWorkspaces: () => ipcRenderer.invoke('shell:workspaces'),
  connectRelay: (url) => ipcRenderer.invoke('shell:workspace.connect', url),
  createWorkspace: (name, token) => ipcRenderer.invoke('shell:workspace.create', name, token),
  inviteToWorkspace: (name) => ipcRenderer.invoke('shell:workspace.invite', name),
  joinWorkspace: (name, token, inviter) =>
    ipcRenderer.invoke('shell:workspace.join', name, token, inviter),
  acceptMember: (name, instance) => ipcRenderer.invoke('shell:workspace.accept', name, instance),
  rejectMember: (name, instance) => ipcRenderer.invoke('shell:workspace.reject', name, instance),
  removeMember: (name, instance) => ipcRenderer.invoke('shell:workspace.remove', name, instance),
  setWorkspaceShare: (name, target, on) =>
    ipcRenderer.invoke('shell:workspace.share', name, target, on),
  onWorkspaces(listener) {
    const handler = () => listener();
    ipcRenderer.on('shell:workspaces', handler);
    return () => ipcRenderer.removeListener('shell:workspaces', handler);
  },
  getBayCatalog: () => ipcRenderer.invoke('shell:bay.catalog'),
  prepareBay: (id, version) => ipcRenderer.invoke('shell:bay.prepare', id, version),
  confirmBay: (token) => ipcRenderer.invoke('shell:bay.confirm', token),
  cancelBay: (token) => ipcRenderer.invoke('shell:bay.cancel', token),
  rollbackBay: (id) => ipcRenderer.invoke('shell:bay.rollback', id),
  onState(listener) {
    const handler = (_e: IpcRendererEvent, state: ShellState) => listener(state);
    ipcRenderer.on('shell:state', handler);
    return () => ipcRenderer.removeListener('shell:state', handler);
  },
};

contextBridge.exposeInMainWorld('hangarShell', api);
