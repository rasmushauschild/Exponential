import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Deadline, Group, ISODate, Person, Project } from './types';
import { NO_GROUP_COLOR, crispColor } from './types';
import { dayIndex, dayOfMonth, formatShort, fromDayIndex, isoWeekNumber, monthShort, weekStart, weekdayShort } from './dates';
import { Avatar } from './WeekPlan';

const ROW_H = 32; // = the square dot grid: one dot row per lane boundary
const DEADLINE_ROW_H = 30;
const HEADER_H = 44; // month + day labels; tints and the band start below this
const RETRO_H = 30; // strip along the bottom that shows week labels / opens the retro
const GROUP_H = 32; // group label row above each section — one full lane, so the dot grid stays aligned
const GROUP_GAP = 0; // any gap would knock sections off the 19px dot grid
const MIN_PPD = 4;
const MAX_PPD = 90;
const EDGE = 10; // px from a bar's end that acts as a resize handle

interface Props {
  projects: Project[];
  groups: Group[];
  deadlines: Deadline[];
  people: Person[];
  locked: boolean; // read-only: open and navigate, but no creating or moving
  onAddGroup: () => void;
  today: ISODate;
  week: ISODate;
  selectedId?: string;
  selectedIds?: Set<string>; // multi-selection (shift/cmd-click)
  editingId?: string;
  onToggleSelect: (id: string) => void;
  onWeekChange: (monday: ISODate) => void;
  onOpenProject: (p: Project) => void;
  onOpenDeadline: (d: Deadline) => void;
  onMoveProject: (id: string, patch: Pick<Project, 'start' | 'end' | 'lane' | 'groupId'>) => void;
  onMoveMany: (ids: string[], deltaDays: number) => void; // shift a multi-selection in time
  onDeleteProject: (id: string) => void;
  onDeleteMany?: (ids: string[]) => void; // right-click Delete with a multi-selection
  onOpenGroup: (g: Group) => void;
  onMoveDeadline: (id: string, date: ISODate) => void;
  onCreateProject: (start: ISODate, lane: number, groupId?: string) => void;
  onRename: (id: string, name: string) => void;
  onStartRename: (id: string) => void; // double-click on a bar
  onOpenRetro: (monday: ISODate) => void;
  onCreateDeadline: (date: ISODate) => void;
  onRenameDeadline: (id: string, name: string) => void;
}

export function projectColor(p: Project, groups: Group[]) {
  return crispColor(groups.find((g) => g.id === p.groupId)?.color ?? NO_GROUP_COLOR);
}

type Drag = { id: string; mode: 'move' | 'start' | 'end'; start: number; end: number; lane: number; groupId?: string; moved: boolean; dd?: number; ids?: string[] };
type Section = { groupId?: string; name: string; color: string; headerTop: number; laneTop: number; lanes: number };
type View = { ppd: number; origin: number };

