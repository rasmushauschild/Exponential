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
  };
}

/** Older saves had no lane field; pack them so nothing overlaps. */
function migrate(d: Data): Data {
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

export function useData() {
  const [data, setData] = useState<Data | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    load().then(setData);
  }, []);

  const update = useCallback((fn: (d: Data) => Data) => {
    setData((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => persist(next), 300);
      return next;
    });
  }, []);

  return { data, update };
}
