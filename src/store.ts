import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent, Data, GoogleUser, ISODate, Project } from './types';
import { addDays, todayISO, weekStart } from './dates';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

declare global {
  interface Window {
    exponential?: {
      load: () => Promise<Data | null>;
      save: (data: Data) => Promise<void>;
      platform: string;
      google: {
        getConfig: () => Promise<GoogleConfig | null>;
        setConfig: (c: GoogleConfig) => Promise<void>;
        status: () => Promise<GoogleUser | null>;
        signIn: () => Promise<GoogleUser>;
        signOut: () => Promise<void>;
        events: (calendarId: string, from: ISODate, to: ISODate) => Promise<CalendarEvent[]>;
      };
    };
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10);

function seed(): Data {
  const today = todayISO();
  const monday = weekStart(today);
  return {
    me: 'me',
    people: [
      { id: 'me', name: 'Rasmus Hauschild', color: '#3b82f6' },
      { id: 'p2', name: 'Adam Lind', color: '#f59e0b' },
      { id: 'p3', name: 'Sebastian Berg', color: '#10b981' },
    ],
    projects: [
      { id: uid(), name: 'Chassis prototype', start: addDays(today, -40), end: addDays(today, 25), lane: 0 },
      { id: uid(), name: 'Battery pack v2', start: addDays(today, -10), end: addDays(today, 60), lane: 1 },
      { id: uid(), name: 'Investor deck', start: addDays(today, 3), end: addDays(today, 18), lane: 2 },
      { id: uid(), name: 'Supplier onboarding', start: addDays(today, 30), end: addDays(today, 95), lane: 0 },
    ],
    deadlines: [
      { id: uid(), name: 'Design freeze', date: addDays(today, 12) },
      { id: uid(), name: 'Board meeting', date: addDays(today, 21) },
      { id: uid(), name: 'Test drive', date: addDays(today, 70) },
    ],
    tasks: [
      { id: uid(), personId: 'me', title: 'Review CAD from Adam', date: addDays(monday, 0), status: 'done' },
      { id: uid(), personId: 'me', title: 'Draft battery spec', date: addDays(monday, 1), status: 'progress' },
      { id: uid(), personId: 'me', title: 'Call supplier about cells', date: addDays(monday, 2), status: 'todo' },
      { id: uid(), personId: 'me', title: 'Deck outline', date: addDays(monday, 4), status: 'todo' },
      { id: uid(), personId: 'p2', title: 'Finish chassis welds', date: addDays(monday, 0), status: 'progress' },
      { id: uid(), personId: 'p2', title: 'Order brackets', date: addDays(monday, 2), status: 'review' },
      { id: uid(), personId: 'p3', title: 'BMS firmware test', date: addDays(monday, 1), status: 'todo' },
      { id: uid(), personId: 'p3', title: 'Write test plan', date: addDays(monday, 3), status: 'cancelled' },
    ],
    notifications: [],
  };
}

/** Notes used to be stored as HTML from a contenteditable; convert the common tags to Markdown. */
export function htmlToMarkdown(html: string): string {
  if (!html || !/<[a-z][\s\S]*>/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node, depth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    const el = node as HTMLElement;
    const inner = () => Array.from(el.childNodes).map((n) => walk(n, depth)).join('');
    switch (el.tagName) {
      case 'H1': return `\n# ${inner().trim()}\n`;
      case 'H2': return `\n## ${inner().trim()}\n`;
      case 'H3': return `\n### ${inner().trim()}\n`;
      case 'P': case 'DIV': return `${inner()}\n`;
      case 'BR': return '\n';
      case 'B': case 'STRONG': return `**${inner()}**`;
      case 'I': case 'EM': return `*${inner()}*`;
      case 'UL': case 'OL': return `\n${Array.from(el.children).map((li, i) => `${'  '.repeat(depth)}${el.tagName === 'OL' ? `${i + 1}.` : '-'} ${walk(li, depth + 1).trim()}`).join('\n')}\n`;
      case 'LI': return inner();
      case 'IMG': return `\n![](${el.getAttribute('src')})\n`;
      case 'INPUT': return (el as HTMLInputElement).checked ? '[x] ' : '[ ] ';
      default: return inner();
    }
  };
  return walk(doc.body).replace(/\n{3,}/g, '\n\n').trim();
}

function migrate(d: Data): Data {
  d = {
    ...d,
    projects: d.projects.map((p) => (p.notes ? { ...p, notes: htmlToMarkdown(p.notes) } : p)),
    tasks: d.tasks.map((t) => (t.notes ? { ...t, notes: htmlToMarkdown(t.notes) } : t)),
    deadlines: d.deadlines.map((x) => (x.notes ? { ...x, notes: htmlToMarkdown(x.notes) } : x)),
    retros: d.retros && Object.fromEntries(Object.entries(d.retros).map(([k, r]) => [k, r.notes ? { ...r, notes: htmlToMarkdown(r.notes) } : r])),
  };
  if (d.projects.every((p) => typeof p.lane === 'number')) return d;
  const laneEnds: string[] = [];
  const projects = [...d.projects]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((p): Project => {
      if (typeof p.lane === 'number') return p;
      let lane = laneEnds.findIndex((end) => end < p.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(p.end); } else laneEnds[lane] = p.end;
      return { ...p, lane };
    });
  return { ...d, projects };
}

const LS_KEY = 'exponential-data';

async function load(): Promise<Data> {
  if (window.exponential) {
    const d = await window.exponential.load();
    if (d) return migrate(d);
  } else {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return migrate(JSON.parse(raw));
  }
  return seed();
}

async function persist(data: Data) {
  if (window.exponential) await window.exponential.save(data);
  else localStorage.setItem(LS_KEY, JSON.stringify(data));
}

const HISTORY = 100;

/**
 * Data + undo/redo. `update(fn, coalesceKey)` records a history step; consecutive updates with the
 * same key (e.g. typing into one notes field) collapse into one step.
 */
export function useData() {
  const [data, setData] = useState<Data | null>(null);
  const dataRef = useRef<Data | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const past = useRef<Data[]>([]);
  const future = useRef<Data[]>([]);
  const lastKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    load().then((d) => { dataRef.current = d; setData(d); });
  }, []);

  const commit = (next: Data) => {
    dataRef.current = next;
    setData(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => persist(next), 300);
  };

  // Side effects stay outside React's updater functions (which run twice in Strict Mode).
  const update = useCallback((fn: (d: Data) => Data, coalesceKey?: string) => {
    const prev = dataRef.current;
    if (!prev) return;
    const next = fn(prev);
    if (next === prev) return;
    if (!coalesceKey || coalesceKey !== lastKey.current) {
      past.current.push(prev);
      if (past.current.length > HISTORY) past.current.shift();
    }
    lastKey.current = coalesceKey;
    future.current = [];
    commit(next);
  }, []);

  const undo = useCallback(() => {
    const cur = dataRef.current;
    const prev = past.current.pop();
    if (!cur || !prev) return;
    future.current.push(cur);
    lastKey.current = undefined;
    commit(prev);
  }, []);

  const redo = useCallback(() => {
    const cur = dataRef.current;
    const next = future.current.pop();
    if (!cur || !next) return;
    past.current.push(cur);
    lastKey.current = undefined;
    commit(next);
  }, []);

  return { data, update, undo, redo };
}
