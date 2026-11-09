// Texts of the feeds UI, see ADR 0009.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  title: 'Feeds',
  subscribe: 'Feed abonnieren',
  url: 'Feed-URL',
  add: 'Abonnieren',
  refresh: 'Aktualisieren',
  subscriptions: 'Abonnements',
  history: 'Verlauf',
  remove: (title: string) => `${title} abbestellen`,
  failed: (title: string, error: string) => `${title}: ${error}`,
  empty: 'Noch keine Feeds. Trage oben die URL eines RSS- oder Atom-Feeds ein.',
  noItems: 'Noch keine Einträge.',
  notAFeed: 'Kein RSS- oder Atom-Feed',
  hint: 'Agents lesen und abonnieren Feeds über MCP (feed.list, feed.add, feed.items).',
  settings: 'Einstellungen',
  settingsForm: 'Feed-Einstellungen',
  fetching: 'Abruf',
  interval: 'Abruf-Intervall (Minuten)',
  intervalHint: '1 bis 1440. Hangar ruft alle Feeds in diesem Abstand ab.',
  maxItems: 'Einträge im Verlauf',
  maxItemsHint: '100 bis 10000. Ältere Einträge fallen heraus.',
  save: 'Speichern',
  cancel: 'Abbrechen',
};

const en: typeof de = {
  title: 'Feeds',
  subscribe: 'Subscribe to a feed',
  url: 'Feed URL',
  add: 'Subscribe',
  refresh: 'Refresh',
  subscriptions: 'Subscriptions',
  history: 'History',
  remove: (title) => `Unsubscribe from ${title}`,
  failed: (title, error) => `${title}: ${error}`,
  empty: 'No feeds yet. Enter the URL of an RSS or Atom feed above.',
  noItems: 'No entries yet.',
  notAFeed: 'Not an RSS or Atom feed',
  hint: 'Agents read and subscribe to feeds through MCP (feed.list, feed.add, feed.items).',
  settings: 'Settings',
  settingsForm: 'Feed settings',
  fetching: 'Fetching',
  interval: 'Fetch interval (minutes)',
  intervalHint: '1 to 1440. Hangar fetches all feeds at this interval.',
  maxItems: 'Entries in the history',
  maxItemsHint: '100 to 10000. Older entries drop out.',
  save: 'Save',
  cancel: 'Cancel',
};

export let t = de;
export const setLocale = (locale: UiLocale) => void (t = catalogFor({ de, en }, locale));
