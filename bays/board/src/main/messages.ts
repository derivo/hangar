// Errors of the board for people (its UI), see ADR 0009; bus errors stay English.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  titleMissing: 'Titel fehlt',
  titleTooLong: 'Titel zu lang (höchstens 200 Zeichen)',
  descriptionTooLong: 'Beschreibung zu lang (höchstens 4000 Zeichen)',
};

const en: typeof de = {
  titleMissing: 'Title missing',
  titleTooLong: 'Title too long (at most 200 characters)',
  descriptionTooLong: 'Description too long (at most 4000 characters)',
};

export const messages = (locale: UiLocale) => catalogFor({ de, en }, locale);
