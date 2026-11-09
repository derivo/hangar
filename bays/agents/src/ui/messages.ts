// Texts of the agent bay UI, see ADR 0009.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';
import type { SessionRecord } from '../main/types';

const de = {
  // Status: full label (light, session header) and short form (tile, overview)
  status: {
    working: 'arbeitet',
    waiting: 'wartet auf Eingabe',
    background: 'wartet auf Hintergrund',
    done: 'fertig',
    idle: 'inaktiv',
  },
  shortStatus: {
    working: 'arbeitet',
    waiting: 'wartet',
    background: 'Hintergrund',
    done: 'fertig',
    idle: 'inaktiv',
  },

  // Project tree
  tree: 'Projekte und Sessions',
  projects: 'Projekte',
  collapseTree: 'Projektleiste einklappen',
  expandTree: 'Projektleiste ausklappen',
  addProject: 'Projekt hinzufügen',
  pathOn: (server: string) => `Pfad auf ${server}`,
  enterPath: 'Pfad eingeben',
  add: 'Hinzufügen',
  noProject: 'Noch kein Projekt.',
  newSession: 'Neue Session',
  newSessionIn: (project: string) => `Neue Session in ${project}`,
  hideSessions: (project: string) => `Sessions von ${project} ausblenden`,
  showSessions: (project: string) => `Sessions von ${project} einblenden`,
  projectFolder: 'Projektordner',
  removeProject: 'Projekt entfernen',
  moveProjectUp: 'Projekt nach oben',
  moveProjectDown: 'Projekt nach unten',
  moveSessionUp: (name: string) => `Session ${name} nach oben`,
  moveSessionDown: (name: string) => `Session ${name} nach unten`,
  confirmRemoveProject: 'Projekt entfernen? Alle Sessions des Projekts werden geschlossen.',
  overview: 'Übersicht',
  sessions: 'Sessions',

  // Project overview
  pathLabel: 'Pfad',
  refresh: 'Aktualisieren',
  statusColumn: 'Status',
  changes: 'Änderungen',
  newCommits: 'Neue Commits',
  gitHint:
    'Änderungen: nicht committete Dateien im Worktree. Neue Commits: Commits, die der Haupt-Checkout noch nicht hat.',
  files: (n: number) => (n === 0 ? 'keine' : n === 1 ? '1 Datei' : `${n} Dateien`),
  count: (n: number) => (n === 0 ? 'keine' : String(n)),
  unknown: 'unbekannt',
  noSessions: 'Noch keine Session.',
  closeSessionNamed: (name: string) => `Session ${name} schließen`,
  orphans: 'Verwaiste Branches',
  orphansHint: 'Branches geschlossener Sessions. Löschen entfernt den Branch samt seiner Commits.',
  noOrphans: 'Keine verwaisten Branches.',
  deleteBranch: 'Löschen',
  deleteBranchNamed: (branch: string) => `Branch ${branch} löschen`,
  confirmDeleteBranch: (branch: string, ahead: number) =>
    ahead === 0
      ? `Branch ${branch} löschen?`
      : ahead === 1
        ? `Branch ${branch} löschen? 1 Commit, den der Haupt-Checkout nicht hat, geht verloren.`
        : `Branch ${branch} löschen? ${ahead} Commits, die der Haupt-Checkout nicht hat, gehen verloren.`,
  share: 'In Workspaces teilen',
  shareHint:
    'Andere Instanzen deiner Workspaces sehen die Sessions dieses Projekts mit Branch, Beschreibung und Status.',
  remote: 'Andere Instanzen',
  remoteOrigin: (project: string, instance: string, workspace: string) =>
    `${project} – ${instance} (${workspace})`,
  noRemoteSessions: 'Keine Sessions',
  projectEnv: 'Umgebungsvariablen für neue Sessions',
  projectEnvHint:
    'Eine pro Zeile, KEY=Wert. Neue Sessions starten mit diesen Werten, eigene Werte einer Session gehen vor. Bestehende Sessions bleiben unverändert.',
  save: 'Speichern',

  // Main area
  hintNoProject: 'Füge mit „+“ neben „Projekte“ ein Git-Repository hinzu.',
  hintSelect: 'Wähle links eine Session oder starte eine mit „+“ neben einem Projekt.',
  dismiss: 'Meldung schließen',
  addField: 'Feld hinzufügen',
  field: (n: number) => `Feld ${n}`,
  closeField: 'Feld schließen',
  undock: 'Abdocken',
  dock: 'Andocken',
  bringBack: 'Zurückholen',
  undocked: (name: string) => `„${name}“ ist abgedockt und läuft in einem eigenen Fenster.`,
  gridFull: (columns: number, rows: number) =>
    `Kein Platz für ein weiteres Feld: Jedes Terminal braucht mindestens ${columns} × ${rows} Zeichen.`,

  // Session
  session: 'Session',
  // Context menu of a session in the project tree
  menu: {
    describe: 'Beschreibung ändern…',
    up: 'Nach oben',
    down: 'Nach unten',
    window: 'In eigenem Fenster öffnen',
    job: 'Job planen…',
    env: 'Umgebungsvariablen…',
    copyPath: 'Pfad kopieren',
    restart: 'Shell neu starten',
    close: 'Session schließen…',
  },
  description: 'Beschreibung',
  envVars: 'Umgebungsvariablen',
  tabColor: 'Farbe',
  copyOnSelect: 'Markieren kopiert',
  copied: 'In die Zwischenablage kopiert',
  openLink: (uri: string) => `Link öffnen?\n\n${uri}`,
  colors: {
    none: 'Keine',
    red: 'Rot',
    orange: 'Orange',
    yellow: 'Gelb',
    green: 'Grün',
    teal: 'Türkis',
    blue: 'Blau',
    violet: 'Violett',
    pink: 'Pink',
  },
  closeSession: 'Session schließen',
  confirmCloseSession: 'Session schließen? Ein Worktree mit Änderungen bleibt erhalten.',
  sessionData: 'Session-Daten',
  project: 'Projekt',
  branch: 'Branch',
  ports: 'Ports',
  envEditor: 'Umgebungsvariablen (eine pro Zeile, KEY=Wert)',
  secretsAvailable: (names: string) => `Aus Passwörtern: KEY=@secret:NAME. Gespeichert: ${names}`,
  secretsEmpty: 'Aus Passwörtern: KEY=@secret:NAME. Noch keine Passwörter gespeichert.',
  secretsMissing: 'Passwörter: Bay „Passwörter“ in der Leiste hinzufügen, dann KEY=@secret:NAME.',
  saveEnv: 'Speichern und Shell neu starten',
  cancel: 'Abbrechen',
  scheduleJob: 'Job planen',
  jobCommand: 'Befehl',
  jobSchedule: 'Zeitplan (Cron)',
  jobScheduleHint:
    'Minute Stunde Tag Monat Wochentag in Ortszeit, z. B. 0 2 * * 1-5 für werktags um 2 Uhr',
  addJob: 'Job anlegen',
  jobAdded: 'Job angelegt. Alle Jobs stehen in den Einstellungen unter „Jobs“.',
  envLineWithoutEquals: (line: string) => `Zeile ohne "=": ${line}`,
  shellEnded: 'Shell beendet.',
  handoverFrom: (from: string) => `Übergabe von ${from}`,
  handoverTask: 'Auftrag',
  handoverContext: 'Kontext',
  handoverRemote:
    'Von einer anderen Instanz: nur Text. Prüfe Branch und Remote, bevor du etwas holst.',
  restart: 'Neu starten',
  statusbar: 'Statusleiste',
  quotas: 'Kontingente',
  quotaLeft: (percent: number) => `${percent} % frei`,
  quotaReset: (at: Date) =>
    `Reset ${at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`,
  quotaResetDate: (at: Date) =>
    `Reset ${at.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '')}`,
};

