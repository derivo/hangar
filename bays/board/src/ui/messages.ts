// Texts of the board UI, see ADR 0009.
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = {
  title: 'Board',
  project: 'Projekt',
  noAgents:
    'Die Agent-Bay fehlt. Füge sie in der Leiste hinzu; das Board ordnet Aufgaben ihren Projekten zu.',
  noProjects: 'Noch kein Projekt. Lege in der Agent-Bay ein Projekt an.',
  add: 'Neue Aufgabe',
  taskTitle: 'Titel',
  description: 'Beschreibung',
  openAdd: 'Aufgabe hinzufügen',
  descriptionPlaceholder: 'Beschreibung (optional)',
  create: 'Aufgabe anlegen',
  cancel: 'Abbrechen',
  titleMissing: 'Titel fehlt',
  columns: { open: 'Offen', doing: 'In Arbeit', done: 'Erledigt' },
  empty: 'Keine Aufgaben.',
  byPerson: 'von dir',
  byAgent: (name: string) => `von Agent ${name}`,
  takenBy: (name: string) => `in Arbeit bei ${name}`,
  finish: 'Erledigt',
  reopen: 'Wieder öffnen',
  release: 'Zurück auf Offen',
  remove: 'Löschen',
  finishLabel: (title: string) => `${title} erledigt`,
  reopenLabel: (title: string) => `${title} wieder öffnen`,
  releaseLabel: (title: string) => `${title} zurück auf Offen`,
  removeLabel: (title: string) => `${title} löschen`,
  confirmRemove: (title: string) => `Aufgabe „${title}“ löschen?`,
  notes: 'Notizen',
  hint: 'Agents sehen die Aufgaben ihres Projekts über MCP (task.list, task.add, task.claim, task.note, task.done).',
};

const en: typeof de = {
  title: 'Board',
  project: 'Project',
  noAgents:
    'The agent bay is missing. Add it in the sidebar; the board files tasks under its projects.',
  noProjects: 'No project yet. Add one in the agent bay.',
  add: 'New task',
  taskTitle: 'Title',
  description: 'Description',
  openAdd: 'Add a task',
  descriptionPlaceholder: 'Description (optional)',
  create: 'Add task',
  cancel: 'Cancel',
  titleMissing: 'Title missing',
  columns: { open: 'Open', doing: 'In progress', done: 'Done' },
  empty: 'No tasks.',
  byPerson: 'by you',
  byAgent: (name) => `by agent ${name}`,
  takenBy: (name) => `in progress with ${name}`,
  finish: 'Done',
  reopen: 'Reopen',
  release: 'Back to open',
  remove: 'Delete',
  finishLabel: (title) => `${title} done`,
  reopenLabel: (title) => `Reopen ${title}`,
  releaseLabel: (title) => `${title} back to open`,
  removeLabel: (title) => `Delete ${title}`,
  confirmRemove: (title) => `Delete task “${title}”?`,
  notes: 'Notes',
  hint: 'Agents see the tasks of their project through MCP (task.list, task.add, task.claim, task.note, task.done).',
};

export let t = de;
export const setLocale = (locale: UiLocale) => void (t = catalogFor({ de, en }, locale));
