import { useEffect, useState } from 'react';
import { WeekPlan } from './WeekPlan';
import { useData } from './store';
import { addTask, patchTask, renameTask, reorderTask } from './taskOps';
import { todayISO, weekStart } from './dates';

/** Menu-bar popover: only the week panel, full featured, always synced with the main window. */
export default function Widget() {
  const { data, update } = useData();
  const [today, setToday] = useState(todayISO());
  const [week, setWeek] = useState(() => weekStart(todayISO()));
  const [person, setPerson] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [theme] = useState(() => {
    try { return JSON.parse(localStorage.getItem('exponential-layout') ?? '{}').theme || ''; } catch { return ''; }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.classList.add('widget-window');
  }, [theme]);

  const me = data?.me ?? '';
  const who = person ?? me;

  const startNewTask = () => {
    if (!data) return;
    let id = '';
    update((d) => { const r = addTask(d, who, undefined); id = r.id; return r.data; });
    setEditingId(id);
  };

  // Each time the popover opens: jump to the current week, my tasks, and a fresh task ready to type into.
  useEffect(() => {
    if (!data) return;
    return window.exponential?.onWidgetShown(() => {
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
          people={data.people}
          me={me}
          selected={who}
          onSelect={setPerson}
          week={week}
          today={today}
          tasks={data.tasks.filter((t) => t.personId === who && (!t.date || (t.date <= addDaysISO(week, 6) && (t.end ?? t.date) >= week)))}
          editingId={editingId ?? undefined}
          onAdd={(date) => { let id = ''; update((d) => { const r = addTask(d, who, date); id = r.id; return r.data; }); setEditingId(id); }}
          onRename={(id, title) => { setEditingId(null); update((d) => renameTask(d, id, title)); }}
          onUpdate={(id, patch) => update((d) => patchTask(d, id, patch))}
          onDelete={(id) => update((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) }))}
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
