import { useCallback, useEffect, useRef, useState } from 'react';
import { BigPlan } from './BigPlan';
import { Avatar, WeekPlan } from './WeekPlan';
import { DetailPanel, type Selection } from './DetailPanel';
import { TeamPage } from './TeamPage';
import logoUrl from '../build/icon.png';
import { useData, uid, type GoogleConfig } from './store';
import type { CalendarEvent, Data, Deadline, GoogleUser, ISODate, Project, Retro, Task } from './types';
import { DEFAULT_RETRO_FIELDS, shortName } from './types';
import { addTask, nameOf, notify, patchTask, renameTask, reorderTask } from './taskOps';
import { isPending, signOutCloud, supabase } from './cloud';
import { addDays, todayISO, weekStart } from './dates';

/** Layout proportions, remembered per machine (not part of the shared plan data). */
const PREFS_KEY = 'exponential-layout';
const DEFAULT_PREFS = { weekH: 400, detailW: 415, theme: '' as '' | 'light' | 'dark', calendar: false };
const prefs: typeof DEFAULT_PREFS = (() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return DEFAULT_PREFS; }
})();
const savePrefs = (p: typeof DEFAULT_PREFS) => localStorage.setItem(PREFS_KEY, JSON.stringify(p));

export default function App() {
  const { data, teams, update, undo, redo, switchTeam, createTeam, connectCloud, cloudMode } = useData();
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [view, setView] = useState<'plan' | 'team'>('plan');
  const [today, setToday] = useState(todayISO());
  const [week, setWeek] = useState(() => weekStart(todayISO()));
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [weekH, setWeekH] = useState(() => prefs.weekH);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sheet, setSheet] = useState<'project' | 'deadline' | 'settings' | 'new-team' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [multi, setMulti] = useState<Set<string>>(new Set()); // shift/cmd-click selection across both panels
  const toggleSelect = (id: string) => setMulti((m) => {
    const n = new Set(m);
    // the item open in the side panel looks selected, so it joins the multi-selection on the first modifier-click
    if (n.size === 0 && selection && ['project', 'task', 'deadline'].includes(selection.kind) && selection.id !== id) n.add(selection.id);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const [resizing, setResizing] = useState(false);
  const [detailW, setDetailW] = useState(() => prefs.detailW);
  const [slotAnimating, setSlotAnimating] = useState(false); // clip the slot only while its width is changing
  const openKind = selection?.kind ?? null;
  const prevOpenKind = useRef(openKind);
  useEffect(() => {
    const wasOpen = prevOpenKind.current !== null, isOpen = openKind !== null;
    prevOpenKind.current = openKind;
    if (wasOpen !== isOpen) setSlotAnimating(true);
  }, [openKind]);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => prefs.theme || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const [calendarOn, setCalendarOn] = useState(() => prefs.calendar);
  useEffect(() => { savePrefs({ weekH, detailW, theme, calendar: calendarOn }); }, [weekH, detailW, theme, calendarOn]);
  const [vResizing, setVResizing] = useState(false);

  const onVResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = detailW;
    setVResizing(true);
    const move = (ev: PointerEvent) => setDetailW(Math.min(Math.max(360, window.innerWidth - 760), Math.max(300, startW - (ev.clientX - startX))));
    const up = () => { setVResizing(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const mainRef = useRef<HTMLDivElement>(null);

  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null);
  const [authChecked, setAuthChecked] = useState(!window.exponential); // browser preview has no Google
  const [googleConfig, setGoogleConfig] = useState<GoogleConfig | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [calEvents, setCalEvents] = useState<Record<string, CalendarEvent[]>>({});
  const [calNote, setCalNote] = useState<string | undefined>();

  useEffect(() => {
    const t = setInterval(() => setToday(todayISO()), 60_000);
    return () => clearInterval(t);
  }, []);

  // ⌘Z / ⌘⇧Z (Ctrl on Windows); Backspace/Delete removes the multi-selection; Escape clears it.
  // Text fields keep their own keys while focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.key === 'Backspace' || e.key === 'Delete') && multi.size) {
        e.preventDefault();
        update((d) => ({
          ...d,
          projects: d.projects.filter((p) => !multi.has(p.id)),
          deadlines: d.deadlines.filter((x) => !multi.has(x.id)),
          tasks: d.tasks.filter((t) => !multi.has(t.id)),
        }));
        if (selection && multi.has(selection.id)) setSelection(null);
        setMulti(new Set());
      }
      if (e.key === 'Escape' && multi.size) setMulti(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, multi, selection, update]);

  const updateTask = (id: string, patch: Partial<Task>, coalesce?: string) => update((d) => patchTask(d, id, patch), coalesce);

  /** Project edits notify everyone assigned (except the editor). */
  const updateProject = (id: string, patch: Partial<Project>, coalesce?: string) =>
    update((d) => {
      const before = d.projects.find((p) => p.id === id);
      if (!before) return d;
      const after = { ...before, ...patch };
      let next: Data = { ...d, projects: d.projects.map((p) => (p.id === id ? after : p)) };
      const what = patch.name !== undefined && patch.name !== before.name ? 'renamed' : patch.start || patch.end ? 'moved' : patch.notes !== undefined ? 'updated the notes of' : patch.assignees ? null : 'changed';
      if (patch.assignees) {
        for (const pid of patch.assignees.filter((x) => !before.assignees?.includes(x))) {
          next = notify(next, { to: pid, from: d.me, kind: 'project-changed', text: `${nameOf(d, d.me)} added you to “${after.name}”`, ref: { kind: 'project', id } });
        }
      } else if (what && !coalesce) {
        for (const pid of after.assignees ?? []) {
          next = notify(next, { to: pid, from: d.me, kind: 'project-changed', text: `${nameOf(d, d.me)} ${what} “${after.name}”`, ref: { kind: 'project', id } });
        }
      }
      return next;
    }, coalesce);

  // The menu-bar widget can ask the main window to open a specific item.
  useEffect(() => window.exponential?.onOpen((t) => { setView('plan'); setSelection(t as Selection); }), []);

  // Google: restore session on launch.
  useEffect(() => {
    const g = window.exponential?.google;
    if (!g) return;
    g.getConfig().then(setGoogleConfig);
    g.status().then((u) => { if (u) setGoogleUser(u); }).finally(() => setAuthChecked(true));
  }, []);

  // Once signed in: open the Supabase session and load the team; keep the profile's name/photo fresh.
  useEffect(() => {
    if (!googleUser || !window.exponential) return;
    let cancelled = false;
    connectCloud()
      .then(async (ok) => {
        if (cancelled || !ok) return;
        const { data: u } = await supabase.auth.getUser();
        if (u.user) await supabase.from('profiles').update({ name: googleUser.name, photo: googleUser.picture ?? null }).eq('id', u.user.id);
      })
      .catch((err: Error) => { if (!cancelled) setCloudError(err.message); });
    return () => { cancelled = true; };
  }, [googleUser, connectCloud]);

  const person = selectedPerson ?? data?.me ?? '';

  // Fetch the selected person's calendar for the visible week.
  useEffect(() => {
    if (!data || !calendarOn || !googleUser || !window.exponential) return;
    const p = data.people.find((x) => x.id === person);
    const calendarId = p?.id === data.me ? 'primary' : p?.email;
    if (!calendarId) { setCalNote(`${shortName(p?.name ?? '')} hasn't signed in with Google yet`); return; }
    const key = `${calendarId}|${week}`;
    if (calEvents[key]) { setCalNote(undefined); return; }
    let cancelled = false;
    setCalNote('Loading…');
    window.exponential.google.events(calendarId, week, addDays(week, 6))
      .then((ev) => { if (!cancelled) { setCalEvents((c) => ({ ...c, [key]: ev })); setCalNote(undefined); } })
      .catch((err: Error) => {
        if (cancelled) return;
        setCalNote(/404|403/.test(err.message) ? 'Calendar not shared with you' : err.message);
        setCalEvents((c) => ({ ...c, [key]: [] }));
      });
    return () => { cancelled = true; };
  }, [data, calendarOn, googleUser, person, week, calEvents]);

  const signIn = useCallback(async () => {
    const g = window.exponential?.google;
    if (!g) return;
    setAuthError(null);
    try {
      setGoogleUser(await g.signIn());
      setSheet(null);
    } catch (err) {
      setAuthError((err as Error).message);
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutCloud();
    await window.exponential?.google.signOut();
    setGoogleUser(null);
    setCalEvents({});
    window.location.reload();
  }, []);

  if (!authChecked) return null;

  // Desktop app: sign in with Google before anything else (name, photo, email and calendar access).
  if (window.exponential && !googleUser) {
    return (
      <SignInGate
        config={googleConfig}
        error={authError}
        onSaveConfig={async (c) => { await window.exponential!.google.setConfig(c); setGoogleConfig(c); }}
        onSignIn={signIn}
      />
    );
  }

  if (window.exponential && !cloudMode) {
    return (
      <div className="gate">
        <div className="gate-card">
          <img className="gate-logo" src={logoUrl} alt="" />
          {cloudError ? <p className="error">{cloudError}</p> : <p className="hint">Loading your teams…</p>}
        </div>
      </div>
    );
  }
  if (!data) return null;

  const onResizeDown = (e: React.PointerEvent) => {
    const rect = mainRef.current!.getBoundingClientRect();
    setResizing(true);
    const move = (ev: PointerEvent) => setWeekH(Math.min(rect.height - 200, Math.max(160, rect.bottom - ev.clientY - 7)));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };

  const isThisWeek = week === weekStart(today);
  const me = data.people.find((p) => p.id === data.me)!;
  const selProject = selection?.kind === 'project' ? data.projects.find((p) => p.id === selection.id) : undefined;
  const selTask = selection?.kind === 'task' ? data.tasks.find((t) => t.id === selection.id) : undefined;
  const selDeadline = selection?.kind === 'deadline' ? data.deadlines.find((d) => d.id === selection.id) : undefined;
  const detailOpen = !!(selProject || selTask || selDeadline) || selection?.kind === 'retro' || selection?.kind === 'inbox';
  const unread = (data.notifications ?? []).filter((n) => n.to === data.me && !n.read).length;

  const calKey = `${person === data.me ? 'primary' : data.people.find((x) => x.id === person)?.email}|${week}`;

  return (
    <div className="shell">
      <aside className={`sidebar${window.exponential?.platform === 'darwin' ? ' mac' : ''}`}>
       <div className="sidebar-inner">
        <div className="team-list">
          {teams.map((t) => (
            <div key={t.id} className={`team-row${t.id === data.id ? ' current' : ''}`} title={t.name}>
              <button className="team-main" onClick={() => { if (t.id !== data.id) { switchTeam(t.id); setSelection(null); setSelectedPerson(null); setView('plan'); } else setView('plan'); }}>
                <TeamMark team={t} />
                <span className="team-name">{t.name}</span>
              </button>
              <button className={`team-cog${t.id === data.id && view === 'team' ? ' on' : ''}`} title="Team settings"
                onClick={() => { if (t.id !== data.id) { switchTeam(t.id); setSelection(null); setSelectedPerson(null); } setView('team'); }}>
                <CogIcon />
              </button>
            </div>
          ))}
          <button className="team-row add" onClick={() => setSheet('new-team')}>
            <span className="team-mark plus">+</span>
            <span className="team-name">New team</span>
          </button>
        </div>
        <button className={`nav-item${view === 'plan' ? ' active' : ''}`} onClick={() => setView('plan')}><PlanIcon /> <span className="nav-text">Plan</span></button>
        <button className={`nav-item${selection?.kind === 'inbox' ? ' active' : ''}`} onClick={() => setSelection(selection?.kind === 'inbox' ? null : { kind: 'inbox', id: 'inbox' })}>
          <InboxIcon /> <span className="nav-text">Inbox</span>
          {unread > 0 && <span className="badge">{unread}</span>}
        </button>

        <div className="sidebar-bottom">
          <button className="nav-item theme-toggle" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            <span className="nav-text">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          {googleUser ? (
            <button className="account" onClick={() => setSheet('settings')} title={googleUser.email}>
              <Avatar person={me} size={28} />
              <span className="account-name nav-text">{shortName(googleUser.name)}</span>
            </button>
          ) : (
            <button className="account" onClick={() => setSheet('settings')}>
              <GoogleG />
              <span className="account-name nav-text">Sign in</span>
            </button>
          )}
        </div>
       </div>
      </aside>

      <div className={`main${detailOpen ? ' with-detail' : ''}`}>
        {view === 'team' && <TeamPage team={data} cloud={cloudMode} onUpdate={(fn) => update(fn)} />}
        <div className="planners" ref={mainRef} style={view === 'team' ? { display: 'none' } : undefined}>
          <section className="panel" style={{ flex: '1 1 0' }}>
            <div className="panel-head">
              <div className="panel-title">Master plan</div>
              <div className="panel-spacer" />
              {!isThisWeek && <button className="pill" onClick={() => setWeek(weekStart(today))}>Back to this week</button>}
              <button className="pill" onClick={() => setSheet('project')}>+ Project</button>
              <button className="pill" onClick={() => setSheet('deadline')}>
+<span className="dot-icon" />Deadline
              </button>
            </div>
            <BigPlan
              projects={data.projects}
              deadlines={data.deadlines}
              people={data.people}
              today={today}
              week={week}
              selectedId={selection?.id}
              selectedIds={multi}
              onToggleSelect={toggleSelect}
              editingId={editingId ?? undefined}
              onWeekChange={setWeek}
              onOpenProject={(p) => setSelection({ kind: 'project', id: p.id })}
              onOpenDeadline={(d) => setSelection({ kind: 'deadline', id: d.id })}
              onMoveProject={(id, patch) => updateProject(id, patch)}
              onOpenRetro={(monday) => setSelection({ kind: 'retro', id: monday })}
              onMoveDeadline={(id, date) => update((d) => ({ ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, date } : x)) }))}
              onCreateDeadline={(date) => {
                const id = uid();
                update((d) => ({ ...d, deadlines: [...d.deadlines, { id, name: 'New deadline', date }] }));
                setEditingId(id);
              }}
              onRenameDeadline={(id, name) => {
                setEditingId(null);
                if (!name) update((d) => ({ ...d, deadlines: d.deadlines.filter((x) => x.id !== id) }));
                else update((d) => ({ ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, name } : x)) }));
              }}
              onCreateProject={(start, lane) => {
                const id = uid();
                update((d) => ({ ...d, projects: [...d.projects, { id, name: 'New project', start, end: addDays(start, 6), lane }] }));
                setEditingId(id);
              }}
              onRename={(id, name) => {
                setEditingId(null);
                if (!name) update((d) => ({ ...d, projects: d.projects.filter((p) => p.id !== id) }));
                else update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === id ? { ...p, name } : p)) }));
              }}
            />
          </section>

          <div className={`resizer${resizing ? ' dragging' : ''}`} onPointerDown={onResizeDown} />

          <section className="panel" style={{ flex: 'none', height: weekH }}>
            <WeekPlan
              people={data.people}
              me={data.me}
              selected={person}
              onSelect={setSelectedPerson}
              week={week}
              today={today}
              tasks={data.tasks.filter((t) => t.personId === person && (!t.date || (t.date <= addDays(week, 6) && (t.end ?? t.date) >= week)))}
              selectedId={selection?.id}
              selectedIds={multi}
              onToggleSelect={toggleSelect}
              editingId={editingId ?? undefined}
              onWeekChange={setWeek}
              onAdd={(date) => {
                if (isPending(person)) return; // they need to sign in once before they can own tasks
                let id = '';
                update((d) => { const r = addTask(d, person, date); id = r.id; return r.data; });
                setEditingId(id);
              }}
              onRename={(id, title) => { setEditingId(null); update((d) => renameTask(d, id, title)); }}
              onUpdate={(id, patch) => updateTask(id, patch)}
              onDelete={(id) => { update((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) })); if (selection?.id === id) setSelection(null); }}
              onOpen={(t) => setSelection({ kind: 'task', id: t.id })}
              onReorder={(id, delta) => update((d) => reorderTask(d, id, delta))}
              calendar={{
                enabled: calendarOn,
                available: !!googleUser,
                events: calEvents[calKey] ?? [],
                note: !window.exponential ? 'Available in the desktop app' : !googleUser ? 'Sign in with Google to see events' : calNote,
              }}
              onToggleCalendar={() => setCalendarOn((c) => !c)}
            />
          </section>
        </div>

        {/* The slot animates its width so the planners squeeze smoothly; the panel inside keeps a fixed width. */}
        <div
          className={`detail-slot${vResizing ? ' no-anim' : ''}${slotAnimating || !detailOpen ? ' clip' : ''}`}
          style={{ width: detailOpen ? detailW + 14 : 0 }}
          onTransitionEnd={(e) => { if (e.propertyName === 'width') setSlotAnimating(false); }}
        >
        {detailOpen && <div className={`vresizer${vResizing ? ' dragging' : ''}`} onPointerDown={onVResizeDown} />}
        {detailOpen && selection && (
          <DetailPanel
            width={detailW}
            selection={selection}
            project={selProject}
            task={selTask}
            deadline={selDeadline}
            retro={selection.kind === 'retro' ? data.retros?.[selection.id] : undefined}
            notifications={data.notifications ?? []}
            people={data.people}
            me={data.me}
            onClose={() => setSelection(null)}
            onOpen={setSelection}
            onMarkRead={(ids) => update((d) => ({ ...d, notifications: (d.notifications ?? []).map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)) }), 'mark-read')}
            onUpdateProject={updateProject}
            onToggleAssignee={(pid, who) => {
              const cur = data.projects.find((x) => x.id === pid)?.assignees ?? [];
              updateProject(pid, { assignees: cur.includes(who) ? cur.filter((i) => i !== who) : [...cur, who] });
            }}
            onUpdateTask={updateTask}
            onUpdateDeadline={(id, patch, key) => update((d) => ({ ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), key)}
            onUpdateRetro={(wk, patch, key) => update((d) => {
              const cur: Retro = d.retros?.[wk] ?? { week: wk, answers: {} };
              return { ...d, retros: { ...d.retros, [wk]: { ...cur, ...patch, answers: { ...cur.answers, ...(patch.answers ?? {}) } } } };
            }, key)}
            retroFields={data.retroFields ?? DEFAULT_RETRO_FIELDS}
            onDelete={() => {
              const { kind, id } = selection;
              update((d) =>
                kind === 'project' ? { ...d, projects: d.projects.filter((p) => p.id !== id) }
                : kind === 'task' ? { ...d, tasks: d.tasks.filter((t) => t.id !== id) }
                : kind === 'deadline' ? { ...d, deadlines: d.deadlines.filter((x) => x.id !== id) }
                : d,
              );
              setSelection(null);
            }}
          />
        )}
        </div>
      </div>

      {sheet === 'project' && (
        <NewProjectSheet
          defaultStart={week}
          nextLane={data.projects.reduce((m, p) => Math.max(m, p.lane + 1), 0)}
          onClose={() => setSheet(null)}
          onCreate={(p) => { update((d) => ({ ...d, projects: [...d.projects, p] })); setSelection({ kind: 'project', id: p.id }); }}
        />
      )}
      {sheet === 'deadline' && (
        <NewDeadlineSheet
          defaultDate={today}
          onClose={() => setSheet(null)}
          onCreate={(dl) => { update((d) => ({ ...d, deadlines: [...d.deadlines, dl] })); setSelection({ kind: 'deadline', id: dl.id }); }}
        />
      )}
      {sheet === 'new-team' && (
        <NewTeamSheet onClose={() => setSheet(null)} onCreate={(name) => { createTeam(name); setSelection(null); setSelectedPerson(null); setView('team'); }} />
      )}
      {sheet === 'settings' && (
        <SettingsSheet
          user={googleUser}
          config={googleConfig}
          error={authError}
          onClose={() => { setSheet(null); setAuthError(null); }}
          onSaveConfig={async (c) => { await window.exponential?.google.setConfig(c); setGoogleConfig(c); }}
          onSignIn={signIn}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}

export function TeamMark({ team, size = 30 }: { team: { name: string; icon?: string }; size?: number }) {
  const style = { width: size, height: size, borderRadius: size / 3, fontSize: size / 2 };
  return team.icon
    ? <img className="team-mark img" src={team.icon} alt="" style={style} />
    : <span className="team-mark" style={style}>{team.name.trim()[0]?.toUpperCase()}</span>;
}

const ICON = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function PlanIcon() {
  return (
    <svg {...ICON} fill="currentColor" stroke="none">
      <rect x="3" y="5" width="12" height="3.6" rx="1.8" />
      <rect x="7.5" y="10.2" width="13.5" height="3.6" rx="1.8" />
      <rect x="4.5" y="15.4" width="9" height="3.6" rx="1.8" />
    </svg>
  );
}
function InboxIcon() {
  return (
    <svg {...ICON}>
      <path d="M4.5 13.5l1.8-6.2A1.8 1.8 0 0 1 8 6h8a1.8 1.8 0 0 1 1.7 1.3l1.8 6.2V17a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
      <path d="M4.5 13.5h4.2a3.3 3.3 0 0 0 6.6 0h4.2" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg {...ICON}>
      <path d="M19.5 14.8A7.8 7.8 0 0 1 9.2 4.5a8 8 0 1 0 10.3 10.3z" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7L18 18M6 18l1.3-1.3M16.7 7.3L18 6" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}


function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.6-5.9c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function SheetShell({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" style={wide ? { width: 460 } : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function NewProjectSheet({ defaultStart, nextLane, onClose, onCreate }: {
  defaultStart: ISODate; nextLane: number; onClose: () => void; onCreate: (p: Project) => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(addDays(defaultStart, 27));
  const valid = name.trim() && start && end && end >= start;
  const submit = () => { if (!valid) return; onCreate({ id: uid(), name: name.trim(), start, end, lane: nextLane }); onClose(); };
  return (
    <SheetShell title="New project" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field"><label>Name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What is it?" /></div>
        <div className="row">
          <div className="field"><label>Starts</label><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="field"><label>Ends</label><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>
        <div className="sheet-actions">
          <button type="submit" className="btn primary" disabled={!valid}>Add project</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </SheetShell>
  );
}

function NewTeamSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  const submit = () => { if (!name.trim()) return; onCreate(name.trim()); onClose(); };
  return (
    <SheetShell title="New team" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field"><label>Team name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Powertrain" /></div>
        <p className="muted">You'll be its first moderator. Add people from the Team page.</p>
        <div className="sheet-actions">
          <button type="submit" className="btn primary" disabled={!name.trim()}>Create team</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </SheetShell>
  );
}

function NewDeadlineSheet({ defaultDate, onClose, onCreate }: { defaultDate: ISODate; onClose: () => void; onCreate: (d: Deadline) => void }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(defaultDate);
  const valid = name.trim() && date;
  const submit = () => { if (!valid) return; onCreate({ id: uid(), name: name.trim(), date }); onClose(); };
  return (
    <SheetShell title="New deadline" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field"><label>Name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What has to be done?" /></div>
        <div className="field"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="sheet-actions">
          <button type="submit" className="btn primary" disabled={!valid}>Add deadline</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </SheetShell>
  );
}

function SignInGate({ config, error, onSaveConfig, onSignIn }: {
  config: GoogleConfig | null;
  error: string | null;
  onSaveConfig: (c: GoogleConfig) => Promise<void>;
  onSignIn: () => Promise<void> | void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const configured = !!config?.clientId;
  const go = async () => {
    setBusy(true);
    try {
      if (!configured) await onSaveConfig({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      await onSignIn();
    } finally { setBusy(false); }
  };
  return (
    <div className="gate">
      <div className="gate-card">
        <img className="gate-logo" src={logoUrl} alt="" />
        <h1>Welcome to Exponential</h1>
        {!configured && (
          <div className="gate-setup">
            <div className="field"><label>Client ID</label><input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" /></div>
            <div className="field"><label>Client secret</label><input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button className="gate-btn" disabled={busy || (!configured && !clientId.trim())} onClick={go}>
          <GoogleG /> {busy ? 'Waiting for your browser…' : 'Continue with Google'}
        </button>
      </div>
    </div>
  );
}

function SettingsSheet({ user, config, error, onClose, onSaveConfig, onSignIn, onSignOut }: {
  user: GoogleUser | null;
  config: GoogleConfig | null;
  error: string | null;
  onClose: () => void;
  onSaveConfig: (c: GoogleConfig) => Promise<void>;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const [clientId, setClientId] = useState(config?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState(config?.clientSecret ?? '');
  const [busy, setBusy] = useState(false);
  const desktop = !!window.exponential;
  const configured = !!clientId.trim();

  const connect = async () => {
    setBusy(true);
    try {
      await onSaveConfig({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      await onSignIn();
    } finally { setBusy(false); }
  };

  return (
    <SheetShell title="Google account" onClose={onClose} wide>
      {!desktop && <p className="muted">Google sign-in works in the desktop app, not in the browser preview.</p>}
      {user ? (
        <>
          <p className="muted">Signed in as <b>{user.name}</b> ({user.email}). Your name and photo come from Google, and the Calendar toggle in the week panel reads your calendar.</p>
          <div className="sheet-actions">
            <button className="btn" onClick={() => { onSignOut(); onClose(); }}>Sign out</button>
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Sign-in opens your browser and asks for your name, email, photo and read-only calendar access.
            Exponential needs an OAuth client from Google Cloud (type <b>Desktop app</b>) — paste it once below.
          </p>
          <div className="field"><label>Client ID</label><input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" /></div>
          <div className="field"><label>Client secret</label><input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></div>
          {error && <p className="error">{error}</p>}
          <div className="sheet-actions">
            <button className="btn primary" disabled={!desktop || !configured || busy} onClick={connect}>
              <GoogleG /> {busy ? 'Waiting for browser…' : 'Sign in with Google'}
            </button>
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </SheetShell>
  );
}
