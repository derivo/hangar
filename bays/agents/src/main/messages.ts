// Texts of the agent bay's main part for people (UI errors, notifications), see ADR 0009.
// Errors of bus functions (functions.ts) are read by agents and stay English.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  addProject: 'Projekt hinzufügen',
  waitingTitle: 'Session wartet auf Eingabe',
  restarted: 'Hangar neu gestartet',
  stateCorrupt: 'Zustand der Agent-Bay war beschädigt',
  backedUpAs: (file: string) => `Gesichert als ${file}`,
  shellFailed: (reason: string) => `Shell konnte nicht starten: ${reason}`,
  projectExists: (path: string) => `Projekt ist bereits hinzugefügt: ${path}`,
  notARepository: (path: string) => `Kein Git-Repository: ${path}`,
  noFreePort: 'Kein freier Port für die Session gefunden',
  shuttingDown: 'Agent-Bay wird beendet',
  symlink: (path: string) =>
    `${path} ist ein symbolischer Link; Hangar schreibt dort nicht hinein.`,
  unknownProject: (id: string) => `Unbekanntes Projekt: ${id}`,
  invalidIndex: 'Ungültige Position',
  notOrphan: (branch: string) => `Kein verwaister Hangar-Branch: ${branch}`,
  unknownSession: (id: string) => `Unbekannte Session: ${id}`,
  invalidEnvName: (key: string) => `Ungültiger Variablenname: ${key}`,
  reservedEnvName: (key: string) => `Variable ist reserviert: ${key}`,
  envValueNotText: (key: string) => `Wert von ${key} muss Text sein`,
  shellNotRunning: 'Die Shell der Session läuft nicht',
  shellNotStarted: (reason: string) => `Shell nicht gestartet: ${reason}`,
  noSecretsBay: 'Passwörter nicht erreichbar',
  commandMissing: 'Befehl fehlt',
  scheduleMissing: 'Zeitplan fehlt',
  invalidSchedule: (schedule: string) =>
    `Ungültiger Zeitplan „${schedule}“: fünf Felder (Minute Stunde Tag Monat Wochentag), z. B. 0 2 * * 1-5`,
  jobResult: (exitCode: number, lastLine: string) =>
    `Exit-Code ${exitCode}${lastLine ? `: ${lastLine}` : ''}`,
  jobTimedOut: (minutes: number) => `Abgebrochen: länger als ${minutes} min`,
  jobStopped: 'Job abgebrochen',
};

const en: typeof de = {
  addProject: 'Add project',
  waitingTitle: 'Session is waiting for input',
  restarted: 'Hangar restarted',
  stateCorrupt: 'The agent bay state was corrupted',
  backedUpAs: (file) => `Backed up as ${file}`,
  shellFailed: (reason) => `Shell could not start: ${reason}`,
  projectExists: (path) => `Project is already added: ${path}`,
  notARepository: (path) => `Not a Git repository: ${path}`,
  noFreePort: 'No free port found for the session',
  shuttingDown: 'Agent bay is shutting down',
  symlink: (path) => `${path} is a symbolic link; Hangar does not write into it.`,
  unknownProject: (id) => `Unknown project: ${id}`,
  invalidIndex: 'Invalid position',
  notOrphan: (branch) => `Not an orphaned Hangar branch: ${branch}`,
  unknownSession: (id) => `Unknown session: ${id}`,
  invalidEnvName: (key) => `Invalid variable name: ${key}`,
  reservedEnvName: (key) => `Variable is reserved: ${key}`,
  envValueNotText: (key) => `Value of ${key} must be text`,
  shellNotRunning: "The session's shell is not running",
  shellNotStarted: (reason) => `Shell not started: ${reason}`,
  noSecretsBay: 'Passwords not reachable',
  commandMissing: 'Command is missing',
  scheduleMissing: 'Schedule is missing',
  invalidSchedule: (schedule) =>
    `Invalid schedule “${schedule}”: five fields (minute hour day month weekday), e.g. 0 2 * * 1-5`,
  jobResult: (exitCode, lastLine) => `Exit code ${exitCode}${lastLine ? `: ${lastLine}` : ''}`,
  jobTimedOut: (minutes) => `Stopped: longer than ${minutes} min`,
  jobStopped: 'Job stopped',
};

/** Texts in the app language; German until `setLocale` runs (and in unit tests). */
export let t = de;

/** Called in `activate` with `ctx.locale` and on every `ctx.onLocaleChange`. */
export function setLocale(locale: UiLocale): void {
  t = catalogFor({ de, en }, locale);
}
