import { useEffect, useRef, useState } from 'react';
import { WeekPlan } from './WeekPlan';
import { useData } from './store';
import { addTask, completeReview, denyReview, patchTask, renameTask, reorderTask } from './taskOps';
import { todayISO, weekStart } from './dates';

/** Menu-bar popover: only the week panel, full featured, always synced with the main window. */
export default function Widget() {
  const { data, update, connectCloud } = useData();
  useEffect(() => { connectCloud().catch((e) => console.error('[widget] cloud', e)); }, [connectCloud]);
  const [today, setToday] = useState(todayISO());
  const [week, setWeek] = useState(() => weekStart(todayISO()));
  const [person, setPerson] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Follow the theme chosen in the main window (same origin → same localStorage); re-check whenever it changes or we open.
  const applyTheme = () => {
    let saved = '';
    try { saved = JSON.parse(localStorage.getItem('exponential-layout') ?? '{}').theme || ''; } catch { /* ignore */ }
    document.documentElement.dataset.theme = saved || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  };
  useEffect(() => {
    document.documentElement.classList.add('widget-window');
    applyTheme();
    window.addEventListener('storage', applyTheme);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', applyTheme);
    return () => { window.removeEventListener('storage', applyTheme); mq?.removeEventListener('change', applyTheme); };
  }, []);

  const me = data?.me ?? '';
  const who = person ?? me;

  const startNewTask = () => {
    if (!data) return;
    let id = '';
    // at the top of the backlog, so the week's tasks stay in view while you type
    update((d) => { const r = addTask(d, who, undefined, 'start'); id = r.id; return r.data; });
    setEditingId(id);
  };

  // Each time the popover opens — and the first time data arrives while it's open — a fresh task is
  // ready to type into, on the current week.
  const openedOnce = useRef(false);
  useEffect(() => {
    if (!data) return;
    if (!openedOnce.current && document.visibilityState === 'visible') { openedOnce.current = true; startNewTask(); }
    return window.exponential?.onWidgetShown(() => {
      applyTheme();
      setToday(todayISO());
      setWeek(weekStart(todayISO()));
      setPerson(null);
      startNewTask();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(document.activeElement as HTMLElement)?.matches('input, textarea')) window.exponential?.closeWidget(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  if (!data) return null;

  return (
    <div className="widget">
      <section className="panel widget-panel">
        <WeekPlan
          people={data.people.filter((p) => p.id === me)}
          me={me}
          selected={who}
          onSelect={setPerson}
          week={week}
          today={today}
          tasks={data.tasks.filter((t) => (t.personId === who || (t.reviewerId === who && (t.status === 'review' || t.reviewDone))) && (!t.date || (t.date <= addDaysISO(week, 6) && (t.end ?? t.date) >= week)))}
          editingId={editingId ?? undefined}
          onToggleSelect={() => {}}
          onAdd={(date) => { let id = ''; update((d) => { const r = addTask(d, who, date); id = r.id; return r.data; }); setEditingId(id); }}
          onRename={(id, title, viaEnter) => {
            setEditingId(null);
            let nextId = '';
            update((d) => {
              const renamed = renameTask(d, id, title);
              if (viaEnter && title) { const r = addTask(renamed, who, undefined); nextId = r.id; return r.data; }
              return renamed;
            });
            if (nextId) setEditingId(nextId);
          }}
          onAddNamed={(title) => update((d) => { const r = addTask(d, who, undefined); return renameTask(r.data, r.id, title); })}
          onUpdate={(id, patch) => update((d) => patchTask(d, id, patch))}
          onDelete={(id) => update((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) }))}
          onDeny={(id) => update((d) => denyReview(d, id))}
          onCompleteReview={(id) => update((d) => completeReview(d, id))}
          onOpen={(t) => window.exponential?.openMain({ kind: 'task', id: t.id })}
          onReorder={(id, delta) => update((d) => reorderTask(d, id, delta))}
          onWeekChange={setWeek}
          calendar={{ enabled: false, available: false, events: [] }}
          onToggleCalendar={() => {}}
          headExtra={
            <button className="pill" onClick={() => window.exponential?.openMain()} title="Open Exponential">
              Open app <span className="arrow">↗</span>
            </button>
          }
        />
      </section>
    </div>
  );
}

function addDaysISO(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