const en: typeof de = {
  status: {
    working: 'working',
    waiting: 'waiting for input',
    background: 'waiting on background',
    done: 'done',
    idle: 'idle',
  },
  shortStatus: {
    working: 'working',
    waiting: 'waiting',
    background: 'background',
    done: 'done',
    idle: 'idle',
  },

  tree: 'Projects and sessions',
  projects: 'Projects',
  collapseTree: 'Collapse project bar',
  expandTree: 'Expand project bar',
  addProject: 'Add project',
  pathOn: (server) => `Path on ${server}`,
  enterPath: 'Enter a path',
  add: 'Add',
  noProject: 'No project yet.',
  newSession: 'New session',
  newSessionIn: (project) => `New session in ${project}`,
  hideSessions: (project) => `Hide sessions of ${project}`,
  showSessions: (project) => `Show sessions of ${project}`,
  projectFolder: 'Project folder',
  removeProject: 'Remove project',
  moveProjectUp: 'Move project up',
  moveProjectDown: 'Move project down',
  moveSessionUp: (name) => `Move session ${name} up`,
  moveSessionDown: (name) => `Move session ${name} down`,
  confirmRemoveProject: 'Remove project? All sessions of the project will be closed.',
  overview: 'Overview',
  sessions: 'Sessions',

  pathLabel: 'Path',
  refresh: 'Refresh',
  statusColumn: 'Status',
  changes: 'Changes',
  newCommits: 'New commits',
  gitHint:
    'Changes: uncommitted files in the worktree. New commits: commits the main checkout does not have yet.',
  files: (n) => (n === 0 ? 'none' : n === 1 ? '1 file' : `${n} files`),
  count: (n) => (n === 0 ? 'none' : String(n)),
  unknown: 'unknown',
  noSessions: 'No session yet.',
  closeSessionNamed: (name) => `Close session ${name}`,
  orphans: 'Orphaned branches',
  orphansHint: 'Branches of closed sessions. Deleting removes the branch with its commits.',
  noOrphans: 'No orphaned branches.',
  deleteBranch: 'Delete',
  deleteBranchNamed: (branch) => `Delete branch ${branch}`,
  confirmDeleteBranch: (branch, ahead) =>
    ahead === 0
      ? `Delete branch ${branch}?`
      : ahead === 1
        ? `Delete branch ${branch}? 1 commit the main checkout does not have will be lost.`
        : `Delete branch ${branch}? ${ahead} commits the main checkout does not have will be lost.`,
  share: 'Share in workspaces',
  shareHint:
    'Other instances in your workspaces see this project’s sessions with branch, description and status.',
  remote: 'Other instances',
  remoteOrigin: (project: string, instance: string, workspace: string) =>
    `${project} – ${instance} (${workspace})`,
  noRemoteSessions: 'No sessions',
  projectEnv: 'Env vars for new sessions',
  projectEnvHint:
    'One per line, KEY=value. New sessions start with these values; a session’s own values take precedence. Existing sessions stay unchanged.',
  save: 'Save',

  hintNoProject: 'Add a Git repository with “+” next to “Projects”.',
  hintSelect: 'Select a session on the left or start one with “+” next to a project.',
  dismiss: 'Dismiss message',
  addField: 'Add field',
  field: (n: number) => `Field ${n}`,
  closeField: 'Close field',
  undock: 'Undock',
  dock: 'Dock',
  bringBack: 'Bring back',
  undocked: (name: string) => `“${name}” is undocked and runs in its own window.`,
  gridFull: (columns: number, rows: number) =>
    `No room for another field: every terminal needs at least ${columns} × ${rows} characters.`,

  session: 'Session',
  menu: {
    describe: 'Change description…',
    up: 'Move up',
    down: 'Move down',
    window: 'Open in its own window',
    job: 'Schedule job…',
    env: 'Environment variables…',
    copyPath: 'Copy path',
    restart: 'Restart shell',
    close: 'Close session…',
  },
  description: 'Description',
  envVars: 'Environment variables',
  tabColor: 'Color',
  copyOnSelect: 'Selecting copies',
  copied: 'Copied to the clipboard',
  openLink: (uri) => `Open link?\n\n${uri}`,
  colors: {
    none: 'None',
    red: 'Red',
    orange: 'Orange',
    yellow: 'Yellow',
    green: 'Green',
    teal: 'Teal',
    blue: 'Blue',
    violet: 'Violet',
    pink: 'Pink',
  },
  closeSession: 'Close session',
  confirmCloseSession: 'Close session? A worktree with changes is kept.',
  sessionData: 'Session details',
  project: 'Project',
  branch: 'Branch',
  ports: 'Ports',
  envEditor: 'Environment variables (one per line, KEY=value)',
  secretsAvailable: (names) => `From passwords: KEY=@secret:NAME. Stored: ${names}`,
  secretsEmpty: 'From passwords: KEY=@secret:NAME. No passwords stored yet.',
  secretsMissing: 'Passwords: add the bay “Passwords” in the sidebar, then KEY=@secret:NAME.',
  saveEnv: 'Save and restart shell',
  cancel: 'Cancel',
  scheduleJob: 'Schedule job',
  jobCommand: 'Command',
  jobSchedule: 'Schedule (cron)',
  jobScheduleHint:
    'Minute hour day month weekday in local time, e.g. 0 2 * * 1-5 for weekdays at 2 am',
  addJob: 'Add job',
  jobAdded: 'Job added. All jobs are listed in the settings under “Jobs”.',
  envLineWithoutEquals: (line) => `Line without "=": ${line}`,
  shellEnded: 'Shell ended.',
  handoverFrom: (from) => `Handover from ${from}`,
  handoverTask: 'Task',
  handoverContext: 'Context',
  handoverRemote:
    'From another instance: text only. Check branch and remote before you fetch anything.',
  restart: 'Restart',
  statusbar: 'Status bar',
  quotas: 'Usage limits',
  quotaLeft: (percent) => `${percent}% left`,
  quotaReset: (at) =>
    `resets ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
  quotaResetDate: (at) =>
    `resets ${at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '')}`,
};

/** Texts in the app language; German until `setLocale` runs (and in unit tests). */
export let t = de;

/** Branch of a session, or „Projektordner“ for one without a worktree (ADR 0022). */
export const branchOf = (s: Pick<SessionRecord, 'branch' | 'place'>) =>
  s.place === 'project' ? t.projectFolder : s.branch;

/** Name of a session: its description, else its branch, else its short id (ADR 0022). */
export const sessionName = (s: Pick<SessionRecord, 'id' | 'description' | 'branch'>) =>
  s.description || s.branch || s.id.slice(0, 8);

/** Called once at startup with `window.hangar.locale`. */
export function setLocale(locale: UiLocale): void {
  t = catalogFor({ de, en }, locale);
}
