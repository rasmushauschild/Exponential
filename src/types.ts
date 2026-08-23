export type ISODate = string; // YYYY-MM-DD

export type Status = 'todo' | 'progress' | 'review' | 'done' | 'cancelled';

export interface Person {
  id: string;
  name: string;
  email?: string;
  photo?: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  start: ISODate;
  end: ISODate;
  lane: number;
  color?: string;
  notes?: string; // Markdown
  assignees?: string[];
}

export interface Deadline {
  id: string;
  name: string;
  date: ISODate;
  notes?: string;
}

export interface Task {
  id: string;
  personId?: string; // absent = unassigned, sitting in a project's (or parent task's) list
  title: string;
  date?: ISODate; // absent = backlog: shown in every week until scheduled
  end?: ISODate; // inclusive; same as date when absent
  status: Status;
  order?: number; // position among tasks on the same day
  notes?: string;
  createdBy?: string; // person id when someone else added it
  reviewerId?: string;
  projectId?: string; // taken from a project's to-do list
  parentId?: string; // subtask of another task
}

export type NotificationKind = 'task-added' | 'review-requested' | 'owner-changed' | 'project-changed';

export interface Notification {
  id: string;
  to: string;
  from: string;
  kind: NotificationKind;
  text: string;
  ref: { kind: 'task' | 'project'; id: string };
  at: string; // ISO timestamp
  read: boolean;
}

export interface RetroField {
  key: string;
  label: string;
  hint: string;
}

export const DEFAULT_RETRO_FIELDS: RetroField[] = [
  { key: 'wentWell', label: 'What went well', hint: 'Wins, things to keep doing…' },
  { key: 'improve', label: 'What could be better', hint: 'Friction, misses, surprises…' },
  { key: 'learnings', label: 'Learnings', hint: 'What we know now that we didn’t before…' },
  { key: 'nextFocus', label: 'Focus for next week', hint: 'The one or two things that matter most…' },
];

export interface Retro {
  week: ISODate; // Monday
  answers: Record<string, string>; // by RetroField.key
  notes?: string;
}

export interface Data {
  id: string;
  name: string;
  icon?: string; // image data URL; falls back to the first letter of the name
  retroFields?: RetroField[]; // defaults to DEFAULT_RETRO_FIELDS
  moderators: string[]; // person ids allowed to manage members
  people: Person[];
  projects: Project[];
  deadlines: Deadline[];
  tasks: Task[];
  me: string;
  showCalendar?: boolean;
  notifications?: Notification[];
  retros?: Record<ISODate, Retro>;
}

export interface Workspace {
  teams: Data[];
  current: string; // team id
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: ISODate;
  start?: string; // HH:MM, absent for all-day
  end?: string;
  allDay: boolean;
}

export interface GoogleUser {
  id: string;
  email: string;
  name: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

export const STATUS_LABEL: Record<Status, string> = {
  todo: 'To do',
  progress: 'In progress',
  review: 'Needs review',
  done: 'Completed',
  cancelled: 'Cancelled',
};

export const STATUS_ORDER: Status[] = ['todo', 'progress', 'review', 'done', 'cancelled'];

export const STATUS_COLOR: Record<Status, string> = {
  todo: '#c7c7cc',
  progress: '#0a84ff',
  review: '#ff9f0a',
  done: '#30d158',
  cancelled: '#aeaeb2',
};

export const PROJECT_COLORS = ['#5b8def', '#f0a04b', '#3fb98a', '#9b7fe8', '#e8739b', '#e2b93b', '#3fb4d6'];

/** "Rasmus Hauschild" → "Rasmus H." */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
