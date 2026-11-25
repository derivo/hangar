// Texts of the proxy UI, see ADR 0009.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  title: 'Proxy',
  engine: 'Proxy-Engine',
  states: {
    stopped: 'Gestoppt – startet mit der ersten beobachteten Session',
    starting: 'Startet …',
    running: 'Läuft',
    restarting: 'Startet neu',
    failed: 'Fehler',
  },
  version: (v: string) => `mitmproxy ${v}`,
};

const en: typeof de = {
  title: 'Proxy',
  engine: 'Proxy engine',
  states: {
    stopped: 'Stopped – starts with the first watched session',
    starting: 'Starting …',
    running: 'Running',
    restarting: 'Restarting',
    failed: 'Failed',
  },
  version: (v) => `mitmproxy ${v}`,
};

export let t = de;
export const setLocale = (locale: UiLocale) => void (t = catalogFor({ de, en }, locale));
