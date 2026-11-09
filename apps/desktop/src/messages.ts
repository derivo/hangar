// Texts of the shell (main process and renderer), see ADR 0009.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';
import type { PreparedBay, RightsDiff } from './shared';

/** Lines of the permission diff for the install dialog (ADR 0034). */
function rights(
  p: PreparedBay,
  label: Record<keyof RightsDiff | 'none' | 'data', string>,
): string[] {
  const { diff } = p;
  const lines = [
    ...(diff.functions.length ? [`${label.functions}: ${diff.functions.join(', ')}`] : []),
    ...(diff.uses.length ? [`${label.uses}: ${diff.uses.join(', ')}`] : []),
    ...(diff.agentSessions ? [label.agentSessions] : []),
    ...(diff.hostModules.length ? [`${label.hostModules}: ${diff.hostModules.join(', ')}`] : []),
    ...(diff.sensitive.length ? [`${label.sensitive}: ${diff.sensitive.join(', ')}`] : []),
  ];
  return [...(lines.length ? lines : [label.none]), ...(p.dataVersionChanged ? [label.data] : [])];
}

const de = {
  // Sidebar and empty window
  bays: 'Bays',
  settings: 'Einstellungen',
  badge: (bay: string, count: number) =>
    count === 1 ? `${bay}, 1 Hinweis` : `${bay}, ${count} Hinweise`,
  noBay: 'Keine Bay geladen.',
  addBay: 'Zur Leiste hinzufügen',
  allBaysAdded: 'Alle Bays sind schon in der Leiste.',
  // Shortcuts (ADR 0027)
  shortcuts: 'Verknüpfungen',
  openShortcut: (name: string) => `${name} öffnen`,
  pickFile: 'Datei oder Programm …',
  pickFolder: 'Ordner …',
  website: 'Webseite',
  websiteHint: 'Adresse mit http:// oder https://, z. B. https://example.com',
  addWebsite: 'Webseite hinzufügen',
  invalidUrl: 'Nur Adressen mit http:// oder https:// gehen.',
  shortcutFailed: (name: string) => `„${name}“ lässt sich nicht öffnen.`,
  removeBay: 'Aus Leiste entfernen',
  moveUp: 'Nach oben',
  moveDown: 'Nach unten',
  cancel: 'Abbrechen',
  // Servers (ADR 0019)
  connectServer: 'Mit Server verbinden',
  serverName: 'Name',
  serverAddress: 'Adresse',
  serverAddressHint:
    'Über SSH: benutzer@host:port mit dem Port von hangar-server auf dem Server, z. B. anna@heimserver:7420. Ohne SSH: 127.0.0.1:port.',
  next: 'Weiter',
  fingerprintHint: 'Fingerabdruck des Servers. Vergleiche ihn mit dem Log des Servers.',
  pairingCode: 'Kopplungscode',
  pairingCodeHint: 'Steht im Log des Servers unter „pairing code“.',
  pair: 'Koppeln',
  nameMissing: 'Name fehlt.',
  addressMissing: 'Adresse fehlt.',
  invalidAddress: 'Adresse ungültig: benutzer@host:port oder 127.0.0.1:port, Port 1–65535.',
  unreachable: 'Server nicht erreichbar. Läuft hangar-server dort mit diesem Port?',
  sshFailed: (detail: string) =>
    `SSH-Verbindung fehlgeschlagen (${detail}). Klappt ssh im Terminal ohne Passwortabfrage?`,
  codeMissing: 'Kopplungscode fehlt.',
  wrongCode: 'Kopplungscode falsch.',
  pairingEnded: 'Kopplung abgebrochen. Bitte neu verbinden.',
  serverStatus: {
    connecting: 'verbindet',
    connected: 'verbunden',
    disconnected: 'getrennt',
    failed: 'Fehler',
  },
  server: (name: string, status: string) => `Server ${name}: ${status}`,
  remoteBay: (bay: string, server: string) => `${bay} (${server})`,
  versionMismatch: (server: string, local: string) =>
    `Version passt nicht (Server ${server}, hier ${local})`,
  bayMissing: 'Bay fehlt hier',
  connect: 'Verbinden',
  disconnect: 'Verbindung trennen',
  removeServer: 'Server entfernen',
  themes: { system: 'System', light: 'Hell', dark: 'Dunkel' },
  themeToggle: (current: string, next: string) => `Farbschema: ${current} (wechseln zu ${next})`,

  // Overview
  overview: 'Hangar-Übersicht',
  name: 'Name',
  email: 'E-Mail',
  notSet: 'nicht gesetzt',
  gitSetHint: 'Setzen im Terminal:',
  gitMissing: 'Git ist nicht installiert oder nicht im PATH.',
  bayId: 'Kennung',
  version: 'Version',
  notLoaded: 'Nicht geladen',

  // Settings
  language: 'Sprache',
  languageSystem: 'Systemsprache',
  languageHint: 'Gilt ab dem nächsten Start von Hangar.',
  updates: 'Updates',
  updatesHint: 'Hangar lädt Updates im Hintergrund und installiert sie beim nächsten Neustart.',
  baySettings: 'Einstellungen der Bays',
  updateChannel: 'Update-Kanal',
  channelStable: 'Stabil',
  channelBeta: 'Beta',
  permissions: 'Berechtigungen',
  permissionsHint:
    'Bays und ihre Agents dürfen eigene Funktionen immer nutzen. Hier stehen die Rechte für Zugriffe auf andere Bays und auf sensible Funktionen.',
  sensitive: 'sensibel',
  permissionsEmpty:
    'Noch keine Rechte. Hangar fragt beim ersten Zugriff einer Bay auf eine andere.',
  showCaller: 'Aufrufer anzeigen',
  allCallers: 'Alle',
  searchFunction: 'Funktion suchen',
  functionColumn: 'Funktion',
  modeColumn: 'Freigabe',
  grantedAt: 'Erteilt',
  lastUsed: 'Letzter Aufruf',
  unknownTime: 'unbekannt',
  notUsed: 'seit dem Start nicht',
  sessionOnly: (session: string) => `nur Session „${session}“`,
  when: (iso: string) =>
    new Intl.DateTimeFormat('de', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)),
  ruleTitle: 'Regel festlegen',
  caller: 'Aufrufer',
  setRule: 'Festlegen',
  modes: {
    allow: 'erlaubt',
    deny: 'abgelehnt',
    session: 'für eine Session erlaubt',
    ask: 'bei jedem Zugriff fragen',
  },
  revoke: 'Widerrufen',
  jobs: 'Jobs',
  jobsHint:
    'Zeitgesteuerte Aufgaben der Bays. Sie laufen, solange Hangar läuft (auch im Tray); ein verpasster Lauf wird nach dem Aufwachen einmal nachgeholt.',
  jobsEmpty:
    'Noch keine Jobs. Bays legen sie an, etwa die Agent-Bay mit „Job planen“ in einer Session.',
  job: 'Job',
  schedule: 'Zeitplan',
  nextRun: 'Nächster Lauf',
  lastRun: 'Letzter Lauf',
  result: 'Ergebnis',
  never: 'nie',
  notRunYet: 'noch nicht gelaufen',
  bayNotLoaded: 'Bay nicht geladen',
  jobRunning: 'läuft',
  jobPaused: 'pausiert',
  runResult: (ok: boolean, ms: number, output: string) =>
    `${ok ? 'erfolgreich' : 'fehlgeschlagen'} (${Math.round(ms / 1000)} s)${output ? `: ${output}` : ''}`,
  pause: 'Pausieren',
  resume: 'Fortsetzen',
  runNow: 'Jetzt ausführen',
  deleteJob: 'Löschen',
  jobsHere: 'Auf diesem Rechner',
  jobsOnServer: (name: string) => `Auf dem Server „${name}“`,
  noJobs: 'Keine Jobs.',

  // Permission dialog
  callBySession: (bay: string, target: string) =>
    `Ein Agent in einer Session von „${bay}“ möchte „${target}“ aufrufen.`,
  callByBay: (bay: string, target: string) => `Die Bay „${bay}“ möchte „${target}“ aufrufen.`,
  callByLocalSession: (bay: string, target: string) =>
    `Ein Agent in einer Session von „${bay}“ im lokalen Server möchte „${target}“ aufrufen.`,
  callByLocalBay: (bay: string, target: string) =>
    `Die Bay „${bay}“ im lokalen Server möchte „${target}“ aufrufen.`,
  callByRemote: (instance: string, workspace: string, bay: string, target: string) =>
    `Die Instanz „${instance}“ im Workspace „${workspace}“ möchte über die Bay „${bay}“ „${target}“ aufrufen.`,
  onServer: (server: string) => `Auf dem Server „${server}“:`,
  localServer: 'Lokaler Server',
  localServerDown: 'Lokaler Server läuft nicht',
  localServerSwitch: 'Agents im lokalen Server ausführen',
  localServerSwitchHint:
    'Shells und Agents laufen weiter, wenn Hangar beendet wird, abstürzt oder sich aktualisiert. Wer Projekte in Workspaces teilt, schaltet das vorerst ab.',
  localServerOffConfirm:
    'Beim nächsten Start enden die Shells des lokalen Servers; die Agents ziehen mit ihren Daten zurück in Hangar. Ausschalten?',
  afterRelaunch: 'Gilt nach dem Neustart von Hangar.',
  localServerForced: 'Festgelegt durch HANGAR_LOCAL_SERVER.',
  relaunch: 'Hangar neu starten',
  localServerStarting: 'Lokaler Server startet …',
  localBay: (bay: string, status: string) => `${bay} (${status})`,
  restartLocalServer: 'Lokalen Server neu starten',
  restartLocalServerMenu: 'Lokalen Server neu starten …',
  restartLocalServerTitle: 'Lokalen Server neu starten?',
  restartLocalServerDetail: (n?: number) =>
    n === undefined
      ? 'Laufende Shells enden; ihr Verlauf bleibt.'
      : n === 1
        ? 'Eine laufende Shell endet; ihr Verlauf bleibt.'
        : `${n} laufende Shells enden; ihr Verlauf bleibt.`,
  restartLocalServerFailed: 'Lokaler Server ließ sich nicht neu starten',
  noKeychain: 'Kein Schlüsselbund verfügbar: Passwörter werden nicht im Klartext gespeichert',
  workspacesUnavailable: 'Arbeitsbereiche nicht verfügbar: Hangar startet ohne sie',
  restart: 'Neu starten',
  openLog: 'Log öffnen',
  localServerShells: (n: number) =>
    n === 1 ? 'Lokaler Server: 1 Shell läuft' : `Lokaler Server: ${n} Shells laufen`,
  localServerDownHint:
    'Die Agents und ihre Shells laufen im lokalen Server. Ein Neustart startet ihn und stellt die Sessions wieder her.',
  updateHint: 'Neue Version',
  updateReady: (running: string, ready: string) =>
    `Neue Version bereit: Im lokalen Server läuft Hangar ${running}, installiert ist ${ready}.`,
  decisionSaved: 'Die Entscheidung wird gespeichert.',
  confirmTitle: 'Zugriff bestätigen',
  allowTitle: 'Zugriff erlauben?',
  sensitiveTitle: 'Zugriff auf eine sensible Funktion',
  allow: 'Erlauben',
  deny: 'Ablehnen',
  allowAlways: 'Dauerhaft erlauben',
  allowSession: 'Für diese Session',
  allowOnce: 'Nur dieses Mal',
  askEveryTime: 'Bei jedem Zugriff fragen',

  // Installed bays (ADR 0034)
  installBays: 'Bays installieren',
  installBaysHint:
    'Aus dem Bay-Index, nach Prüfung der Signatur. Neue Versionen laufen ab dem nächsten Start von Hangar.',
  noBayIndex: 'Kein Bay-Index eingerichtet.',
  noBaysInIndex: 'Der Index enthält keine Bays.',
  notInstalled: 'Nicht installiert',
  installedVersion: (version: string) => `Installiert: ${version}`,
  nextStartVersion: (version: string) => `Ab dem nächsten Start: ${version}`,
  installBay: (version: string) => `${version} installieren`,
  updateBay: (version: string) => `Auf ${version} aktualisieren`,
  rollbackBay: (version: string) => `Auf ${version} zurückrollen`,
  bayActionFailed: (message: string) => `Fehlgeschlagen: ${message}`,
  confirmInstall: (p: PreparedBay) =>
    [
      `${p.name} ${p.version} installieren?`,
      '',
      ...rights(p, {
        functions: 'Neue Funktionen',
        uses: 'Ruft neu auf',
        agentSessions: 'Startet Agent-Sessions mit eigenem Zugang',
        hostModules: 'Neue Fähigkeiten',
        sensitive: 'Jetzt sensibel, fragt wieder nach',
        none: 'Keine neuen Rechte.',
        data: 'Das Datenformat ändert sich; Hangar sichert die Daten vorher.',
      }),
      '',
      'Die neue Version läuft ab dem nächsten Start.',
    ].join('\n'),
  confirmRollback: (id: string, version: string, losesData: boolean) =>
    [
      `${id} auf ${version} zurückrollen?`,
      ...(losesData
        ? [
            '',
            'Die Daten gehen auf den Stand vor dem Update zurück; Änderungen seither gehen verloren.',
          ]
        : []),
      '',
      'Gilt ab dem nächsten Start.',
    ].join('\n'),

  // Workspaces (ADR 0030)
  workspaces: 'Workspaces',
  workspacesHint:
    'Arbeite mit anderen Hangar-Instanzen über ein Relay zusammen. Das Relay leitet nur verschlüsselte Nachrichten weiter und sieht keine Inhalte.',
  thisInstance: 'Dieser Hangar',
  fingerprint: 'Fingerabdruck',
  relay: 'Relay',
  relayAddress: 'Relay-Adresse',
  relayConnect: 'Verbinden',
  relayStatus: {
    off: 'Nicht verbunden',
    connecting: 'Verbinde …',
    connected: 'Verbunden',
    error: 'Nicht verbunden',
  },
  relayMissing: 'Relay-Adresse fehlt.',
  relayInvalid: 'Die Adresse beginnt mit wss:// (ws:// nur für Tests auf diesem Rechner).',
  createWorkspace: 'Workspace anlegen',
  workspaceName: 'Name',
  operatorToken: 'Betreiber-Token',
  operatorTokenHint: 'Das Token, mit dem das Relay betrieben wird (HANGAR_RELAY_TOKEN).',
  create: 'Anlegen',
  joinWorkspace: 'Workspace beitreten',
  workspace: 'Workspace',
  inviteToken: 'Einladungs-Token',
  inviterFingerprint: 'Fingerabdruck des Einladenden',
  inviterFingerprintHint:
    'Lass ihn dir über einen anderen Weg bestätigen als das Token, etwa am Telefon.',
  join: 'Beitreten',
  workspaceNameMissing: 'Name fehlt.',
  workspaceNameInvalid:
    'Der Name beginnt mit Buchstabe oder Ziffer und enthält nur Buchstaben, Ziffern, Leerzeichen, Punkt, Unterstrich und Bindestrich, höchstens 64 Zeichen.',
  operatorTokenMissing: 'Betreiber-Token fehlt.',
  workspaceMissing: 'Workspace fehlt.',
  inviteTokenMissing: 'Einladungs-Token fehlt.',
  fingerprintMissing: 'Fingerabdruck fehlt.',
  fingerprintInvalid: 'Der Fingerabdruck hat 64 Zeichen aus 0–9 und a–f.',
  waitingForInviter: 'Wartet, bis der Einladende diesen Hangar aufnimmt.',
  members: 'Mitglieder',
  you: '(dieser Hangar)',
  removeMember: (name: string) => `${name} entfernen`,
  confirmRemoveMember: (name: string, workspace: string) =>
    `${name} aus „${workspace}“ entfernen? Diese Instanz kann danach nicht wieder beitreten.`,
  invitation: 'Einladung',
  wantsToJoin: (name: string) => `„${name}“ möchte beitreten. Vergleiche den Fingerabdruck:`,
  acceptMember: (name: string) => `Fingerabdruck stimmt – ${name} aufnehmen`,
  invitedBy: (name: string) => `${name} hat eingeladen und nimmt auf.`,
  rejectMember: (name: string) => `${name} ablehnen`,
  invite: 'Einladen',
  inviteHint:
    'Gib alle drei Angaben der Person, die beitreten soll. Das Token gilt einmal und sieben Tage.',
  sharedFunctions: 'Freigegebene Funktionen',
  sharedFunctionsHint: 'Diese Funktionen dürfen die anderen Instanzen des Workspaces aufrufen.',
  noRemoteFunctions: 'Keine Bay bietet Funktionen für andere Instanzen an.',
  relayErrors: {
    'Invalid operator token': 'Das Betreiber-Token stimmt nicht.',
    'Workspace exists': 'Diesen Workspace gibt es schon.',
    'Only the inviter can add this instance':
      'Nur wer eingeladen hat, kann diese Instanz aufnehmen.',
    'Invalid invitation': 'Die Einladung gilt nicht: falsch, schon benutzt oder abgelaufen.',
    'Relay not reachable': 'Das Relay ist nicht erreichbar.',
    'Relay connection closed': 'Die Verbindung zum Relay ist getrennt.',
    'The relay did not answer': 'Das Relay antwortet nicht.',
    'Invalid proof':
      'Das Relay hat die Anmeldung abgelehnt. Stimmt die Adresse mit HANGAR_RELAY_URL des Relays überein?',
    Revoked: 'Dieser Hangar wurde aus dem Workspace entfernt.',
    'Not connected to a relay': 'Nicht mit einem Relay verbunden.',
    'Too many open invitations': 'Zu viele offene Einladungen. Warte, bis welche benutzt sind.',
  } as Record<string, string>,

  // Tray
  open: 'Öffnen',
  quit: 'Beenden',
};

