// Errors of the feeds bay for people (its UI), see ADR 0009; bus errors stay English.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  invalidUrl: 'Ungültige Feed-URL (nur http und https)',
  exists: 'Feed ist schon abonniert',
  interval: 'Abruf-Intervall: ganze Zahl von 1 bis 1440 Minuten',
  maxItems: 'Verlauf: ganze Zahl von 100 bis 10000 Einträgen',
};

const en: typeof de = {
  invalidUrl: 'Invalid feed URL (http and https only)',
  exists: 'Feed is already subscribed',
  interval: 'Fetch interval: whole number from 1 to 1440 minutes',
  maxItems: 'History: whole number from 100 to 10000 entries',
};

export const messages = (locale: UiLocale) => catalogFor({ de, en }, locale);
