// Texts of the secrets bay UI, see ADR 0009.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  title: 'Passwörter',
  intro:
    'Gespeichert im Schlüsselbund des Systems. Agents bekommen ein Passwort nur als Umgebungsvariable ihrer Shell, wenn ein Projekt oder eine Session in der Agent-Bay darauf verweist.',
  add: 'Neues Passwort',
  name: 'Name',
  nameHint: 'Name der Umgebungsvariable, z. B. GITHUB_TOKEN',
  value: 'Wert',
  newValue: (name: string) => `Neuer Wert für ${name}`,
  description: 'Beschreibung',
  save: 'Speichern',
  saved: (name: string) => `${name} gespeichert`,
  replace: 'Wert ersetzen',
  cancel: 'Abbrechen',
  remove: 'Löschen',
  removeLabel: (name: string) => `${name} löschen`,
  replaceLabel: (name: string) => `Wert ersetzen: ${name}`,
  confirmRemove: (name: string) =>
    `${name} löschen? Shells, die darauf verweisen, starten danach nicht mehr.`,
  nameMissing: 'Name fehlt',
  valueMissing: 'Wert fehlt',
  empty: 'Noch keine Passwörter gespeichert.',
  changed: (date: string) => `geändert ${date}`,
};

const en: typeof de = {
  title: 'Passwords',
  intro:
    'Stored in the system keychain. Agents get a password only as an environment variable of their shell, when a project or session in the agent bay refers to it.',
  add: 'New password',
  name: 'Name',
  nameHint: 'Name of the environment variable, e.g. GITHUB_TOKEN',
  value: 'Value',
  newValue: (name) => `New value for ${name}`,
  description: 'Description',
  save: 'Save',
  saved: (name) => `${name} saved`,
  replace: 'Replace value',
  cancel: 'Cancel',
  remove: 'Delete',
  removeLabel: (name) => `Delete ${name}`,
  replaceLabel: (name) => `Replace value: ${name}`,
  confirmRemove: (name) => `Delete ${name}? Shells that refer to it will no longer start.`,
  nameMissing: 'Name missing',
  valueMissing: 'Value missing',
  empty: 'No passwords stored yet.',
  changed: (date) => `changed ${date}`,
};

export let t = de;
export const setLocale = (locale: UiLocale) => void (t = catalogFor({ de, en }, locale));
