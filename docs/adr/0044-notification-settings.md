# ADR 0044 – Checking system notifications in the settings

Status: accepted 2026-11-13.

## Context

Hangar notifies when an agent session waits for the person
(`apps/desktop/src/main/host.ts`, `notify`). On the person's Mac
(2026-11-13) no notification arrived: macOS listed no entry for
`dev.hangar.app` under Notifications, and Hangar ignored the `failed` event of
Electron's `Notification`, so the refusal was silent. Electron 45 shows
notifications on macOS through `UNUserNotificationCenter`; a refused one fails
with `UNErrorDomain error 1`. The person asked for a place in the settings to
check notifications, to switch them on and to find the right place in the
system, for macOS, Windows and Linux.

## Decision

- **The host keeps the system's refusal.** Every notification listens to
  `failed` (macOS, Windows) and `show`; the last refusal stays until a
  notification is shown again; each answer sends `shell:notifications`, so an
  open settings page reads the status again. `notificationStatus()` → `{ supported,
platform, settings?, error? }` (IPC `shell:notifications`).
- **Test notification:** `testNotification()` (IPC
  `shell:notifications.test`) shows "Hangar: test notification" and resolves
  with `shown` or `failed` (with the error) as the system answers, `unknown`
  after 10 s without an answer (Linux reports no failure; a first macOS
  permission prompt may still be open), `unsupported` where Electron has no
  notifications (Linux without libnotify). On macOS the first test also brings
  up the system's own permission prompt.
- **Switching on happens in the system.** No app can turn its notifications on
  itself once refused. `openNotificationSettings()` (IPC
  `shell:notifications.settings`) opens the system page:
  macOS `x-apple.systempreferences:com.apple.Notifications-Settings.extension`,
  Windows `ms-settings:notifications`
  ([Microsoft: Launch Windows Settings](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)).
  Linux has no common page; the settings name the place for GNOME and KDE.
- **UI:** section "Notifications" in the settings
  (`src/renderer/Notifications.tsx`): hint, a missing notification service,
  the last refusal, "Send test notification", "Turn on notifications in the
  system" (macOS, Windows), the answer as `role="status"` and per platform where
  the switch is, including Do Not Disturb / Focus, which holds notifications back
  without an error.

## Alternatives

- **Reading the permission state directly:** Electron 45 has no API for the
  authorization state of `UNUserNotificationCenter`; a native module only for
  this is out of proportion.
- **A Hangar switch to turn notifications off:** not asked for; the system
  setting already does that.

## Consequences

- `ShellApi` gains `getNotifications`, `testNotification`,
  `openNotificationSettings`.
- `show` says only that the system took the notification; Do Not Disturb or a
  Focus can still hide it. The settings ask the person whether it appeared.
- Under `HANGAR_E2E` the test notification is recorded like every other one
  (`bayId` empty) and answers `shown`; real delivery needs the signed, packaged
  app.
