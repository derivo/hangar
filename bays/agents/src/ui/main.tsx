import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@hangar/theme/fonts.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { agentsApi } from './api';
import { App } from './App';
import { setLocale, t } from './messages';
import { TerminalRegistry, type TerminalHandle } from './terminals';

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function createTerminal(): TerminalHandle {
  const term = new Terminal({
    fontFamily: css('--hangar-font-mono') || 'monospace',
    fontSize: 13,
    scrollback: 10_000,
    cursorBlink: true,
    allowProposedApi: true,
    // Links (OSC 8, as Claude Code writes them). xterm's default opens an empty window and
    // sets the address afterwards, which the host denies; the host opens http(s) in the
    // browser (`setWindowOpenHandler`). The question names the real target: the text of
    // an OSC 8 link can say anything.
    linkHandler: {
      activate: (_event, uri) => {
        if (confirm(t.openLink(uri))) window.open(uri);
      },
    },
  });
  // Follow light/dark: the theme tokens change with prefers-color-scheme.
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => {
    term.options.theme = {
      background: css('--hangar-color-terminal-bg'),
      foreground: css('--hangar-color-terminal-fg'),
      cursor: css('--hangar-color-terminal-fg'),
    };
  };
  applyTheme();
  dark.addEventListener('change', applyTheme);
  const fit = new FitAddon();
  term.loadAddon(fit);
  return {
    open: (el) => term.open(el),
    write: (data, done) => term.write(data, done),
    onData: (listener) => void term.onData(listener),
    fit: () => {
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
    focus: () => term.focus(),
    getSelection: () => term.getSelection(),
    dispose: () => {
      dark.removeEventListener('change', applyTheme);
      term.dispose();
    },
  };
}

setLocale(window.hangar.locale);
const api = agentsApi(window.hangar);
const terminals = new TerminalRegistry(api, createTerminal);
// xterm measures its cell size once; load the terminal font first.
void document.fonts
  .load('13px "Geist Mono"')
  .finally(() =>
    createRoot(document.getElementById('root')!).render(<App api={api} terminals={terminals} />),
  );
