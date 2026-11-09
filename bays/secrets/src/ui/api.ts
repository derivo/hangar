import type { HangarUiApi } from '@hangar/sdk';
import type { SecretInfo } from '../main/vault';

/** Typed wrapper around `window.hangar` for the secrets bay's channels. */
export function secretsApi(hangar: HangarUiApi) {
  return {
    list: () => hangar.invoke<SecretInfo[]>('list'),
    save: (entry: { name: string; value?: string; description: string }) =>
      hangar.invoke<void>('save', entry),
    remove: (name: string) => hangar.invoke<void>('remove', name),
    onState: (l: (s: SecretInfo[]) => void) => hangar.on('state', (p) => l(p as SecretInfo[])),
  };
}

export type SecretsApi = ReturnType<typeof secretsApi>;
