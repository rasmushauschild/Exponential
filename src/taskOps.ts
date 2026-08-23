import type { Data, ISODate, Notification, Task } from './types';
import { shortName } from './types';
import { uid } from './store';

/** Pure helpers shared by the main window and the menu-bar widget. */

export const notify = (d: Data, n: Omit<Notification, 'id' | 'at' | 'read'>): Data =>
  n.to === n.from ? d : { ...d, notifications: [...(d.notifications ?? []), { ...n, id: uid(), at: new Date().toISOString(), read: false }] };

export const nameOf = (d: Data, id: string) => shortName(d.people.find((p) => p.id === id)?.name ?? 'Someone');

/** New tasks go to the end of their day (or of the backlog). Returns the new id. */
export function addTask(d: Data, personId: string, date?: ISODate): { data: Data; id: string } {
  const id = uid();
  const order = d.tasks.filter((t) => t.personId === personId && t.date === date).reduce((m, t) => Math.max(m, (t.order ?? 0) + 1), 0);
  const task: Task = { id, personId, title: 'New task', date, order, status: 'todo', createdBy: d.me };
  return { data: { ...d, tasks: [...d.tasks, task] }, id };
}

/** Finishing the inline name: empty removes the task; naming someone else's task tells them. */
export function renameTask(d: Data, id: string, title: string): Data {
  if (!title) return { ...d, tasks: d.tasks.filter((t) => t.id !== id) };
  const t0 = d.tasks.find((t) => t.id === id);
  if (!t0) return d;
  const next: Data = { ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, title } : t)) };
  return t0.personId !== d.me
    ? notify(next, { to: t0.personId, from: d.me, kind: 'task-added', text: `${nameOf(d, d.me)} added “${title}” to your ${t0.date ? 'week' : 'backlog'}`, ref: { kind: 'task', id } })
    : next;
}

export function reorderTask(d: Data, id: string, delta: number): Data {
  const t = d.tasks.find((x) => x.id === id);
  if (!t) return d;
  const group = d.tasks.filter((x) => x.personId === t.personId && x.date === t.date)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  const from = group.findIndex((x) => x.id === id);
  const to = Math.min(group.length - 1, Math.max(0, from + delta));
  if (from === to) return d;
  group.splice(to, 0, group.splice(from, 1)[0]);
  const order = new Map(group.map((x, i) => [x.id, i]));
  return { ...d, tasks: d.tasks.map((x) => (order.has(x.id) ? { ...x, order: order.get(x.id) } : x)) };
}

/** Task edits that someone else should hear about: new owner, review request. */
export function patchTask(d: Data, id: string, patch: Partial<Task>): Data {
  const before = d.tasks.find((t) => t.id === id);
  if (!before) return d;
  const after = { ...before, ...patch };
  let next: Data = { ...d, tasks: d.tasks.map((t) => (t.id === id ? after : t)) };
  if (patch.personId && patch.personId !== before.personId) {
    next = notify(next, { to: after.personId, from: d.me, kind: 'owner-changed', text: `${nameOf(d, d.me)} handed you “${after.title}”`, ref: { kind: 'task', id } });
    next = notify(next, { to: before.personId, from: d.me, kind: 'owner-changed', text: `${nameOf(d, d.me)} moved “${after.title}” to ${nameOf(d, after.personId)}`, ref: { kind: 'task', id } });
  }
  if (after.status === 'review' && after.reviewerId && (after.reviewerId !== before.reviewerId || before.status !== 'review')) {
    next = notify(next, { to: after.reviewerId, from: d.me, kind: 'review-requested', text: `${nameOf(d, d.me)} asked you to review “${after.title}”`, ref: { kind: 'task', id } });
  }
  return next;
}
