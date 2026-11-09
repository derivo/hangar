import type { ShellApi } from '../shared';

declare global {
  interface Window {
    hangarShell: ShellApi;
  }
}
