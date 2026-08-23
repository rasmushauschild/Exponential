import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEvent, ISODate, Person, Status, Task } from './types';
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER, shortName } from './types';
import { addDays, dayIndex, dayOfMonth, isoWeekNumber, weekdayShort } from './dates';
import { InlineName } from './BigPlan';

const EDGE = 8;
const SWIPE_TRIGGER = 150; // accumulated px of horizontal scroll that flips the week

interface Props {
  people: Person[];
  me: string;
  selected: string;
  onSelect: (id: string) => void;
  week: ISODate;
  today: ISODate;
  tasks: Task[];
  selectedId?: string;
  editingId?: string;
  onAdd: (date: ISODate) => void;
  onRename: (id: string, title: string) => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onOpen: (t: Task) => void;
  onWeekChange: (monday: ISODate) => void;
  calendar: { enabled: boolean; available: boolean; events: CalendarEvent[]; note?: string };
  onToggleCalendar: () => void;
}

export function WeekPlan(props: Props) {
  const { people, me, selected, onSelect, week, today, tasks, selectedId, editingId, onAdd, onRename, onUpdate, onDelete, onOpen, onWeekChange, calendar, onToggleCalendar } = props;
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const readonly = selected !== me;
  const todayIdx = dayIndex(today) - dayIndex(week);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [todayX, setTodayX] = useState<number | null>(null);
  const [ghost, setGhost] = useState<number | null>(null);
  const [swipe, setSwipe] = useState({ x: 0, animate: false });

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const compute = () => {
      if (todayIdx < 0 || todayIdx > 6) return setTodayX(null);
      const tl = el.querySelector<HTMLElement>('.wk-days');
      if (!tl) return;
      setTodayX(tl.offsetLeft + ((todayIdx + 0.5) / 7) * tl.offsetWidth);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [todayIdx, week]);

  // Horizontal trackpad swipe: rubber-band, then flip to the previous/next week once past the trigger.
  const weekRef = useRef(week);
  weekRef.current = week;
  useEffect(() => {
    const el = bodyRef.current!;
    let acc = 0, locked = false, timer: number | undefined;
    const rubber = (v: number) => Math.sign(v) * 60 * Math.log1p(Math.abs(v) / 60);
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { acc = 0; locked = false; setSwipe({ x: 0, animate: true }); }, 180);
      if (locked) return;
      acc += e.deltaX;
      if (Math.abs(acc) >= SWIPE_TRIGGER) {
        locked = true;
        const dir = Math.sign(acc);
        onWeekChange(addDays(weekRef.current, dir * 7));
        setSwipe({ x: dir * 40, animate: false });
        requestAnimationFrame(() => setSwipe({ x: 0, animate: true }));
        return;
      }
      setSwipe({ x: -rubber(acc), animate: false });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); window.clearTimeout(timer); };
  }, [onWeekChange]);

  const sorted = [...tasks].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const events = calendar.enabled ? calendar.events.filter((e) => days.includes(e.date)) : [];

  const dayAt = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect();
    return Math.min(6, Math.max(0, Math.floor(((clientX - r.left) / r.width) * 7)));
  };

  return (
    <>
      <div className="panel-head">
        <div className="panel-title">Week {isoWeekNumber(week)}</div>
        <div className="panel-spacer" />
        <button
          className={`pill toggle${calendar.enabled ? ' active' : ''}`}
          onClick={onToggleCalendar}
          title={calendar.available ? 'Show Google Calendar events' : 'Sign in with Google to show calendar events'}
        >
          <CalIcon /> Calendar
        </button>
        <span className="head-gap" />
        {people.map((p) => (
          <button key={p.id} className={`pill person${p.id === selected ? ' active' : ''}`} onClick={() => onSelect(p.id)}>
            <Avatar person={p} />
            {p.id === me ? 'Me' : shortName(p.name)}
          </button>
        ))}
      </div>

      <div className="wk-body" ref={bodyRef}>
        <div className="wk-swipe" style={{ transform: `translateX(${swipe.x}px)`, transition: swipe.animate ? 'transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none' }}>
          <div className="wk-row wk-header">
            <div className="wk-list" />
            <div className="wk-days">
              {days.map((d, i) => (
                <div key={d} className={`wk-day${i === todayIdx ? ' today' : ''}${i >= 5 ? ' weekend' : ''}`}>
                  <span className="num">{dayOfMonth(d)}</span> {weekdayShort(d)}
                </div>
              ))}
            </div>
          </div>

          <div className="wk-rows">
            {sorted.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                week={week}
                readonly={readonly}
                selected={selectedId === t.id}
                editing={editingId === t.id}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onOpen={onOpen}
                onRename={onRename}
              />
            ))}
            {readonly && sorted.length === 0 && <div className="hint wk-empty">Nothing planned this week.</div>}

            {!readonly && (
              <div className="wk-row wk-free">
                <div className="wk-list">
                  <button className="add-task" onClick={() => onAdd(todayIdx >= 0 && todayIdx <= 6 ? today : week)}>
                    <span className="plus">+</span> Add task
                  </button>
                </div>
                <div
                  className="wk-days ghost-zone"
                  onPointerMove={(e) => setGhost(dayAt(e.currentTarget, e.clientX))}
                  onPointerLeave={() => setGhost(null)}
                  onClick={(e) => { onAdd(days[dayAt(e.currentTarget, e.clientX)]); setGhost(null); }}
                >
                  {ghost !== null && (
                    <div className="wk-block ghost" style={{ left: `${(ghost / 7) * 100}%`, width: `calc(100% / 7 - 6px)` }} />
                  )}
                </div>
              </div>
            )}

            {calendar.enabled && (
              <>
                <div className="wk-section">
                  Calendar
                  {calendar.note && <span className="wk-note"> · {calendar.note}</span>}
                </div>
                {events.map((e) => (
                  <div key={e.id} className="wk-row event">
                    <div className="wk-list">
                      <span className="ev-time">{e.allDay ? 'All day' : e.start}</span>
                      <span className="ev-title">{e.title}</span>
                    </div>
                    <div className="wk-days">
                      <div className="wk-block ev" style={{ left: `${(days.indexOf(e.date) / 7) * 100}%`, width: `calc(100% / 7 - 6px)` }}>
                        {!e.allDay && <span>{e.start}</span>} {e.title}
                      </div>
                    </div>
                  </div>
                ))}
                {events.length === 0 && !calendar.note && <div className="hint wk-empty">No events this week.</div>}
              </>
            )}
          </div>
        </div>

        {todayX !== null && <div className="week-today-line" style={{ left: todayX }} />}
      </div>
    </>
  );
}

