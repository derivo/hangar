import { BrowserWindow, dialog } from 'electron';
import type { Decision, PermissionRequest, Prompter } from '@hangar/bus';
import { t } from '../messages';

export interface PromptSpec {
  message: string;
  detail: string;
  buttons: { label: string; decision: Decision }[];
}

/** Text and choices of the permission dialog (spec §7). Last button = cancel. */
export function promptSpec(request: PermissionRequest, server?: string): PromptSpec {
  const { caller, target } = request;
  const call =
    caller.kind === 'remote'
      ? // Fingerprint shortened for reading; the full one is confirmed when joining (ADR 0011).
        t.callByRemote(`${caller.instance.slice(0, 16)}…`, caller.workspace, caller.bayId, target)
      : caller.kind === 'local-server'
        ? caller.sessionId
          ? t.callByLocalSession(caller.bayId, target)
          : t.callByLocalBay(caller.bayId, target)
        : caller.kind === 'session'
          ? t.callBySession(caller.bayId, target)
          : t.callByBay(caller.bayId, target);
  // A question from a server's bus (ADR 0019): the answer applies there.
  const detail = server ? `${t.onServer(server)} ${call}` : call;
  if (request.kind === 'confirm') {
    return {
      message: t.confirmTitle,
      detail,
      buttons: [
        { label: t.allow, decision: 'allow' },
        { label: t.deny, decision: 'deny' },
      ],
    };
  }
  if (!request.sensitive) {
    return {
      message: t.allowTitle,
      detail: `${detail} ${t.decisionSaved}`,
      buttons: [
        { label: t.allow, decision: 'allow' },
        { label: t.deny, decision: 'deny' },
      ],
    };
  }
  return {
    message: t.sensitiveTitle,
    detail,
    buttons: [
      { label: t.allowAlways, decision: 'allow' },
      {
        // Session grants exist for agents only (bus): of this app or of the local server.
        label:
          caller.kind === 'session' || (caller.kind === 'local-server' && caller.sessionId)
            ? t.allowSession
            : t.allowOnce,
        decision: 'session',
      },
      { label: t.askEveryTime, decision: 'ask' },
      { label: t.deny, decision: 'deny' },
    ],
  };
}

/**
 * Asks with a native message box; `server` names the server the question comes from,
 * `signal` closes the box when that server's connection ends.
 */
export async function askWithDialog(
  request: PermissionRequest,
  server?: string,
  signal?: AbortSignal,
): Promise<Decision> {
  const spec = promptSpec(request, server);
  const options = {
    type: 'question' as const,
    message: spec.message,
    detail: spec.detail,
    buttons: spec.buttons.map((b) => b.label),
    defaultId: spec.buttons.length - 1,
    cancelId: spec.buttons.length - 1,
    noLink: true,
    ...(signal && { signal }),
  };
  const window = BrowserWindow.getAllWindows()[0];
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return spec.buttons[response]!.decision;
}

/** Asks for this desktop's own bus. */
export const dialogPrompter: Prompter = { ask: (request) => askWithDialog(request) };
