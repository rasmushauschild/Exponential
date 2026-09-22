import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent, Person } from './types';
import { shortName } from './types';
import { Avatar } from './WeekPlan';
import { uid } from './store';
import { addDays, todayISO } from './dates';
import { activeRecording, startRecording, type RecordingSession } from './recorder';
import {
  createMeeting, deleteMeeting, fetchCalendarShares, fetchMeetings, meetingAudioUrl,
  subscribeMeetings, updateMeeting, uploadMeetingAudio, type Meeting, type SharedCalendar,
} from './meetings';

/**
 * Meetings: the next two weeks of everyone's (shared) calendars, a Record button for
 * spontaneous meetings, drag-in audio files, and every past meeting with its on-device
 * transcript. Recording keeps running if you switch views — the session is a module
 * singleton and this page re-attaches to it.
 */

interface Props {
  teamId: string;
  me: string;
  people: Person[];
  canModerate: boolean;
  cloud: boolean;
  calendarReady: boolean; // signed in to Google with calendar scope
  shareCal: boolean;
  onShareCal: (v: boolean) => void;
  onError: (m: string) => void;
}

const fmtDur = (s?: number) => {
  if (!s && s !== 0) return '';
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m` : `${s}s`;
};
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d: Date) => {
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() + 86_400_000).toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};
const fmtStamp = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + fmtTime(iso);
const defaultTitle = (iso: string) => `Meeting — ${fmtStamp(iso)}`;

type Progress = { label: string; pct?: number };

export function MeetingsPage(p: Props) {
  const { teamId, me, people, cloud } = p;
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [shares, setShares] = useState<SharedCalendar[]>([]);
  const [myEvents, setMyEvents] = useState<CalendarEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [hiddenCals, setHiddenCals] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('exponential-meet-hidden') ?? '[]')); } catch { return new Set(); }
  });
  const [rec, setRec] = useState<RecordingSession | null>(() => activeRecording());
  const [recTick, setRecTick] = useState(0);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const levelRef = useRef<HTMLDivElement>(null);

  const refetch = () => {
    fetchMeetings(teamId, cloud).then(setMeetings).catch((e) => p.onError(String((e as Error).message ?? e)));
    fetchCalendarShares(teamId, cloud).then(setShares).catch(() => {});
  };
  useEffect(() => { setMeetings([]); setShares([]); setSelected(null); refetch(); return subscribeMeetings(teamId, cloud, refetch); }, [teamId, cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  // my own next two weeks straight from Google (teammates' come from calendar_shares)
  useEffect(() => {
    if (!p.calendarReady) return;
    window.exponential?.google.events('primary', todayISO(), addDays(todayISO(), 14)).then(setMyEvents).catch(() => {});
  }, [p.calendarReady, teamId]);

  // recording timer + level meter (cheap: one interval, level written straight to the DOM)
  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setRecTick((v) => v + 1), 1000);
    let raf = 0;
    const meter = () => { if (levelRef.current) levelRef.current.style.transform = `scaleX(${rec.level()})`; raf = requestAnimationFrame(meter); };
    raf = requestAnimationFrame(meter);
    return () => { window.clearInterval(t); cancelAnimationFrame(raf); };
  }, [rec]);

  const setProg = (id: string, v: Progress | null) => setProgress((m) => {
    const n = { ...m };
    if (v) n[id] = v; else delete n[id];
    return n;
  });

  /** Shared tail for both record-stop and file import: upload, transcribe on device, name it. */
  const processAudio = async (id: string, blob: Blob, startedAt: string, durationSecs?: number) => {
    try {
      setProg(id, { label: 'Saving' });
      const audioPath = await uploadMeetingAudio(id, blob, cloud);
      if (audioPath) await updateMeeting(teamId, id, { audioPath }, cloud);
      const { transcribe, autoTitle } = await import('./transcribe');
      await updateMeeting(teamId, id, { status: 'transcribing' }, cloud);
      refetch();
      const out = await transcribe(blob, (pr) => setProg(id,
        pr.phase === 'model' ? { label: 'Downloading speech model (one-time)', pct: pr.pct }
        : pr.phase === 'decode' ? { label: 'Reading audio' }
        : { label: 'Transcribing' }));
      const title = autoTitle(out.text, defaultTitle(startedAt));
      await updateMeeting(teamId, id, {
        transcript: out.segments, summary: out.text.slice(0, 2000), title,
        durationSecs: durationSecs ?? out.durationSecs, status: 'ready',
      }, cloud);
    } catch (e) {
      p.onError(`Transcription failed: ${String((e as Error).message ?? e)}`);
      await updateMeeting(teamId, id, { status: 'error' }, cloud).catch(() => {});
    }
    setProg(id, null);
    refetch();
  };

  const record = async () => {
    try {
      const id = uid();
      const session = await startRecording(id);
      setRec(session);
    } catch (e) { p.onError(String((e as Error).message ?? e)); }
  };

  const stop = async () => {
    if (!rec) return;
    const session = rec;
    setRec(null);
    try {
      const { blob, durationSecs } = await session.stop();
      const startedAt = session.startedAt.toISOString();
      const m: Omit<Meeting, 'owner'> = { id: session.meetingId, title: defaultTitle(startedAt), startedAt, durationSecs, status: 'recorded', isOpen: true, access: [] };
      await createMeeting(teamId, me, m, cloud);
      refetch();
      setSelected(session.meetingId);
      await processAudio(session.meetingId, blob, startedAt, durationSecs);
    } catch (e) { p.onError(String((e as Error).message ?? e)); }
  };

  const importFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('audio/') && !/\.(mp3|m4a|wav|webm|ogg|aac|flac)$/i.test(f.name)) continue;
      const id = uid();
      const startedAt = new Date(f.lastModified || Date.now()).toISOString();
      const m: Omit<Meeting, 'owner'> = { id, title: f.name.replace(/\.[a-z0-9]+$/i, ''), startedAt, status: 'recorded', isOpen: true, access: [] };
      await createMeeting(teamId, me, m, cloud).catch((e) => p.onError(String((e as Error).message ?? e)));
      refetch();
      setSelected(id);
      await processAudio(id, f, startedAt);
    }
  };

  /* agenda: 14 days of my events + visible teammates' shared events + recorded meetings */
  type AgendaItem = { kind: 'event' | 'meeting'; id: string; title: string; when: string; sort: string; who?: string; meeting?: Meeting };
  const days: { date: Date; items: AgendaItem[] }[] = [];
  {
    const byDay = new Map<string, AgendaItem[]>();
    const push = (dayIso: string, item: AgendaItem) => {
      if (!byDay.has(dayIso)) byDay.set(dayIso, []);
      byDay.get(dayIso)!.push(item);
    };
    const evItem = (ev: CalendarEvent, who: string, idPrefix = ''): [string, AgendaItem] => [ev.date, {
      kind: 'event', id: idPrefix + ev.id, title: ev.title, who,
      when: ev.allDay || !ev.start ? 'All day' : `${ev.start}${ev.end ? `–${ev.end}` : ''}`,
      sort: ev.allDay || !ev.start ? '00:00' : ev.start,
    }];
    if (!hiddenCals.has(me)) for (const ev of myEvents) { const [d, it] = evItem(ev, me); push(d, it); }
    for (const sh of shares) {
      if (sh.userId === me || hiddenCals.has(sh.userId)) continue;
      for (const ev of sh.events) { const [d, it] = evItem(ev, sh.userId, `${sh.userId}:`); push(d, it); }
    }
    for (const m of meetings) push(m.startedAt.slice(0, 10), { kind: 'meeting', id: m.id, title: m.title, when: fmtTime(m.startedAt), sort: fmtTime(m.startedAt), meeting: m });
    for (let i = 0; i < 14; i++) {
      const iso = addDays(todayISO(), i);
      const items = (byDay.get(iso) ?? []).sort((a, b) => a.sort.localeCompare(b.sort));
      if (items.length) days.push({ date: new Date(`${iso}T12:00:00`), items });
    }
  }

  const sel = meetings.find((m) => m.id === selected) ?? null;
  const sharers = new Set(shares.map((s) => s.userId));
  const calPeople = people.filter((x) => (x.id === me ? p.calendarReady : sharers.has(x.id)));

  return (
    <div className={`meet${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); }}>
      <div className="meet-list">
        <div className="meet-head">
          {rec ? (
            <div className="meet-recbar">
              <span className="meet-reddot" />
              <span className="meet-rectime">{fmtClock(Math.round((Date.now() - +rec.startedAt) / 1000))}</span>
              <span className="meet-level"><span ref={levelRef} /></span>
              {rec.systemAudio && <span className="meet-sys" title="Also capturing system audio">mic + system</span>}
              <button className="pill toggle active" onClick={stop}>Stop</button>
            </div>
          ) : (
            <button className="pill meet-rec" onClick={record} title="Record this meeting (microphone, plus system audio when available)">
              <span className="meet-reddot idle" /> Record
            </button>
          )}
          <button className="pill" onClick={() => fileRef.current?.click()} title="Transcribe an existing recording">Import audio</button>
          <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac,.flac" multiple hidden onChange={(e) => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />
          <span className="panel-spacer" />
          {calPeople.length > 0 && (
            <span className="meet-cals" title="Whose calendars are shown">
              {calPeople.map((x) => (
                <button key={x.id} className={`meet-cal-avatar${hiddenCals.has(x.id) ? ' off' : ''}`}
                  onClick={() => setHiddenCals((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); localStorage.setItem('exponential-meet-hidden', JSON.stringify([...n])); return n; })}>
                  <Avatar person={x} size={22} />
                </button>
              ))}
            </span>
          )}
          {cloud && p.calendarReady && (
            <button className={`pill toggle${p.shareCal ? ' active' : ''}`} onClick={() => p.onShareCal(!p.shareCal)}
              title="Publish your next two weeks (titles and times) to this team">
              Share my calendar
            </button>
          )}
        </div>

        <div className="meet-scroll">
          {days.length > 0 && (
            <div className="meet-section">
              <div className="meet-section-title">Next two weeks</div>
              {days.map((d) => (
                <div key={+d.date} className="meet-day">
                  <div className="meet-day-label">{fmtDay(d.date)}</div>
                  {d.items.map((it) => it.kind === 'event' ? (
                    <div key={it.id} className="meet-event">
                      <span className="meet-when">{it.when}</span>
                      <span className="meet-title">{it.title}</span>
                      {it.who && people.find((x) => x.id === it.who) && <Avatar person={people.find((x) => x.id === it.who)!} size={18} />}
                    </div>
                  ) : (
                    <button key={it.id} className={`meet-event meeting${selected === it.id ? ' on' : ''}`} onClick={() => setSelected(it.id)}>
                      <span className="meet-when">{it.when}</span>
                      <MicGlyph />
                      <span className="meet-title">{it.title}</span>
                      <StatusChip m={it.meeting!} progress={progress[it.id]} />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="meet-section">
            <div className="meet-section-title">Meetings</div>
            {meetings.length === 0 && <div className="meet-empty">Nothing recorded yet. Hit Record in a meeting, or drop an audio file anywhere on this page.</div>}
            {meetings.map((m) => (
              <button key={m.id} className={`meet-row${selected === m.id ? ' on' : ''}`} onClick={() => setSelected(m.id)}>
                <MicGlyph />
                <span className="meet-row-main">
                  <span className="meet-title">{m.title}</span>
                  <span className="meet-sub">{fmtStamp(m.startedAt)}{m.durationSecs ? ` · ${fmtDur(m.durationSecs)}` : ''}</span>
                </span>
                <span className="panel-spacer" />
                {!m.isOpen && <span title="Restricted"><LockTiny /></span>}
                <StatusChip m={m} progress={progress[m.id]} />
                {people.find((x) => x.id === m.owner) && <Avatar person={people.find((x) => x.id === m.owner)!} size={20} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {sel && (
        <MeetingDetail key={sel.id} meeting={sel} me={me} people={people} cloud={cloud}
          canEdit={sel.owner === me || p.canModerate}
          progress={progress[sel.id]}
          onPatch={(patch) => updateMeeting(teamId, sel.id, patch, cloud).then(refetch).catch((e) => p.onError(String((e as Error).message ?? e)))}
          onRetranscribe={async () => {
            const url = await meetingAudioUrl(sel, cloud);
            if (!url) { p.onError('No audio stored for this meeting'); return; }
            const blob = await fetch(url).then((r) => r.blob());
            await processAudio(sel.id, blob, sel.startedAt, sel.durationSecs);
          }}
          onDelete={() => { if (confirm(`Delete “${sel.title}” and its recording?`)) { deleteMeeting(teamId, sel, cloud).then(() => { setSelected(null); refetch(); }).catch((e) => p.onError(String((e as Error).message ?? e))); } }}
          onClose={() => setSelected(null)}
        />
      )}
      {drag && <div className="meet-drop-hint">Drop audio to transcribe</div>}
    </div>
  );
}

function StatusChip({ m, progress }: { m: Meeting; progress?: Progress }) {
  if (progress) return <span className="meet-chip busy">{progress.label}{progress.pct !== undefined ? ` ${progress.pct}%` : '…'}</span>;
  if (m.status === 'transcribing') return <span className="meet-chip busy">Transcribing…</span>;
  if (m.status === 'error') return <span className="meet-chip error">Failed</span>;
  if (m.status === 'recorded') return <span className="meet-chip">Not transcribed</span>;
  return null;
}

function MeetingDetail({ meeting: m, me, people, cloud, canEdit, progress, onPatch, onRetranscribe, onDelete, onClose }: {
  meeting: Meeting; me: string; people: Person[]; cloud: boolean; canEdit: boolean; progress?: Progress;
  onPatch: (patch: Partial<Meeting>) => void; onRetranscribe: () => void; onDelete: () => void; onClose: () => void;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let gone = false;
    meetingAudioUrl(m, cloud).then((u) => { if (!gone) setAudioUrl(u); });
    return () => { gone = true; };
  }, [m.id, m.audioPath, cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  const owner = people.find((x) => x.id === m.owner);
  return (
    <aside className="meet-detail">
      <div className="meet-detail-head">
        {canEdit ? (
          <input key={m.title} className="meet-title-input" defaultValue={m.title} /* remounts when the auto-title lands */
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== m.title) onPatch({ title: v }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        ) : <span className="meet-detail-title">{m.title}</span>}
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="meet-detail-meta">
        {owner && <Avatar person={owner} size={18} />}
        <span>{fmtStamp(m.startedAt)}</span>
        {m.durationSecs ? <span>· {fmtDur(m.durationSecs)}</span> : null}
        <StatusChip m={m} progress={progress} />
      </div>
      {audioUrl && <audio ref={audioRef} className="meet-audio" controls src={audioUrl} />}

      {canEdit && (
        <div className="meet-access">
          <button className={`pill toggle${m.isOpen ? ' active' : ''}`} onClick={() => onPatch({ isOpen: !m.isOpen })}
            title="Open: everyone on the team can see this meeting">Whole team</button>
          {!m.isOpen && people.filter((x) => x.id !== me).map((x) => (
            <button key={x.id} className={`pill${m.access.includes(x.id) ? ' toggle active' : ''}`}
              onClick={() => onPatch({ access: m.access.includes(x.id) ? m.access.filter((a) => a !== x.id) : [...m.access, x.id] })}>
              {shortName(x.name)}
            </button>
          ))}
        </div>
      )}

      <div className="meet-transcript">
        {(m.transcript ?? []).map((s, i) => (
          <p key={i} className="meet-seg" onClick={() => { const a = audioRef.current; if (a && Number.isFinite(s.t0)) { a.currentTime = s.t0; a.play().catch(() => {}); } }}>
            <span className="meet-ts">{fmtClock(s.t0)}</span>
            {s.text}
          </p>
        ))}
        {!m.transcript?.length && !progress && (
          // status may say 'transcribing' from a run that died with the app — no live
          // progress here means nobody is working on it, so offer the button again
          <div className="meet-empty">
            No transcript yet.
            {(m.audioPath || !cloud) && <button className="pill" onClick={onRetranscribe}>Transcribe</button>}
          </div>
        )}
      </div>

      {canEdit && (
        <div className="meet-detail-foot">
          {m.status === 'ready' && (m.audioPath || !cloud) && <button className="pill" onClick={onRetranscribe}>Re-transcribe</button>}
          <span className="panel-spacer" />
          <button className="pill danger" onClick={onDelete}>Delete</button>
        </div>
      )}
    </aside>
  );
}

function MicGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" /></svg>;
}
function LockTiny() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}
