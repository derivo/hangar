import type { BrowserTab } from '@hangar/sdk';

/** A tab as the UI shows it: opened by the person or by an agent (or another bay). */
export interface TabView extends BrowserTab {
  owner: 'user' | 'agent';
}

export interface BrowserState {
  tabs: TabView[];
}
