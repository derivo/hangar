// Errors of the secrets bay for people (its UI), see ADR 0009; bus errors stay English.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  invalidName: (name: string) => `Ungültiger Name: ${name} (Buchstaben, Ziffern, _)`,
  reservedName: (name: string) => `${name} ist für Hangar reserviert`,
  valueMissing: 'Wert fehlt',
  descriptionTooLong: 'Beschreibung zu lang (höchstens 200 Zeichen)',
  noKeychain: 'Kein Schlüsselbund verfügbar: Passwörter werden nicht im Klartext gespeichert',
};

const en: typeof de = {
  invalidName: (name) => `Invalid name: ${name} (letters, digits, _)`,
  reservedName: (name) => `${name} is reserved for Hangar`,
  valueMissing: 'Value missing',
  descriptionTooLong: 'Description too long (at most 200 characters)',
  noKeychain: 'No keychain available: passwords are never stored as plain text',
};

export const messages = (locale: UiLocale) => catalogFor({ de, en }, locale);