export function BigPlan(props: Props) {
  const { projects, groups, deadlines, people, locked, onAddGroup, today, week, selectedId, selectedIds, editingId, onToggleSelect, onWeekChange, onOpenProject, onOpenDeadline, onMoveProject, onMoveMany, onDeleteProject, onDeleteMany, onMoveDeadline, onCreateProject, onRename, onStartRename, onOpenRetro, onCreateDeadline, onRenameDeadline, onOpenGroup } = props;
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
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null); // right-click menu on a bar
  const [hoverCursor, setHoverCursor] = useState<string>('');
  const [ghost, setGhost] = useState<{ day: number; lane: number; groupId?: string } | null>(null);
  const [hoverWeek, setHoverWeek] = useState<number | null>(null); // day index of a Monday
  const [scrollY, setScrollY] = useState(0); // vertical offset of the lanes when they don't fit
  const scrollRef = useRef(0);
  scrollRef.current = scrollY;
  // Vertical layout: one section per group (then ungrouped), each with its projects' lanes plus a spare lane.
  const sections: Section[] = (() => {
    const list: Section[] = [];
    const ordered = [...groups].sort((a, b) => a.sort - b.sort);
    const keys: (string | undefined)[] = [...ordered.map((g) => g.id), undefined];
    let y = HEADER_H + DEADLINE_ROW_H + 10;
    for (const gid of keys) {
      const inGroup = projects.filter((p) => (p.groupId ?? undefined) === gid || (gid === undefined && (!p.groupId || !groups.some((g) => g.id === p.groupId))));
      const g = ordered.find((x) => x.id === gid);
      // Unlocked, the ungrouped section's label doubles as the "Add group" button, so it must exist even with no groups.
      const showHeader = groups.length > 0 || !locked;
      const headerTop = y;
      if (showHeader) y += GROUP_H;
      // Compact: no spare lane (only the last, ungrouped section keeps one). Dropping a project onto a
      // group's label row appends it as a new row of that group, so the layout never jumps while dragging.
      const spare = gid === undefined ? 1 : 0;
      const lanes = Math.max(1, inGroup.reduce((m, p) => Math.max(m, p.lane + 1), 0) + spare);
      list.push({ groupId: gid, name: g?.name ?? 'No group', color: crispColor(g?.color ?? NO_GROUP_COLOR), headerTop, laneTop: y, lanes });
      y += lanes * ROW_H + GROUP_GAP;
    }
    return list;
  })();
  const sectionOf = (gid?: string) => sections.find((s) => s.groupId === gid) ?? sections[sections.length - 1];
  const laneCount = sections.reduce((m, s) => m + s.lanes, 0);
  const weekRef = useRef(week);
  weekRef.current = week;
  // The band eases between weeks by default; while the timeline itself moves (pan/zoom) it must
  // stay glued to the days, so `viewMoving` suppresses the transition until scrolling stops.
  const [viewMoving, setViewMoving] = useState(false);
  const movingTimer = useRef<number | undefined>(undefined);
  const touchView = () => {
    setViewMoving(true);
    window.clearTimeout(movingTimer.current);
    movingTimer.current = window.setTimeout(() => setViewMoving(false), 120);
  };
  const [height, setHeight] = useState(0);

  // The dot grid rides along when the plan pans, but zooming must not move it: panning
  // changes origin at fixed ppd (dots follow), while a ppd change folds into `comp` so
  // the grid's screen position stays exactly where it was.
  const dotRef = useRef({ prev: 0, prevPpd: 0, comp: 0 });
  {
    const cur = origin * ppd;
    if (dotRef.current.prevPpd !== ppd) dotRef.current.comp += cur - dotRef.current.prev;
    dotRef.current.prev = cur;
    dotRef.current.prevPpd = ppd;
  }
  const dotX = 9 - (origin * ppd - dotRef.current.comp);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); setHeight(el.clientHeight); });
    ro.observe(el);
    setWidth(el.clientWidth);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Wheel: pinch (ctrlKey) zooms so the day under the cursor stays put; otherwise scroll horizontally.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!(e.ctrlKey || e.metaKey) && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) { setScrollY(clampRef.current(scrollRef.current + e.deltaY)); return; }
      touchView();
      if (e.ctrlKey || e.metaKey) {
        const mx = e.clientX - el.getBoundingClientRect().left;
        const next = Math.min(MAX_PPD, Math.max(MIN_PPD, v.ppd * Math.exp(-e.deltaY * 0.01)));
        const dayUnderCursor = v.origin + mx / v.ppd;
        viewRef.current = { ppd: next, origin: dayUnderCursor - mx / next };
      } else {
        // Sideways scrolling pans the timeline; vertical scrolling moves the lanes when they overflow.
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) { setScrollY(clampRef.current(scrollRef.current + e.deltaY)); return; }
        viewRef.current = { ppd: v.ppd, origin: v.origin + e.deltaX / v.ppd };
      }
      setView(viewRef.current);
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

  const projectTop = HEADER_H + DEADLINE_ROW_H + 10; // the deadline row is always there (hover it to add one)
  const lastSec = sections[sections.length - 1];
  const contentH = lastSec.laneTop + lastSec.lanes * ROW_H + RETRO_H;
  const clampScroll = (y: number) => Math.max(0, Math.min(y, Math.max(0, contentH - height)));
  const clampRef = useRef(clampScroll);
  clampRef.current = clampScroll; // the wheel listener is bound once; it must see the current sizes
  useEffect(() => { setScrollY((y) => clampScroll(y)); }, [height, laneCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const inDeadlineRow = (clientY: number) => { const y = clientY - ref.current!.getBoundingClientRect().top; return y >= HEADER_H && y < HEADER_H + DEADLINE_ROW_H; };
  const inRetroStrip = (clientY: number) => clientY - ref.current!.getBoundingClientRect().top > height - RETRO_H;

  /** Day under the cursor, plus the section/lane if the cursor is inside a section's lanes (lane -2 = nowhere). */
  const slotAt = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const day = Math.floor(origin + (clientX - rect.left) / ppd);
    const yc = clientY - rect.top + scrollY;
    for (const sec of sections) {
      if (yc >= sec.laneTop && yc < sec.laneTop + sec.lanes * ROW_H) return { day, lane: Math.floor((yc - sec.laneTop) / ROW_H), groupId: sec.groupId };
      if ((groups.length > 0 || !locked) && yc >= sec.headerTop && yc < sec.laneTop) return { day, lane: sec.lanes, groupId: sec.groupId }; // label row = append to this group
    }
    return { day, lane: -2, groupId: undefined as string | undefined };
  };

  const isEmptyTarget = (t: EventTarget | null) => !(t as HTMLElement).closest('.week-band, .tl-project, .tl-deadline, .week-label, .tl-group');

  // Empty space: a still click creates a week-long project at the ghost; a drag pans.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !isEmptyTarget(e.target)) return;
    e.preventDefault();
    const startX = e.clientX;
    const startOrigin = origin;
    let moved = false;
    setGhost(null);
    track(
      (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        if (moved) { touchView(); setPanning(true); setView({ ppd, origin: startOrigin - (ev.clientX - startX) / ppd }); }
      },
      (ev) => {
        setPanning(false);
        if (locked || moved || inRetroStrip(ev.clientY)) return;
        const { day, lane, groupId } = slotAt(ev.clientX, ev.clientY);
        if (inDeadlineRow(ev.clientY)) onCreateDeadline(fromDayIndex(day));
        else if (lane >= 0) onCreateProject(fromDayIndex(day), lane, groupId);
      },
    );
  };

  const onHover = (e: React.PointerEvent) => {
    if (drag || dlDrag || panning || bandDrag) return;
    const { day, lane, groupId } = slotAt(e.clientX, e.clientY);
    setHoverWeek(dayIndex(weekStart(fromDayIndex(day))));
    if (locked || !isEmptyTarget(e.target) || inRetroStrip(e.clientY)) { setGhost(null); return; }
    if (inDeadlineRow(e.clientY)) { setGhost({ day, lane: -1 }); return; } // lane -1 = deadline row
    setGhost(lane >= 0 ? { day, lane, groupId } : null);
  };

  const onBandDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startWeek = dayIndex(week);
    setBandDrag(true);
    // Snaps to the nearest week as the cursor moves; the .dragging class gives it a quick smooth slide.
    track((ev) => {
      const shift = Math.round((ev.clientX - startX) / ppd / 7) * 7;
      const next = fromDayIndex(startWeek + shift);
      if (next !== weekRef.current) onWeekChange(next);
    }, () => setBandDrag(false));
  };

  /** Locked: a still click opens (or modifier-toggles) the item; any drag does nothing. */
  const clickOnly = (e: React.PointerEvent, open: () => void, toggle: () => void) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    let moved = false;
    track(
      (ev) => { if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) moved = true; },
      () => { if (!moved) { if (multi) toggle(); else open(); } },
    );
  };

  const onProjectDown = (e: React.PointerEvent, p: Project) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (locked) { clickOnly(e, () => onOpenProject(p), () => onToggleSelect(p.id)); return; }
    e.stopPropagation();
    e.preventDefault();
    // Dragging a bar that's part of the multi-selection moves the whole selection in time.
    const groupSel = selectedIds?.has(p.id) ? projects.filter((x) => selectedIds.has(x.id)).map((x) => x.id) : [];
    const asGroup = groupSel.length > 1;
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    const mode: Drag['mode'] = asGroup ? 'move' : local < EDGE ? 'start' : bar.width - local < EDGE ? 'end' : 'move';
    const s0 = dayIndex(p.start), e0 = dayIndex(p.end), lane0 = p.lane;
    const startX = e.clientX, startY = e.clientY;
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    document.body.classList.add(mode === 'move' ? 'cursor-grabbing' : 'cursor-ew'); // steady cursor between day snaps
    const d: Drag = { id: p.id, mode, start: s0, end: e0, lane: lane0, groupId: p.groupId, moved: false, dd: 0, ids: asGroup ? groupSel : undefined };
    setDrag(d);
    let latest = d;
    const grabOffset = startY - (ref.current!.getBoundingClientRect().top + sectionOf(p.groupId).laneTop + lane0 * ROW_H - scrollY); // where in the row the bar was grabbed
    track(
      (ev) => {
        const dd = Math.round((ev.clientX - startX) / ppd);
        const moved = latest.moved || Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3;
        if (asGroup) latest = { ...d, start: s0 + dd, end: e0 + dd, moved, dd };
        else if (mode === 'move') {
          const slot = slotAt(ev.clientX, ev.clientY - grabOffset + ROW_H / 2);
          const lane = slot.lane >= 0 ? slot.lane : latest.lane;
          const groupId = slot.lane >= 0 ? slot.groupId : latest.groupId;
          latest = { ...d, start: s0 + dd, end: e0 + dd, lane, groupId, moved, dd };
        }
        else if (mode === 'start') latest = { ...d, start: Math.min(s0 + dd, e0), moved };
        else latest = { ...d, end: Math.max(e0 + dd, s0), moved };
        setDrag(latest);
      },
      () => {
        document.body.classList.remove('cursor-grabbing', 'cursor-ew');
        setDrag(null);
        if (!latest.moved) { if (multi) onToggleSelect(p.id); else onOpenProject(p); }
        else if (asGroup) { if (latest.dd) onMoveMany(groupSel, latest.dd); }
        else onMoveProject(p.id, { start: fromDayIndex(latest.start), end: fromDayIndex(latest.end), lane: latest.lane, groupId: latest.groupId });
      },
    );
  };

  const onDeadlineDown = (e: React.PointerEvent, d: Deadline) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (locked) { clickOnly(e, () => onOpenDeadline(d), () => onToggleSelect(d.id)); return; }
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const d0 = dayIndex(d.date);
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    let latest = d0, moved = false;
    document.body.classList.add('cursor-grabbing');
    setDlDrag({ id: d.id, date: d0 });
    track(
      (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        latest = d0 + Math.round((ev.clientX - startX) / ppd);
        setDlDrag({ id: d.id, date: latest });
      },
      () => {
        document.body.classList.remove('cursor-grabbing');
        setDlDrag(null);
        if (!moved) { if (multi) onToggleSelect(d.id); else onOpenDeadline(d); }
        else if (latest !== d0) onMoveDeadline(d.id, fromDayIndex(latest));
      },
    );
  };

  useEffect(() => {
    if (!ctx) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.ctx-menu')) setCtx(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [ctx]);

  const onProjectHover = (e: React.PointerEvent) => {
    if (locked) { setHoverCursor('pointer'); return; }
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
  if (ppd >= 20) for (let d = firstDay; d <= lastDay; d++) days.push(d);
  // Every other week is tinted; parity is anchored to the calendar so zooming never swaps them.
  const weeks: number[] = [];
  for (let m = dayIndex(weekStart(fromDayIndex(firstDay))); m <= lastDay; m += 7) weeks.push(m);

  // Deadlines share one row: each label may only use the space up to the next star.
  const dlSorted = [...deadlines].sort((a, b) => a.date.localeCompare(b.date));
  // centred on the day, like the today line
  const dlLeft = (d: Deadline) => ((dlDrag?.id === d.id ? dlDrag.date : dayIndex(d.date)) - origin) * ppd + ppd / 2;

  const weekNum = isoWeekNumber(week);

  return (
    <div
      ref={ref}
      className={`timeline${panning ? ' panning' : ''}${drag || dlDrag ? ' dragging-item' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onHover}
      onPointerLeave={() => { setGhost(null); setHoverWeek(null); }}
    >
      <div className="tl-dots" style={{ transform: `translate(${(((dotX % 32) + 32) % 32)}px, ${(((-scrollY % 32) + 32) % 32)}px)` }} />
      {weeks.map((m) => {
        const odd = Math.floor(m / 7) % 2 === 1;
        const hovered = hoverWeek === m;
        return (
          <div key={m}>
            {odd && <div className="tl-week-tint" style={{ left: (m - origin) * ppd, width: ppd * 7 }} />}
            {hovered && m !== dayIndex(week) && ppd * 7 >= 70 && (
              <button
                className="week-label hover"
                style={{ left: (m - origin + 3.5) * ppd }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onOpenRetro(fromDayIndex(m))}
                title="Open this week's retro"
              >
                Week {isoWeekNumber(fromDayIndex(m))}
              </button>
            )}
          </div>
        );
      })}
      {months.map((m) => (
        <div key={m.iso} className="tl-month" style={{ left: Math.min(Math.max(m.left, 0), m.left + m.w - 70) + 18, opacity: m.w < 40 ? 0 : 1 }} /* +18 (+8px CSS padding) = 26px, flush with the panel title */>
          {monthShort(m.iso)} {m.iso.slice(0, 4)}
        </div>
      ))}
      {days.map((d) => {
        const iso = fromDayIndex(d);
        const wk = (d + 3) % 7 >= 5;
        return (
          <div key={d} className={`tl-day${wk ? ' weekend' : ''}`} style={{ left: (d - origin) * ppd, width: ppd }}>
            {ppd >= 40 ? `${weekdayShort(iso)[0]} ${dayOfMonth(iso)}` : dayOfMonth(iso)}
          </div>
        );
      })}

      <div
        className={`week-band${bandDrag ? ' dragging' : viewMoving || panning ? ' no-anim' : ''}`}
        style={{ left: x(week), width: ppd * 7 }}
        onPointerDown={onBandDown}
        title="Drag to choose the week shown below"
      >
        {ppd * 7 >= 70 && (
          <button className="week-label current" onPointerDown={(e) => e.stopPropagation()} onClick={() => onOpenRetro(week)} title="Open this week's retro">
            Week {weekNum}
          </button>
        )}
      </div>

      {ghost && !drag && ghost.lane === -1 && (
        <div className="tl-deadline ghost" style={{ left: (ghost.day - origin) * ppd + ppd / 2, top: HEADER_H }}>
          <span className="dot" /><span className="label">New deadline</span>
        </div>
      )}

      {dlSorted.map((d, i) => {
        const live = dlDrag?.id === d.id ? dlDrag.date : dayIndex(d.date);
        const left = dlLeft(d);
        const next = dlSorted[i + 1];
        const room = next ? dlLeft(next) - left - 26 : Infinity;
        return (
          <div
            key={d.id}
            className={`tl-deadline${selectedId === d.id || selectedIds?.has(d.id) ? ' selected' : ''}${dlDrag?.id === d.id ? ' live' : ''}`}
            style={{ left, top: HEADER_H, maxWidth: Number.isFinite(room) ? Math.max(22, room + 22) : undefined }}
            onPointerDown={(e) => onDeadlineDown(e, d)}
            title={`${d.name} · ${formatShort(d.date)}`}
          >
            <span className="dot" />
            {editingId === d.id
              ? <InlineName initial="" placeholder="Deadline…" onDone={(name) => onRenameDeadline(d.id, name)} />
              : room > 28 && (
                <span className="label">{d.name}{dlDrag?.id === d.id && <span className="tl-project-dates"> · {formatShort(fromDayIndex(live))}</span>}</span>
              )}
          </div>
        );
      })}

      <div className="tl-lanes" style={{ top: projectTop - 6 }}>
      {ghost && !drag && ghost.lane >= 0 && (
        <div className="tl-project ghost" style={{ left: (ghost.day - origin) * ppd, width: ppd * 7, top: sectionOf(ghost.groupId).laneTop - projectTop + 3 + ghost.lane * ROW_H - scrollY }}>
          New project
        </div>
      )}
      {sections.map((sec) => (groups.length > 0 || !locked) && (
        <button key={sec.groupId ?? 'none'} className={`tl-group${sec.groupId ? '' : ' none'}${!sec.groupId && !locked ? ' add' : ''}`} style={{ top: sec.headerTop - projectTop + 6 - scrollY }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { const g = groups.find((x) => x.id === sec.groupId); if (g) onOpenGroup(g); else if (!locked) onAddGroup(); }}>
          {sec.groupId || locked
            ? <><span className="dot" style={{ background: sec.color }} /> {sec.name}</>
            : <>+ Add group</>}
        </button>
      ))}
      {projects.map((p) => {
        const live = drag?.id === p.id ? drag : null;
        // Bars in the dragged multi-selection follow the grabbed one in time.
        const follow = !live && drag?.ids?.includes(p.id) ? drag.dd ?? 0 : 0;
        const s = live ? live.start : dayIndex(p.start) + follow;
        const en = live ? live.end : dayIndex(p.end) + follow;
        const lane = live ? live.lane : p.lane;
        const sec = sectionOf(live ? live.groupId : p.groupId);
        // 2px shaved off each end: bars that meet on a date keep a slight gap
        const left = (s - origin) * ppd + 2;
        const w = Math.max(ppd - 4, (en - s + 1) * ppd - 4);
        const color = projectColor(p, groups);
        const editing = editingId === p.id;
        return (
          <div
            key={p.id}
            className={`tl-project${selectedId === p.id || selectedIds?.has(p.id) ? ' selected' : ''}${live || follow ? ' live' : ''}${!p.groupId || !groups.some((g) => g.id === p.groupId) ? ' nogroup' : ''}`}
            style={{
              left,
              width: w,
              top: sec.laneTop - projectTop + 3 + lane * ROW_H - scrollY,
              ['--pc' as string]: color,
              paddingLeft: Math.max(12, Math.min(w - 12, 12 - left)),
              cursor: locked ? 'pointer' : live ? (live.mode === 'move' ? 'grabbing' : 'ew-resize') : hoverCursor || 'grab',
            }}
            onPointerDown={(e) => onProjectDown(e, p)}
            onPointerMove={onProjectHover}
            onDoubleClick={(e) => { if (!locked) { e.stopPropagation(); onStartRename(p.id); } }}
            onContextMenu={(e) => { if (locked) return; e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, id: p.id }); }}
            title={`${p.name} · ${formatShort(p.start)} – ${formatShort(p.end)}`}
          >
            {editing ? <InlineName initial={p.name} onDone={(name) => onRename(p.id, name)} /> : <span className="tl-project-name">{p.name}</span>}
            {!!p.assignees?.length && !editing && (
              <span className="bar-avatars">
                {p.assignees.map((id) => people.find((x) => x.id === id)).filter(Boolean).map((x) => <Avatar key={x!.id} person={x!} size={18} />)}
              </span>
            )}
            {live && (
              <span className="tl-project-dates">
                {formatShort(fromDayIndex(s))} – {formatShort(fromDayIndex(en))}
              </span>
            )}
          </div>
        );
      })}
      </div>

      <div className="today-line" style={{ left: x(today) + ppd / 2 }} />

      {ctx && createPortal(
        <div className="status-menu ctx-menu" style={{ position: 'fixed', left: Math.min(ctx.x, window.innerWidth - 180), top: Math.min(ctx.y, window.innerHeight - 52) }} onPointerDown={(e) => e.stopPropagation()}>
          {(() => {
            const many = !!selectedIds?.has(ctx.id) && selectedIds.size > 1 && !!onDeleteMany;
            return (
              <button className="danger" onClick={() => { if (many) onDeleteMany!([...selectedIds!]); else onDeleteProject(ctx.id); setCtx(null); }}>
                {many ? `Delete ${selectedIds!.size} items` : 'Delete'}
              </button>
            );
          })()}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Focused text field shown inside a freshly created bar/row; commits on Enter or blur. */
export function InlineName({ initial, onDone, placeholder = 'Name…' }: { initial: string; onDone: (name: string, viaEnter?: boolean) => void; placeholder?: string }) {
  const [v, setV] = useState(initial === 'New project' || initial === 'New task' ? '' : initial);
  const done = useRef(false);
  const finish = (viaEnter = false) => { if (done.current) return; done.current = true; onDone(v.trim(), viaEnter); };
  return (
    <input
      className="inline-name"
      autoFocus
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(false)}
      onKeyDown={(e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { setV(''); finish(false); } }}
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
