import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BayManifest, SettingValue } from '@hangar/sdk';
import { isUiLocale, resolveLocale, type Locale, type UiLocale } from '@hangar/sdk/i18n';
import { validShortcuts, type Shortcut } from './shortcuts';

export type UpdateChannel = 'stable' | 'beta';

/** `system` follows the system language (German if preferred, otherwise English). */
export type LanguageSetting = 'system' | Locale;

/** `system` follows the operating system's light or dark mode. */
export type ThemeSetting = 'system' | 'light' | 'dark';

/** App-wide settings (`<userData>/settings.json`). */
export interface AppSettings {
  updateChannel: UpdateChannel;
  language: LanguageSetting;
  theme: ThemeSetting;
  /** Ids of the bays in the sidebar, in order; only these run (ADR 0017). */
  bays: string[];
  /** Values of the settings bays declare in their manifest, by bay id and key (ADR 0023). */
  baySettings: Record<string, Record<string, SettingValue>>;
  /** Programs, folders, files and websites in the sidebar, in order (ADR 0027). */
  shortcuts: Shortcut[];
  /** The agent bay in the local server (ADR 0036); unset: the default of the platform. */
  localServer?: boolean;
}

const DEFAULTS: AppSettings = {
  updateChannel: 'stable',
  language: 'system',
  theme: 'system',
  bays: [],
  baySettings: {},
  shortcuts: [],
};

/** A valid color scheme, otherwise `system`. */
export const themeSetting = (value: unknown): ThemeSetting =>
  value === 'light' || value === 'dark' ? value : 'system';

/** Reads `settings.json`; missing, broken or unknown values fall back to the defaults. */
export function readSettings(file: string): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>;
    return {
      updateChannel: raw.updateChannel === 'beta' ? 'beta' : 'stable',
      language: raw.language === 'de' || raw.language === 'en' ? raw.language : 'system',
      theme: themeSetting(raw.theme),
      bays: Array.isArray(raw.bays) ? raw.bays.filter((b) => typeof b === 'string') : [],
      baySettings: valuesByBay(raw.baySettings),
      shortcuts: validShortcuts(raw.shortcuts),
      ...(typeof raw.localServer === 'boolean' && { localServer: raw.localServer }),
    };
  } catch {
    return { ...DEFAULTS, bays: [], baySettings: {}, shortcuts: [] };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only boolean and text values; without a prototype, so a key like `__proto__` stays a key. */
function valuesByBay(raw: unknown): AppSettings['baySettings'] {
  const result: AppSettings['baySettings'] = Object.create(null);
  if (!isObject(raw)) return result;
  for (const [bay, values] of Object.entries(raw)) {
    result[bay] = Object.create(null);
    if (!isObject(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'boolean' || typeof value === 'string') result[bay]![key] = value;
    }
  }
  return result;
}

/**
 * The stored value of a bay's setting if it has the declared type, else the default from
 * its manifest (`false` if undeclared).
 */
export function baySetting(
  stored: Record<string, SettingValue> | undefined,
  declared: BayManifest['settings'],
  key: string,
): SettingValue {
  const setting = declared?.find((s) => s.key === key);
  if (!setting) return false;
  // Own keys only: a plain object would answer `constructor` with a function.
  const value = stored && Object.hasOwn(stored, key) ? stored[key] : undefined;
  return typeof value === typeof setting.default ? value! : setting.default;
}

export function writeSettings(file: string, settings: AppSettings): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2));
  renameSync(`${file}.tmp`, file);
}

/**
 * Language of this run: `HANGAR_LOCALE` (tests, including the pseudo-locale `en-XA`),
 * then the setting, then the first German or English system language.
 */
export function uiLocale(
  settings: AppSettings,
  override: string | undefined,
  system: readonly string[],
): UiLocale {
  if (isUiLocale(override)) return override;
  return settings.language === 'system' ? resolveLocale(system) : settings.language;
}
