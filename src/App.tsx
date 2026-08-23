import { useCallback, useEffect, useRef, useState } from 'react';
import { BigPlan, Star } from './BigPlan';
import { Avatar, WeekPlan } from './WeekPlan';
import { DetailPanel, type Selection } from './DetailPanel';
import { useData, uid, type GoogleConfig } from './store';
import type { CalendarEvent, Data, Deadline, GoogleUser, ISODate, Notification, Project, Retro, Task } from './types';
import { shortName } from './types';
import { addDays, todayISO, weekStart } from './dates';

/** Layout proportions, remembered per machine (not part of the shared plan data). */
const PREFS_KEY = 'exponential-layout';
const DEFAULT_PREFS = { weekH: 400, detailW: 415 };
const prefs: typeof DEFAULT_PREFS = (() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return DEFAULT_PREFS; }
})();
const savePrefs = (p: typeof DEFAULT_PREFS) => localStorage.setItem(PREFS_KEY, JSON.stringify(p));

export default function App() {
  const { data, update, undo, redo } = useData();
  const [today, setToday] = useState(todayISO());
  const [week, setWeek] = useState(() => weekStart(todayISO()));
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [weekH, setWeekH] = useState(() => prefs.weekH);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sheet, setSheet] = useState<'project' | 'deadline' | 'settings' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [detailW, setDetailW] = useState(() => prefs.detailW);

  useEffect(() => { savePrefs({ weekH, detailW }); }, [weekH, detailW]);
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
  const [googleConfig, setGoogleConfig] = useState<GoogleConfig | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [calEvents, setCalEvents] = useState<Record<string, CalendarEvent[]>>({});
  const [calNote, setCalNote] = useState<string | undefined>();

  useEffect(() => {
    const t = setInterval(() => setToday(todayISO()), 60_000);
    return () => clearInterval(t);
  }, []);

  // ⌘Z / ⌘⇧Z (Ctrl on Windows). Text fields keep their own undo while focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const notify = (d: Data, n: Omit<Notification, 'id' | 'at' | 'read'>): Data =>
    n.to === n.from ? d : { ...d, notifications: [...(d.notifications ?? []), { ...n, id: uid(), at: new Date().toISOString(), read: false }] };

  const nameOf = (d: Data, id: string) => shortName(d.people.find((p) => p.id === id)?.name ?? 'Someone');

  /** Task edits that someone else should hear about: new owner, review request. */
  const updateTask = (id: string, patch: Partial<Task>, coalesce?: string) =>
    update((d) => {
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
    }, coalesce);

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

  // Google: restore session on launch.
  useEffect(() => {
    const g = window.exponential?.google;
    if (!g) return;
    g.getConfig().then(setGoogleConfig);
    g.status().then((u) => u && setGoogleUser(u));
  }, []);

  // Once signed in, the "me" person takes the Google name and photo.
  useEffect(() => {
    if (!googleUser || !data) return;
    const me = data.people.find((p) => p.id === data.me);
    if (me && me.name === googleUser.name && me.photo === googleUser.picture && me.email === googleUser.email) return;
    update((d) => ({
      ...d,
      people: d.people.map((p) => (p.id === d.me ? { ...p, name: googleUser.name, photo: googleUser.picture, email: googleUser.email } : p)),
    }));
  }, [googleUser, data, update]);

  const person = selectedPerson ?? data?.me ?? '';
  const calendarOn = !!data?.showCalendar;

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
    await window.exponential?.google.signOut();
    setGoogleUser(null);
    setCalEvents({});
  }, []);

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
      <aside className="sidebar">
        <div className="brand">Exponential</div>
        <button className="nav-item active"><Icon d="M4 5h16v4H4zM4 11h10v4H4zM4 17h7v2H4z" /> Plan</button>
        <button className={`nav-item${selection?.kind === 'inbox' ? ' active' : ''}`} onClick={() => setSelection(selection?.kind === 'inbox' ? null : { kind: 'inbox', id: 'inbox' })}>
          <Icon d="M4 6h16v12H4zM4 6l8 7 8-7" /> Inbox
          {unread > 0 && <span className="badge">{unread}</span>}
        </button>
        <button className="nav-item" title="Coming later"><Icon d="M12 3a9 9 0 110 18 9 9 0 010-18zm0 4v5l3 2" /> Team</button>

        <div className="sidebar-bottom">
          {googleUser ? (
            <button className="account" onClick={() => setSheet('settings')} title={googleUser.email}>
              <Avatar person={me} size={28} />
              <span className="account-name">{shortName(googleUser.name)}</span>
            </button>
          ) : (
            <button className="account" onClick={() => setSheet('settings')}>
              <GoogleG />
              <span className="account-name">Sign in</span>
            </button>
          )}
        </div>
      </aside>

      <div className={`main${detailOpen ? ' with-detail' : ''}`}>
        <div className="planners" ref={mainRef}>
          <section className="panel" style={{ flex: '1 1 0' }}>
            <div className="panel-head">
              <div className="panel-title">Master plan</div>
              <div className="panel-spacer" />
              {!isThisWeek && <button className="pill" onClick={() => setWeek(weekStart(today))}>Back to this week</button>}
              <button className="pill" onClick={() => setSheet('project')}>+ Project</button>
              <button className="pill" onClick={() => setSheet('deadline')}>
                <span style={{ color: '#ff9f0a', display: 'inline-flex' }}><Star size={14} /></span> Deadline
              </button>
            </div>
            <BigPlan
              projects={data.projects}
              deadlines={data.deadlines}
              people={data.people}
              today={today}
              week={week}
              selectedId={selection?.id}
              editingId={editingId ?? undefined}
              onWeekChange={setWeek}
              onOpenProject={(p) => setSelection({ kind: 'project', id: p.id })}
              onOpenDeadline={(d) => setSelection({ kind: 'deadline', id: d.id })}
              onMoveProject={(id, patch) => updateProject(id, patch)}
              onOpenRetro={(monday) => setSelection({ kind: 'retro', id: monday })}
              onMoveDeadline={(id, date) => update((d) => ({ ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, date } : x)) }))}
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
              tasks={data.tasks.filter((t) => t.personId === person && t.date <= addDays(week, 6) && (t.end ?? t.date) >= week)}
              selectedId={selection?.id}
              editingId={editingId ?? undefined}
              onWeekChange={setWeek}
              onAdd={(date) => {
                const id = uid();
                update((d) => ({ ...d, tasks: [...d.tasks, { id, personId: person, title: 'New task', date, status: 'todo', createdBy: d.me } as Task] }));
                setEditingId(id);
              }}
              onRename={(id, title) => {
                setEditingId(null);
                if (!title) update((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) }));
                else update((d) => {
                  const t0 = d.tasks.find((t) => t.id === id)!;
                  const next: Data = { ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, title } : t)) };
                  return t0.personId !== d.me
                    ? notify(next, { to: t0.personId, from: d.me, kind: 'task-added', text: `${nameOf(d, d.me)} added “${title}” to your week`, ref: { kind: 'task', id } })
                    : next;
                });
              }}
              onUpdate={(id, patch) => updateTask(id, patch)}
              onDelete={(id) => { update((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) })); if (selection?.id === id) setSelection(null); }}
              onOpen={(t) => setSelection({ kind: 'task', id: t.id })}
              onReorder={(id, delta) => update((d) => {
                const t = d.tasks.find((x) => x.id === id)!;
                const group = d.tasks.filter((x) => x.personId === t.personId && x.date === t.date)
                  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
                const from = group.findIndex((x) => x.id === id);
                const to = Math.min(group.length - 1, Math.max(0, from + delta));
                if (from === to) return d;
                group.splice(to, 0, group.splice(from, 1)[0]);
                const order = new Map(group.map((x, i) => [x.id, i]));
                return { ...d, tasks: d.tasks.map((x) => (order.has(x.id) ? { ...x, order: order.get(x.id) } : x)) };
              })}
              calendar={{
                enabled: calendarOn,
                available: !!googleUser,
                events: calEvents[calKey] ?? [],
                note: !window.exponential ? 'Available in the desktop app' : !googleUser ? 'Sign in with Google to see events' : calNote,
              }}
              onToggleCalendar={() => update((d) => ({ ...d, showCalendar: !d.showCalendar }))}
            />
          </section>
        </div>

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
              const cur: Retro = d.retros?.[wk] ?? { week: wk, wentWell: '', improve: '', learnings: '', nextFocus: '' };
              return { ...d, retros: { ...d.retros, [wk]: { ...cur, ...patch } } };
            }, key)}
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

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
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
