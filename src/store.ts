import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent, Data, GoogleUser, ISODate, Project, Workspace } from './types';
import { addDays, todayISO, weekStart } from './dates';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

declare global {
  interface Window {
    exponential?: {
      load: () => Promise<unknown>;
      save: (data: unknown) => Promise<void>;
      onChange: (cb: (data: unknown) => void) => () => void;
      openMain: (target?: { kind: string; id: string }) => void;
      closeWidget: () => void;
      isWidget: boolean;
      onWidgetShown: (cb: () => void) => () => void;
      onOpen: (cb: (target: { kind: string; id: string }) => void) => () => void;
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
    id: uid(),
    name: 'Airy Automotive',
    moderators: ['me'],
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
      case 'P': case 'DIV': { const t = inner(); return t.trim() ? `${t}\n` : '\n'; }
      case 'BR': return '\n';
      case 'B': case 'STRONG': return `**${inner()}**`;
      case 'I': case 'EM': return `*${inner()}*`;
      case 'UL': case 'OL': return `\n${Array.from(el.children).map((li, i) => `${'  '.repeat(depth)}${el.tagName === 'OL' ? `${i + 1}.` : '-'} ${walk(li, depth + 1).trim().replace(/^\[( |x)\]\s+/, '[$1] ')}`).join('\n')}\n`;
      case 'LI': return inner();
      case 'IMG': return `\n![](${el.getAttribute('src')})\n`;
      case 'INPUT': return el.hasAttribute('checked') || (el as HTMLInputElement).checked ? '[x] ' : '[ ] ';
      default: return inner();
    }
  };
  return walk(doc.body).replace(/\n{3,}/g, '\n\n').trim();
}

function migrate(d: Data): Data {
  d = {
    ...d,
    id: d.id ?? uid(),
    name: d.name ?? 'My team',
    moderators: d.moderators ?? [d.me],
    projects: d.projects.map((p) => (p.notes ? { ...p, notes: htmlToMarkdown(p.notes) } : p)),
    tasks: d.tasks.map((t) => (t.notes ? { ...t, notes: htmlToMarkdown(t.notes) } : t)),
    deadlines: d.deadlines.map((x) => (x.notes ? { ...x, notes: htmlToMarkdown(x.notes) } : x)),
    retros: d.retros && Object.fromEntries(Object.entries(d.retros).map(([k, r]) => {
      // older retros kept each answer as its own field
      const legacy = r as unknown as Record<string, string>;
      const answers = r.answers ?? Object.fromEntries(['wentWell', 'improve', 'learnings', 'nextFocus'].filter((f) => legacy[f]).map((f) => [f, legacy[f]]));
      return [k, { week: r.week, answers, notes: r.notes ? htmlToMarkdown(r.notes) : r.notes }];
    })),
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

/** A saved file is either a workspace or (older) a single team's data. */
function toWorkspace(raw: unknown): Workspace {
  const r = raw as Partial<Workspace> & Partial<Data>;
  if (Array.isArray(r.teams)) {
    const teams = r.teams.map(migrate);
    return { teams, current: teams.some((t) => t.id === r.current) ? r.current! : teams[0].id };
  }
  const one = migrate(r as Data);
  return { teams: [one], current: one.id };
}

async function load(): Promise<Workspace> {
  if (window.exponential) {
    const d = await window.exponential.load();
    if (d) return toWorkspace(d);
  } else {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return toWorkspace(JSON.parse(raw));
  }
  const first = seed();
  return { teams: [first], current: first.id };
}

async function persist(ws: Workspace) {
  if (window.exponential) await window.exponential.save(ws);
  else localStorage.setItem(LS_KEY, JSON.stringify(ws));
}

const HISTORY = 100;

/**
 * Data + undo/redo. `update(fn, coalesceKey)` records a history step; consecutive updates with the
 * same key (e.g. typing into one notes field) collapse into one step.
 */
export function useData() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const wsRef = useRef<Workspace | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const past = useRef<Data[]>([]);
  const future = useRef<Data[]>([]);
  const lastKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    load().then((w) => { wsRef.current = w; setWs(w); });
    // Another window (main app or menu-bar widget) saved: adopt its data, keep our current team.
    return window.exponential?.onChange((raw) => {
      const incoming = toWorkspace(raw);
      const cur = wsRef.current?.current;
      const next = cur && incoming.teams.some((t) => t.id === cur) ? { ...incoming, current: cur } : incoming;
      wsRef.current = next;
      setWs(next);
    });
  }, []);

  const commitWs = (next: Workspace) => {
    wsRef.current = next;
    setWs(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => persist(next), 300);
  };
  const current = (w: Workspace) => w.teams.find((t) => t.id === w.current)!;
  const replaceTeam = (w: Workspace, team: Data): Workspace => ({ ...w, teams: w.teams.map((t) => (t.id === team.id ? team : t)) });

  // Side effects stay outside React's updater functions (which run twice in Strict Mode).
  const update = useCallback((fn: (d: Data) => Data, coalesceKey?: string) => {
    const w = wsRef.current;
    if (!w) return;
    const prev = current(w);
    const next = fn(prev);
    if (next === prev) return;
    if (!coalesceKey || coalesceKey !== lastKey.current) {
      past.current.push(prev);
      if (past.current.length > HISTORY) past.current.shift();
    }
    lastKey.current = coalesceKey;
    future.current = [];
    commitWs(replaceTeam(w, next));
  }, []);

  const undo = useCallback(() => {
    const w = wsRef.current;
    const prev = past.current.pop();
    if (!w || !prev || prev.id !== w.current) return;
    future.current.push(current(w));
    lastKey.current = undefined;
    commitWs(replaceTeam(w, prev));
  }, []);

  const redo = useCallback(() => {
    const w = wsRef.current;
    const next = future.current.pop();
    if (!w || !next || next.id !== w.current) return;
    past.current.push(current(w));
    lastKey.current = undefined;
    commitWs(replaceTeam(w, next));
  }, []);

  /** Switching teams resets the undo stack; history is per team. */
  const switchTeam = useCallback((id: string) => {
    const w = wsRef.current;
    if (!w || !w.teams.some((t) => t.id === id)) return;
    past.current = []; future.current = []; lastKey.current = undefined;
    commitWs({ ...w, current: id });
  }, []);

  const createTeam = useCallback((name: string) => {
    const w = wsRef.current;
    if (!w) return;
    const me = current(w).people.find((p) => p.id === current(w).me)!;
    const team: Data = { id: uid(), name, moderators: ['me'], me: 'me', people: [{ ...me, id: 'me' }], projects: [], deadlines: [], tasks: [], notifications: [] };
    past.current = []; future.current = []; lastKey.current = undefined;
    commitWs({ teams: [...w.teams, team], current: team.id });
  }, []);

  return { data: ws ? current(ws) : null, teams: ws?.teams ?? [], update, undo, redo, switchTeam, createTeam };
}
