// Texts of the browser bay UI, see ADR 0009.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  tabs: 'Tabs',
  newTab: 'Neuer Tab',
  closeTab: (title: string) => `Tab ${title} schließen`,
  agentTab: 'Agent',
  agentTabHint: 'Von einem Agent geöffnet, mit eigenen Cookies',
  untitled: 'Neuer Tab',
  back: 'Zurück',
  forward: 'Vorwärts',
  reload: 'Neu laden',
  resetZoom: (zoom: number) => `${zoom} % – Zoom auf 100 % zurücksetzen`,
  address: 'Adresse',
  open: 'Öffnen',
  addressMissing: 'Adresse eingeben.',
  addressInvalid: 'Nur http- und https-Adressen lassen sich öffnen.',
  loading: 'Lädt …',
  loadFailed: (error: string) => `Laden fehlgeschlagen: ${error}`,
  empty: 'Kein Tab offen. Adresse eingeben, um eine Seite zu öffnen.',
};

const en: typeof de = {
  tabs: 'Tabs',
  newTab: 'New tab',
  closeTab: (title) => `Close tab ${title}`,
  agentTab: 'Agent',
  agentTabHint: 'Opened by an agent, with its own cookies',
  untitled: 'New tab',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  resetZoom: (zoom) => `${zoom} % – reset zoom to 100 %`,
  address: 'Address',
  open: 'Open',
  addressMissing: 'Enter an address.',
  addressInvalid: 'Only http and https addresses can be opened.',
  loading: 'Loading …',
  loadFailed: (error) => `Loading failed: ${error}`,
  empty: 'No tab open. Enter an address to open a page.',
};

/** Texts in the app language; German until `setLocale` runs (and in unit tests). */
export let t = de;

/** Called once at startup with `window.hangar.locale`. */
export function setLocale(locale: UiLocale): void {
  t = catalogFor({ de, en }, locale);
}