const en: typeof de = {
  bays: 'Bays',
  settings: 'Settings',
  badge: (bay, count) =>
    count === 1 ? `${bay}, 1 notification` : `${bay}, ${count} notifications`,
  noBay: 'No bay loaded.',
  addBay: 'Add to sidebar',
  allBaysAdded: 'Every bay is already in the sidebar.',
  shortcuts: 'Shortcuts',
  openShortcut: (name: string) => `Open ${name}`,
  pickFile: 'File or program …',
  pickFolder: 'Folder …',
  website: 'Website',
  websiteHint: 'Address with http:// or https://, e.g. https://example.com',
  addWebsite: 'Add website',
  invalidUrl: 'Only addresses with http:// or https:// work.',
  shortcutFailed: (name: string) => `“${name}” cannot be opened.`,
  removeBay: 'Remove from sidebar',
  moveUp: 'Move up',
  moveDown: 'Move down',
  cancel: 'Cancel',
  connectServer: 'Connect to server',
  serverName: 'Name',
  serverAddress: 'Address',
  serverAddressHint:
    'Over SSH: user@host:port with the port hangar-server listens on there, e.g. anna@homeserver:7420. Without SSH: 127.0.0.1:port.',
  next: 'Next',
  fingerprintHint: "The server's fingerprint. Compare it with the server's log.",
  pairingCode: 'Pairing code',
  pairingCodeHint: 'Shown in the server\'s log after "pairing code".',
  pair: 'Pair',
  nameMissing: 'Name is missing.',
  addressMissing: 'Address is missing.',
  invalidAddress: 'Invalid address: user@host:port or 127.0.0.1:port, port 1–65535.',
  unreachable: 'Server not reachable. Is hangar-server running there on this port?',
  sshFailed: (detail) =>
    `SSH connection failed (${detail}). Does ssh work in a terminal without a password prompt?`,
  codeMissing: 'Pairing code is missing.',
  wrongCode: 'Wrong pairing code.',
  pairingEnded: 'Pairing was cancelled. Please connect again.',
  serverStatus: {
    connecting: 'connecting',
    connected: 'connected',
    disconnected: 'disconnected',
    failed: 'failed',
  },
  server: (name, status) => `Server ${name}: ${status}`,
  remoteBay: (bay, server) => `${bay} (${server})`,
  versionMismatch: (server, local) => `Version does not match (server ${server}, here ${local})`,
  bayMissing: 'Bay missing here',
  connect: 'Connect',
  disconnect: 'Disconnect',
  removeServer: 'Remove server',
  themes: { system: 'System', light: 'Light', dark: 'Dark' },
  themeToggle: (current, next) => `Color scheme: ${current} (switch to ${next})`,

  overview: 'Hangar overview',
  name: 'Name',
  email: 'Email',
  notSet: 'not set',
  gitSetHint: 'Set it in a terminal:',
  gitMissing: 'Git is not installed or not on the PATH.',
  bayId: 'ID',
  version: 'Version',
  notLoaded: 'Not loaded',

  language: 'Language',
  languageSystem: 'System language',
  languageHint: 'Takes effect the next time Hangar starts.',
  updates: 'Updates',
  updatesHint: 'Hangar downloads updates in the background and installs them on the next restart.',
  baySettings: 'Bay settings',
  updateChannel: 'Update channel',
  channelStable: 'Stable',
  channelBeta: 'Beta',
  permissions: 'Permissions',
  permissionsHint:
    'Bays and their agents may always use their own functions. These are the permissions for access to other bays and to sensitive functions.',
  sensitive: 'sensitive',
  permissionsEmpty: 'No permissions yet. Hangar asks the first time a bay accesses another one.',
  showCaller: 'Show caller',
  allCallers: 'All',
  searchFunction: 'Search function',
  functionColumn: 'Function',
  modeColumn: 'Access',
  grantedAt: 'Granted',
  lastUsed: 'Last call',
  unknownTime: 'unknown',
  notUsed: 'not since start',
  sessionOnly: (session) => `session “${session}” only`,
  when: (iso) =>
    new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)),
  ruleTitle: 'Set a rule',
  caller: 'Caller',
  setRule: 'Set',
  modes: {
    allow: 'allowed',
    deny: 'denied',
    session: 'allowed for one session',
    ask: 'ask on every access',
  },
  revoke: 'Revoke',
  jobs: 'Jobs',
  jobsHint:
    'Scheduled tasks of the bays. They run while Hangar runs (also in the tray); a missed run is made up once after waking.',
  jobsEmpty: 'No jobs yet. Bays add them, e.g. the agent bay with “Schedule job” in a session.',
  job: 'Job',
  schedule: 'Schedule',
  nextRun: 'Next run',
  lastRun: 'Last run',
  result: 'Result',
  never: 'never',
  notRunYet: 'not run yet',
  bayNotLoaded: 'Bay not loaded',
  jobRunning: 'running',
  jobPaused: 'paused',
  runResult: (ok, ms, output) =>
    `${ok ? 'succeeded' : 'failed'} (${Math.round(ms / 1000)} s)${output ? `: ${output}` : ''}`,
  pause: 'Pause',
  resume: 'Resume',
  runNow: 'Run now',
  deleteJob: 'Delete',
  jobsHere: 'On this computer',
  jobsOnServer: (name) => `On the server “${name}”`,
  noJobs: 'No jobs.',

  callBySession: (bay, target) => `An agent in a session of “${bay}” wants to call “${target}”.`,
  callByBay: (bay, target) => `The bay “${bay}” wants to call “${target}”.`,
  callByLocalSession: (bay, target) =>
    `An agent in a session of “${bay}” on the local server wants to call “${target}”.`,
  callByLocalBay: (bay, target) =>
    `The bay “${bay}” on the local server wants to call “${target}”.`,
  callByRemote: (instance, workspace, bay, target) =>
    `The instance “${instance}” in the workspace “${workspace}” wants to call “${target}” through the bay “${bay}”.`,
  onServer: (server) => `On the server “${server}”:`,
  localServer: 'Local server',
  localServerDown: 'Local server is not running',
  localServerSwitch: 'Run agents in the local server',
  localServerSwitchHint:
    'Shells and agents keep running when Hangar quits, crashes or updates. If you share projects in workspaces, turn this off for now.',
  localServerOffConfirm:
    'At the next start the shells of the local server end; the agents move back into Hangar with their data. Turn off?',
  afterRelaunch: 'Takes effect after Hangar restarts.',
  localServerForced: 'Set by HANGAR_LOCAL_SERVER.',
  relaunch: 'Restart Hangar',
  localServerStarting: 'Local server is starting …',
  localBay: (bay, status) => `${bay} (${status})`,
  restartLocalServer: 'Restart local server',
  restartLocalServerMenu: 'Restart local server …',
  restartLocalServerTitle: 'Restart the local server?',
  restartLocalServerDetail: (n) =>
    n === undefined
      ? 'Running shells end; their history stays.'
      : n === 1
        ? 'One running shell ends; its history stays.'
        : `${n} running shells end; their history stays.`,
  restartLocalServerFailed: 'The local server could not be restarted',
  noKeychain: 'No keychain available: passwords are never stored as plain text',
  workspacesUnavailable: 'Workspaces not available: Hangar starts without them',
  restart: 'Restart',
  openLog: 'Open log',
  localServerShells: (n) =>
    n === 1 ? 'Local server: 1 shell running' : `Local server: ${n} shells running`,
  localServerDownHint:
    'The agents and their shells run in the local server. Restarting starts it and restores the sessions.',
  updateHint: 'New version',
  updateReady: (running, ready) =>
    `New version ready: the local server runs Hangar ${running}, ${ready} is installed.`,
  decisionSaved: 'The decision will be saved.',
  confirmTitle: 'Confirm access',
  allowTitle: 'Allow access?',
  sensitiveTitle: 'Access to a sensitive function',
  allow: 'Allow',
  deny: 'Deny',
  allowAlways: 'Always allow',
  allowSession: 'For this session',
  allowOnce: 'Only this time',
  askEveryTime: 'Ask on every access',
  // Installed bays (ADR 0034)
  installBays: 'Install bays',
  installBaysHint:
    'From the bay index, after checking the signature. New versions run from the next start of Hangar.',
  noBayIndex: 'No bay index set up.',
  noBaysInIndex: 'The index contains no bays.',
  notInstalled: 'Not installed',
  installedVersion: (version: string) => `Installed: ${version}`,
  nextStartVersion: (version: string) => `From the next start: ${version}`,
  installBay: (version: string) => `Install ${version}`,
  updateBay: (version: string) => `Update to ${version}`,
  rollbackBay: (version: string) => `Roll back to ${version}`,
  bayActionFailed: (message: string) => `Failed: ${message}`,
  confirmInstall: (p: PreparedBay) =>
    [
      `Install ${p.name} ${p.version}?`,
      '',
      ...rights(p, {
        functions: 'New functions',
        uses: 'Newly calls',
        agentSessions: 'Starts agent sessions with their own access',
        hostModules: 'New capabilities',
        sensitive: 'Now sensitive, asks again',
        none: 'No new permissions.',
        data: 'The data format changes; Hangar backs the data up first.',
      }),
      '',
      'The new version runs from the next start.',
    ].join('\n'),
  confirmRollback: (id: string, version: string, losesData: boolean) =>
    [
      `Roll ${id} back to ${version}?`,
      ...(losesData
        ? ['', 'The data goes back to its state before the update; changes since then are lost.']
        : []),
      '',
      'Takes effect from the next start.',
    ].join('\n'),

  // Workspaces (ADR 0030)
  workspaces: 'Workspaces',
  workspacesHint:
    'Work with other Hangar instances through a relay. The relay only forwards encrypted messages and sees no content.',
  thisInstance: 'This Hangar',
  fingerprint: 'Fingerprint',
  relay: 'Relay',
  relayAddress: 'Relay address',
  relayConnect: 'Connect',
  relayStatus: {
    off: 'Not connected',
    connecting: 'Connecting …',
    connected: 'Connected',
    error: 'Not connected',
  },
  relayMissing: 'Relay address is missing.',
  relayInvalid: 'The address starts with wss:// (ws:// only for tests on this computer).',
  createWorkspace: 'Create workspace',
  workspaceName: 'Name',
  operatorToken: 'Operator token',
  operatorTokenHint: 'The token the relay runs with (HANGAR_RELAY_TOKEN).',
  create: 'Create',
  joinWorkspace: 'Join workspace',
  workspace: 'Workspace',
  inviteToken: 'Invitation token',
  inviterFingerprint: "Inviter's fingerprint",
  inviterFingerprintHint: 'Have it confirmed another way than the token, e.g. on the phone.',
  join: 'Join',
  workspaceNameMissing: 'Name is missing.',
  workspaceNameInvalid:
    'The name starts with a letter or digit and contains only letters, digits, spaces, dot, underscore and hyphen, at most 64 characters.',
  operatorTokenMissing: 'Operator token is missing.',
  workspaceMissing: 'Workspace is missing.',
  inviteTokenMissing: 'Invitation token is missing.',
  fingerprintMissing: 'Fingerprint is missing.',
  fingerprintInvalid: 'The fingerprint has 64 characters of 0–9 and a–f.',
  waitingForInviter: 'Waiting for the inviter to add this Hangar.',
  members: 'Members',
  you: '(this Hangar)',
  removeMember: (name: string) => `Remove ${name}`,
  confirmRemoveMember: (name: string, workspace: string) =>
    `Remove ${name} from “${workspace}”? This instance cannot join again afterwards.`,
  invitation: 'Invitation',
  wantsToJoin: (name: string) => `“${name}” wants to join. Compare the fingerprint:`,
  acceptMember: (name: string) => `Fingerprint matches – add ${name}`,
  invitedBy: (name: string) => `${name} invited and adds it.`,
  rejectMember: (name: string) => `Refuse ${name}`,
  invite: 'Invite',
  inviteHint:
    'Give all three to the person who should join. The token works once and for seven days.',
  sharedFunctions: 'Shared functions',
  sharedFunctionsHint: 'The other instances of the workspace may call these functions.',
  noRemoteFunctions: 'No bay offers functions to other instances.',
  relayErrors: {
    'Invalid operator token': 'The operator token is wrong.',
    'Workspace exists': 'This workspace exists already.',
    'Only the inviter can add this instance': 'Only the member who invited can add this instance.',
    'Invalid invitation': 'The invitation is not valid: wrong, used already or expired.',
    'Relay not reachable': 'The relay cannot be reached.',
    'Relay connection closed': 'The connection to the relay is closed.',
    'The relay did not answer': 'The relay does not answer.',
    'Invalid proof':
      "The relay refused the login. Does the address match the relay's HANGAR_RELAY_URL?",
    Revoked: 'This Hangar was removed from the workspace.',
    'Not connected to a relay': 'Not connected to a relay.',
    'Too many open invitations': 'Too many open invitations. Wait until some are used.',
  } as Record<string, string>,

  open: 'Open',
  quit: 'Quit',
};

/** Texts in the app language; German until `setLocale` runs (and in unit tests). */
export let t = de;

/** Called once at startup: by the main process and by the shell renderer. */
export function setLocale(locale: UiLocale): void {
  t = catalogFor({ de, en }, locale);
}
