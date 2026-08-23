import { useCallback, useEffect, useRef, useState } from 'react';
import { BigPlan, Star } from './BigPlan';
import { Avatar, WeekPlan } from './WeekPlan';
import { DetailPanel, type Selection } from './DetailPanel';
import { useData, uid, type GoogleConfig } from './store';
import type { CalendarEvent, Deadline, GoogleUser, ISODate, Project, Task } from './types';
import { shortName } from './types';
import { addDays, todayISO, weekStart } from './dates';

export default function App() {
  const { data, update } = useData();
  const [today, setToday] = useState(todayISO());
  const [week, setWeek] = useState(() => weekStart(todayISO()));
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [split, setSplit] = useState(0.5);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sheet, setSheet] = useState<'project' | 'deadline' | 'settings' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
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
    const move = (ev: PointerEvent) => setSplit(Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height)));
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
  const detailOpen = !!(selProject || selTask || selDeadline);

  const calKey = `${person === data.me ? 'primary' : data.people.find((x) => x.id === person)?.email}|${week}`;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Exponential</div>
        <button className="nav-item active"><Icon d="M4 5h16v4H4zM4 11h10v4H4zM4 17h7v2H4z" /> Plan</button>
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
          <section className="panel" style={{ flex: `${split} 1 0` }}>
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
              today={today}
              week={week}
              selectedId={selection?.id}
              editingId={editingId ?? undefined}
              onWeekChange={setWeek}
              onOpenProject={(p) => setSelection({ kind: 'project', id: p.id })}
              onOpenDeadline={(d) => setSelection({ kind: 'deadline', id: d.id })}
              onMoveProject={(id, patch) => update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))}
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

          <section className="panel" style={{ flex: `${1 - split} 1 0` }}>
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
                update((d) => ({ ...d, tasks: [...d.tasks, { id, personId: person, title: 'New task', date, status: 'todo' } as Task] }));
                setEditingId(id);
              }}
              onRename={(id, title) => {
                setEditingId(null);
                if (!title) update((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) }));
                else update((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, title } : t)) }));
              }}
              onUpdate={(id, patch) => update((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))}
              onDelete={(id) => { update((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) })); if (selection?.id === id) setSelection(null); }}
              onOpen={(t) => setSelection({ kind: 'task', id: t.id })}
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

        {detailOpen && selection && (
          <DetailPanel
            selection={selection}
            project={selProject}
            task={selTask}
            deadline={selDeadline}
            people={data.people}
            onClose={() => setSelection(null)}
            onUpdateProject={(id, patch) => update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))}
            onUpdateTask={(id, patch) => update((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))}
            onUpdateDeadline={(id, patch) => update((d) => ({ ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))}
            onDelete={() => {
              const { kind, id } = selection;
              update((d) =>
                kind === 'project' ? { ...d, projects: d.projects.filter((p) => p.id !== id) }
                : kind === 'task' ? { ...d, tasks: d.tasks.filter((t) => t.id !== id) }
                : { ...d, deadlines: d.deadlines.filter((x) => x.id !== id) },
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
