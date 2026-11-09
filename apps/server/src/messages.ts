// Texts the server shows people through a desktop (UI errors), see ADR 0009 and 0019.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  noFolderDialog: 'Auf dem Server gibt es keinen Ordnerdialog: Pfad angeben',
  folderNotFound: (path: string) => `Ordner nicht gefunden: ${path}`,
  folderOutside: (path: string) => `Ordner außerhalb der erlaubten Wurzeln (--root): ${path}`,
  repositoryOutside: (path: string) =>
    `Wurzel des Repositorys außerhalb der erlaubten Wurzeln (--root): ${path}`,
  desktopClosed: 'Hangar ist nicht geöffnet',
};

const en: typeof de = {
  noFolderDialog: 'There is no folder dialog on the server: pass a path',
  folderNotFound: (path) => `Folder not found: ${path}`,
  folderOutside: (path) => `Folder outside the allowed roots (--root): ${path}`,
  repositoryOutside: (path) => `Repository root outside the allowed roots (--root): ${path}`,
  desktopClosed: 'Hangar is not open',
};

export const messages = (locale: UiLocale) => catalogFor({ de, en }, locale);
