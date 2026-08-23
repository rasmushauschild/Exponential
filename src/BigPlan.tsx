import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Deadline, ISODate, Project } from './types';
import { PROJECT_COLORS } from './types';
import { dayIndex, dayOfMonth, formatShort, fromDayIndex, isoWeekNumber, monthShort, weekdayShort } from './dates';

const ROW_H = 38;
const DEADLINE_ROW_H = 30;
const HEADER_H = 46;
const MIN_PPD = 4;
const MAX_PPD = 90;
const EDGE = 10; // px from a bar's end that acts as a resize handle

interface Props {
  projects: Project[];
  deadlines: Deadline[];
  today: ISODate;
  week: ISODate;
  selectedId?: string;
  editingId?: string;
  onWeekChange: (monday: ISODate) => void;
  onOpenProject: (p: Project) => void;
  onOpenDeadline: (d: Deadline) => void;
  onMoveProject: (id: string, patch: Pick<Project, 'start' | 'end' | 'lane'>) => void;
  onMoveDeadline: (id: string, date: ISODate) => void;
  onCreateProject: (start: ISODate, lane: number) => void;
  onRename: (id: string, name: string) => void;
}

function packLanes<T>(items: T[], range: (t: T) => [number, number]): Map<T, number> {
  const sorted = [...items].sort((a, b) => range(a)[0] - range(b)[0]);
  const laneEnds: number[] = [];
  const out = new Map<T, number>();
  for (const it of sorted) {
    const [s, e] = range(it);
    let lane = laneEnds.findIndex((end) => end < s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
    out.set(it, lane);
  }
  return out;
}

export function projectColor(p: Project, index: number) {
  return p.color ?? PROJECT_COLORS[index % PROJECT_COLORS.length];
}

type Drag = { id: string; mode: 'move' | 'start' | 'end'; start: number; end: number; lane: number; moved: boolean };
type View = { ppd: number; origin: number };

export function BigPlan(props: Props) {
  const { projects, deadlines, today, week, selectedId, editingId, onWeekChange, onOpenProject, onOpenDeadline, onMoveProject, onMoveDeadline, onCreateProject, onRename } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<View>(() => ({ ppd: 22, origin: dayIndex(today) - 14 }));
  const viewRef = useRef(view);
  viewRef.current = view;
  const { ppd, origin } = view;
  const [panning, setPanning] = useState(false);
  const [bandDrag, setBandDrag] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dlDrag, setDlDrag] = useState<{ id: string; date: number } | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string>('');
  const [ghost, setGhost] = useState<{ day: number; lane: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Wheel: pinch (ctrlKey) zooms so the day under the cursor stays put; otherwise scroll horizontally.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const mx = e.clientX - el.getBoundingClientRect().left;
        const next = Math.min(MAX_PPD, Math.max(MIN_PPD, v.ppd * Math.exp(-e.deltaY * 0.01)));
        const dayUnderCursor = v.origin + mx / v.ppd;
        setView({ ppd: next, origin: dayUnderCursor - mx / next });
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView({ ppd: v.ppd, origin: v.origin + delta / v.ppd });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const x = (iso: ISODate) => (dayIndex(iso) - origin) * ppd;

  const track = (move: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void) => {
    const onUp = (ev: PointerEvent) => {
      up(ev);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', onUp);
  };

  const dlLanes = packLanes(deadlines, (d) => [dayIndex(d.date), dayIndex(d.date) + Math.ceil(140 / ppd)]);
  const dlLaneCount = deadlines.length ? Math.max(...dlLanes.values()) + 1 : 0;
  const projectTop = HEADER_H + dlLaneCount * DEADLINE_ROW_H + 10;

  const slotAt = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const day = Math.floor(origin + (clientX - rect.left) / ppd);
    const lane = Math.floor((clientY - rect.top - projectTop) / ROW_H);
    return { day, lane };
  };

  const isEmptyTarget = (t: EventTarget | null) => !(t as HTMLElement).closest('.week-band, .tl-project, .tl-deadline');

  // Empty space: a still click creates a week-long project at the ghost; a drag pans.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !isEmptyTarget(e.target)) return;
    const startX = e.clientX;
    const startOrigin = origin;
    let moved = false;
    setGhost(null);
    track(
      (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        if (moved) { setPanning(true); setView({ ppd, origin: startOrigin - (ev.clientX - startX) / ppd }); }
      },
      (ev) => {
        setPanning(false);
        if (moved) return;
        const { day, lane } = slotAt(ev.clientX, ev.clientY);
        if (lane >= 0) onCreateProject(fromDayIndex(day), lane);
      },
    );
  };

  const onHover = (e: React.PointerEvent) => {
    if (drag || dlDrag || panning || bandDrag) return;
    if (!isEmptyTarget(e.target)) { setGhost(null); return; }
    const { day, lane } = slotAt(e.clientX, e.clientY);
    setGhost(lane >= 0 ? { day, lane } : null);
  };

  const onBandDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startWeek = dayIndex(week);
    setBandDrag(true);
    track((ev) => {
      const shift = Math.round((ev.clientX - startX) / ppd / 7) * 7;
      const next = fromDayIndex(startWeek + shift);
      if (next !== week) onWeekChange(next);
    }, () => setBandDrag(false));
  };

  const onProjectDown = (e: React.PointerEvent, p: Project) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    e.stopPropagation();
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    const mode: Drag['mode'] = local < EDGE ? 'start' : bar.width - local < EDGE ? 'end' : 'move';
    const s0 = dayIndex(p.start), e0 = dayIndex(p.end), lane0 = p.lane;
    const startX = e.clientX, startY = e.clientY;
    const d: Drag = { id: p.id, mode, start: s0, end: e0, lane: lane0, moved: false };
    setDrag(d);
    let latest = d;
    track(
      (ev) => {
        const dd = Math.round((ev.clientX - startX) / ppd);
        const dl = Math.round((ev.clientY - startY) / ROW_H);
        const moved = latest.moved || Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3;
        if (mode === 'move') latest = { ...d, start: s0 + dd, end: e0 + dd, lane: Math.max(0, lane0 + dl), moved };
        else if (mode === 'start') latest = { ...d, start: Math.min(s0 + dd, e0), moved };
        else latest = { ...d, end: Math.max(e0 + dd, s0), moved };
        setDrag(latest);
      },
      () => {
        setDrag(null);
        if (!latest.moved) onOpenProject(p);
        else onMoveProject(p.id, { start: fromDayIndex(latest.start), end: fromDayIndex(latest.end), lane: latest.lane });
      },
    );
  };

  const onDeadlineDown = (e: React.PointerEvent, d: Deadline) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const d0 = dayIndex(d.date);
    let latest = d0, moved = false;
    setDlDrag({ id: d.id, date: d0 });
    track(
      (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        latest = d0 + Math.round((ev.clientX - startX) / ppd);
        setDlDrag({ id: d.id, date: latest });
      },
      () => {
        setDlDrag(null);
        if (!moved) onOpenDeadline(d);
        else if (latest !== d0) onMoveDeadline(d.id, fromDayIndex(latest));
      },
    );
  };

  const onProjectHover = (e: React.PointerEvent) => {
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    setHoverCursor(local < EDGE || bar.width - local < EDGE ? 'ew-resize' : 'grab');
  };

  const firstDay = Math.floor(origin) - 1;
  const lastDay = Math.ceil(origin + width / ppd) + 1;
  const months: { iso: ISODate; left: number; w: number }[] = [];
  {
    let d = firstDay;
    while (d <= lastDay) {
      const iso = fromDayIndex(d);
      const [y, m] = iso.split('-').map(Number);
      const mStart = dayIndex(`${y}-${String(m).padStart(2, '0')}-01`);
      const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const mEnd = dayIndex(nextM);
      months.push({ iso, left: (mStart - origin) * ppd, w: (mEnd - mStart) * ppd });
      d = mEnd;
    }
  }
  const days: number[] = [];
  if (ppd >= 16) for (let d = firstDay; d <= lastDay; d++) days.push(d);

  const weekNum = isoWeekNumber(week);

  return (
    <div
      ref={ref}
      className={`timeline${panning ? ' panning' : ''}${drag || dlDrag ? ' dragging-item' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onHover}
      onPointerLeave={() => setGhost(null)}
    >
      {months.map((m, i) => (
        <div key={m.iso}>
          {i % 2 === 1 && <div className="tl-month-tint" style={{ left: m.left, width: m.w }} />}
          <div className="tl-month" style={{ left: Math.max(m.left, 0) + 10 }}>
            {monthShort(m.iso)} {m.iso.slice(0, 4)}
          </div>
        </div>
      ))}
      {days.map((d) => {
        const iso = fromDayIndex(d);
        const wk = (d + 3) % 7 >= 5;
        return (
          <div key={d} className={`tl-day${wk ? ' weekend' : ''}`} style={{ left: (d - origin) * ppd, width: ppd }}>
            {ppd >= 34 ? `${weekdayShort(iso)[0]} ${dayOfMonth(iso)}` : dayOfMonth(iso)}
          </div>
        );
      })}

      <div
        className={`week-band${bandDrag ? ' dragging' : ''}`}
        style={{ left: x(week), width: ppd * 7 }}
        onPointerDown={onBandDown}
        title="Drag to choose the week shown below"
      >
        {ppd * 7 >= 70 && <div className="week-band-label">Week {weekNum}</div>}
      </div>

      {ghost && !drag && (
        <div className="tl-project ghost" style={{ left: (ghost.day - origin) * ppd, width: ppd * 7, top: projectTop + ghost.lane * ROW_H }}>
          New project
        </div>
      )}

      {deadlines.map((d) => {
        const live = dlDrag?.id === d.id ? dlDrag.date : dayIndex(d.date);
        return (
          <div
            key={d.id}
            className={`tl-deadline${selectedId === d.id ? ' selected' : ''}${dlDrag?.id === d.id ? ' live' : ''}`}
            style={{ left: (live - origin) * ppd, top: HEADER_H + (dlLanes.get(d) ?? 0) * DEADLINE_ROW_H }}
            onPointerDown={(e) => onDeadlineDown(e, d)}
            title={`${d.name} · ${formatShort(d.date)}`}
          >
            <Star />
            <span className="label">{d.name}{dlDrag?.id === d.id && <span className="tl-project-dates"> · {formatShort(fromDayIndex(live))}</span>}</span>
          </div>
        );
      })}

      {projects.map((p, i) => {
        const live = drag?.id === p.id ? drag : null;
        const s = live ? live.start : dayIndex(p.start);
        const en = live ? live.end : dayIndex(p.end);
        const lane = live ? live.lane : p.lane;
        const left = (s - origin) * ppd;
        const w = Math.max(ppd, (en - s + 1) * ppd);
        const color = projectColor(p, i);
        const editing = editingId === p.id;
        return (
          <div
            key={p.id}
            className={`tl-project${selectedId === p.id ? ' selected' : ''}${live ? ' live' : ''}`}
            style={{
              left,
              width: w,
              top: projectTop + lane * ROW_H,
              ['--pc' as string]: color,
              paddingLeft: Math.max(12, Math.min(w - 12, 12 - left)),
              cursor: live ? (live.mode === 'move' ? 'grabbing' : 'ew-resize') : hoverCursor || 'grab',
            }}
            onPointerDown={(e) => onProjectDown(e, p)}
            onPointerMove={onProjectHover}
            title={`${p.name} · ${formatShort(p.start)} – ${formatShort(p.end)}`}
          >
            {editing ? <InlineName initial={p.name} onDone={(name) => onRename(p.id, name)} /> : p.name}
            {live && (
              <span className="tl-project-dates">
                {formatShort(fromDayIndex(s))} – {formatShort(fromDayIndex(en))}
              </span>
            )}
          </div>
        );
      })}

      <div className="today-line" style={{ left: x(today) + ppd / 2 }} />

      {projects.length === 0 && deadlines.length === 0 && !ghost && (
        <div className="hint" style={{ position: 'absolute', left: 26, top: HEADER_H + 20 }}>
          Click anywhere to start a project.
        </div>
      )}
    </div>
  );
}

/** Focused text field shown inside a freshly created bar/row; commits on Enter or blur. */
export function InlineName({ initial, onDone, placeholder = 'Name…' }: { initial: string; onDone: (name: string) => void; placeholder?: string }) {
  const [v, setV] = useState(initial === 'New project' || initial === 'New task' ? '' : initial);
  const done = useRef(false);
  const finish = () => { if (done.current) return; done.current = true; onDone(v.trim()); };
  return (
    <input
      className="inline-name"
      autoFocus
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') { setV(''); finish(); } }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

export function Star({ size = 18 }: { size?: number }) {
  return (
    <svg className="star" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z" />
    </svg>
  );
}