type BlockDrag = { mode: 'move' | 'start' | 'end'; s: number; e: number };

function TaskRow({ task, week, readonly, selected, editing, onUpdate, onDelete, onOpen, onRename }: {
  task: Task;
  week: ISODate;
  readonly: boolean;
  selected: boolean;
  editing: boolean;
  onUpdate: Props['onUpdate'];
  onDelete: Props['onDelete'];
  onOpen: Props['onOpen'];
  onRename: Props['onRename'];
}) {
  const [menu, setMenu] = useState(false);
  const [live, setLive] = useState<BlockDrag | null>(null);
  const [hoverCursor, setHoverCursor] = useState('grab');
  const daysRef = useRef<HTMLDivElement>(null);
  const w0 = dayIndex(week);
  const s0 = dayIndex(task.date) - w0;
  const e0 = (task.end ? dayIndex(task.end) : dayIndex(task.date)) - w0;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.status-menu')) setMenu(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const onBlockDown = (e: React.PointerEvent) => {
    if (readonly || e.button !== 0) return;
    e.preventDefault();
    const rect = daysRef.current!.getBoundingClientRect();
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    const mode: BlockDrag['mode'] = local < EDGE ? 'start' : bar.width - local < EDGE ? 'end' : 'move';
    const colW = rect.width / 7;
    const startX = e.clientX;
    let moved = false;
    let latest: BlockDrag = { mode, s: s0, e: e0 };
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      const dd = Math.round((ev.clientX - startX) / colW);
      if (mode === 'move') latest = { mode, s: s0 + dd, e: e0 + dd };
      else if (mode === 'start') latest = { mode, s: Math.min(s0 + dd, e0), e: e0 };
      else latest = { mode, s: s0, e: Math.max(e0 + dd, s0) };
      setLive(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      if (!moved) onOpen(task);
      else if (latest.s !== s0 || latest.e !== e0) {
        onUpdate(task.id, { date: addDays(week, latest.s), end: latest.e === latest.s ? undefined : addDays(week, latest.e) });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onBlockHover = (e: React.PointerEvent) => {
    if (readonly) return;
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    setHoverCursor(local < EDGE || bar.width - local < EDGE ? 'ew-resize' : 'grab');
  };

  const s = live ? live.s : s0;
  const en = live ? live.e : e0;
  const vs = Math.max(0, s), ve = Math.min(6, en);
  return (
    <div className={`wk-row task ${task.status}${selected ? ' selected' : ''}`}>
      <div className="wk-list">
        <button className="status-btn" title={STATUS_LABEL[task.status]} onClick={() => !readonly && setMenu((m) => !m)}
          style={{ cursor: readonly ? 'default' : 'pointer' }}>
          <StatusDot status={task.status} />
        </button>
        {editing
          ? <InlineName initial={task.title} placeholder="Task name…" onDone={(t) => onRename(task.id, t)} />
          : <button className="task-title" onClick={() => onOpen(task)}>{task.title}</button>}
        {menu && (
          <div className="status-menu" style={{ top: 32, left: 0 }}>
            {STATUS_ORDER.map((st) => (
              <button key={st} className={st === task.status ? 'current' : ''} onClick={() => { onUpdate(task.id, { status: st }); setMenu(false); }}>
                <StatusDot status={st} /> {STATUS_LABEL[st]}
              </button>
            ))}
            <div className="sep" />
            <button className="danger" onClick={() => { setMenu(false); onDelete(task.id); }}>
              <span style={{ width: 14 }} /> Delete
            </button>
          </div>
        )}
      </div>
      <div className="wk-days" ref={daysRef}>
        {ve >= vs && (
          <div
            className={`wk-block${live ? ' live' : ''}${s < 0 ? ' cut-l' : ''}${en > 6 ? ' cut-r' : ''}`}
            style={{
              left: `${(vs / 7) * 100}%`,
              width: `calc(${((ve - vs + 1) / 7) * 100}% - 6px)`,
              ['--sc' as string]: STATUS_COLOR[task.status],
              cursor: readonly ? 'default' : live ? (live.mode === 'move' ? 'grabbing' : 'ew-resize') : hoverCursor,
            }}
            onPointerDown={onBlockDown}
            onPointerMove={onBlockHover}
            title={task.title}
          />
        )}
      </div>
    </div>
  );
}

export function Avatar({ person, size = 20 }: { person: Person; size?: number }) {
  if (person.photo) {
    return <img className="avatar" src={person.photo} width={size} height={size} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <span className="avatar initials" style={{ width: size, height: size, background: person.color, fontSize: size * 0.5 }}>
      {person.name.trim()[0]?.toUpperCase()}
    </span>
  );
}

export function StatusDot({ status }: { status: Status }) {
  const c = STATUS_COLOR[status];
  const filled = status === 'done' || status === 'cancelled' || status === 'progress';
  return (
    <span className="status-ring" style={{ ['--c' as string]: c, ['--fill' as string]: filled ? c : 'transparent' }}>
      {status === 'done' && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 5.5l2.5 2.5 4.5-5" />
        </svg>
      )}
      {status === 'cancelled' && (
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      )}
      {status === 'progress' && <span style={{ width: 4, height: 4, borderRadius: 2, background: '#fff' }} />}
      {status === 'review' && <span style={{ width: 6, height: 6, borderRadius: 3, background: c }} />}
    </span>
  );
}

function CalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="4" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}
