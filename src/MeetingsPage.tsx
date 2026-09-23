import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Person } from './types';
import { shortName } from './types';
import { Avatar } from './WeekPlan';
import { uid } from './store';
import { activeRecording, startRecording, type RecordingSession } from './recorder';
import {
  cachedMeetings, createMeeting, deleteMeeting, fetchMeetings, fetchVoicePrints, meetingAudioUrl,
  saveVoicePrint, subscribeMeetings, updateMeeting, uploadMeetingAudio, type Meeting, type Segment,
} from './meetings';
import { SendToAgent } from './DetailPanel';

/**
 * Meetings: one chronological list of recordings — yours and the ones shared with you.
 * Record (mic + system loopback where the OS allows; pausable, Voice-Memos-style wave),
 * or drop in an audio file. Transcription runs on device, names the meeting from what
 * was discussed, and labels speakers — teammates who did the one-time "Learn my voice"
 * are recognised automatically; the rest are Speaker 1/2… and can be renamed in place.
 */

interface Props {
  teamId: string;
  me: string;
  people: Person[];
  canModerate: boolean;
  cloud: boolean;
  transcribeKey?: string; // set in Team settings → AssemblyAI does the transcription
  onClose: () => void;
  onError: (m: string) => void;
}

const fmtDur = (s?: number) => {
  if (!s && s !== 0) return '';
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m` : `${s}s`;
};
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtStamp = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const defaultTitle = (iso: string) => `Meeting — ${fmtStamp(iso)}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Progress = { label: string; pct?: number };

export function MeetingsPage(p: Props) {
  const { teamId, me, people, cloud } = p;
  const [meetings, setMeetings] = useState<Meeting[]>(() => cachedMeetings(teamId) ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [rec, setRec] = useState<RecordingSession | null>(() => activeRecording());
  const [drag, setDrag] = useState(false);
  const [voiceRec, setVoiceRec] = useState<'idle' | 'recording' | 'saving'>('idle');
  const [voiceSecs, setVoiceSecs] = useState(20);
  const voiceCancel = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refetch = () => fetchMeetings(teamId, cloud).then(setMeetings).catch((e) => p.onError(String((e as Error).message ?? e)));
  useEffect(() => { setMeetings(cachedMeetings(teamId) ?? []); setSelected(null); refetch(); return subscribeMeetings(teamId, cloud, () => refetch()); }, [teamId, cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  const setProg = (id: string, v: Progress | null) => setProgress((m) => {
    const n = { ...m };
    if (v) n[id] = v; else delete n[id];
    return n;
  });

  /** Upload, transcribe on device (with speaker labels), name it. */
  const processAudio = async (id: string, blob: Blob, startedAt: string, durationSecs?: number) => {
    try {
      setProg(id, { label: 'Saving' });
      const audioPath = await uploadMeetingAudio(id, blob, cloud);
      if (audioPath) await updateMeeting(teamId, id, { audioPath }, cloud);
      const { transcribeWithSpeakers, autoTitle } = await import('./transcribe');
      await updateMeeting(teamId, id, { status: 'transcribing' }, cloud);
      refetch();
      const enrolled = (await fetchVoicePrints(cloud)).map((v) => ({ id: v.userId, embedding: v.embedding }));
      let out: { segments: Segment[]; text: string; durationSecs: number } | null = null;
      if (cloud && audioPath) {
        // shipped default: the team's backend proxy holds the key — no setup needed
        try {
          const { transcribeViaBackend } = await import('./transcribeCloud');
          out = await transcribeViaBackend(id, blob, enrolled, (label) => setProg(id, { label }));
        } catch (e) { console.warn('[transcribe] backend path unavailable:', e); }
      }
      if (!out && p.transcribeKey) {
        try {
          const { transcribeCloud } = await import('./transcribeCloud');
          out = await transcribeCloud(blob, p.transcribeKey, enrolled, (label) => setProg(id, { label }));
        } catch (e) {
          p.onError(`Cloud transcription failed (${String((e as Error).message ?? e)}) — falling back to on-device.`);
        }
      }
      if (!out) {
        out = await transcribeWithSpeakers(blob, enrolled, (pr) => setProg(id,
          pr.phase === 'model' ? { label: 'Downloading speech model (one-time)', pct: pr.pct }
          : pr.phase === 'decode' ? { label: 'Reading audio' }
          : pr.phase === 'speakers' ? { label: 'Finding speakers' }
          : { label: 'Transcribing' }));
      }
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
    try { setRec(await startRecording(uid())); }
    catch (e) { p.onError(String((e as Error).message ?? e)); }
  };

  const stop = async () => {
    if (!rec) return;
    const session = rec;
    setRec(null);
    try {
      const { blob, durationSecs } = await session.stop();
      const startedAt = session.startedAt.toISOString();
      await createMeeting(teamId, me, { id: session.meetingId, title: defaultTitle(startedAt), startedAt, durationSecs, status: 'recorded', isOpen: true, access: [] }, cloud);
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
      await createMeeting(teamId, me, { id, title: f.name.replace(/\.[a-z0-9]+$/i, ''), startedAt, status: 'recorded', isOpen: true, access: [] }, cloud).catch((e) => p.onError(String((e as Error).message ?? e)));
      refetch();
      setSelected(id);
      await processAudio(id, f, startedAt);
    }
  };

  /** ~20s reading the on-screen script → a voice print; transcripts then attribute this
   *  person BY NAME (closed-set identification — the reliable path for a shared-mic room). */
  const learnVoice = async () => {
    try {
      voiceCancel.current = false;
      setVoiceSecs(20);
      setVoiceRec('recording');
      const allowed = await window.exponential?.micEnsure?.() ?? true;
      if (!allowed) { setVoiceRec('idle'); window.exponential?.micOpenSettings?.(); p.onError('Microphone access is off for Exponential — enable it in System Settings.'); return; }
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recd = new MediaRecorder(mic, { mimeType: 'audio/webm;codecs=opus' });
      const chunks: Blob[] = [];
      recd.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recd.start();
      for (let s = 20; s > 0; s--) {
        setVoiceSecs(s);
        await new Promise((r) => setTimeout(r, 1000));
        if (voiceCancel.current) break;
      }
      await new Promise<void>((r) => { recd.onstop = () => r(); recd.stop(); });
      mic.getTracks().forEach((t) => t.stop());
      if (voiceCancel.current) { setVoiceRec('idle'); return; }
      setVoiceRec('saving');
      const { voiceEmbedding } = await import('./transcribe');
      const emb = await voiceEmbedding(new Blob(chunks, { type: 'audio/webm' }));
      await saveVoicePrint(me, emb, cloud);
      setVoiceRec('idle');
    } catch (e) { setVoiceRec('idle'); p.onError(String((e as Error).message ?? e)); }
  };

  const sel = meetings.find((m) => m.id === selected) ?? null;

  return (
    <div className={`meet${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); }}>
      {sel ? (
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
          onBack={() => setSelected(null)}
          onCloseAll={p.onClose}
        />
      ) : (
      <>
      <div className="side-head">
        <span className="side-title">Meetings</span>
        <span className="panel-spacer" />
        <button className="icon-btn" title="Close" onClick={p.onClose}><MXGlyph /></button>
      </div>
      <div className="meet-tools">
        {!rec && (
          <button className="pill toggle active meet-rec" onClick={record} title="Record this meeting (microphone, plus system audio when available)">
            <span className="meet-reddot idle" /> Record
          </button>
        )}
        <button className="pill" onClick={() => fileRef.current?.click()} title="Transcribe an existing recording">Import audio</button>
        <span className="panel-spacer" />
        <button className="pill" onClick={learnVoice} disabled={voiceRec !== 'idle'}
          title="Read a short script once — transcripts will then label your parts with your name">
          Learn my voice
        </button>
        <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac,.flac" multiple hidden onChange={(e) => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />
      </div>
      {rec && <RecordBar rec={rec} onStop={stop} />}
      <div className="meet-scroll">
        {meetings.length === 0 && !rec && (
          <div className="meet-empty">Nothing recorded yet. Hit Record in a meeting, or drop an audio file anywhere on this page.</div>
        )}
        {meetings.map((m) => (
          <button key={m.id} className="meet-row" onClick={() => setSelected(m.id)}>
            <MicGlyph />
            <span className="meet-row-main">
              <span className="meet-title">{m.title}</span>
              <span className="meet-sub">{fmtStamp(m.startedAt)}{m.durationSecs ? ` · ${fmtDur(m.durationSecs)}` : ''}</span>
            </span>
            <span className="panel-spacer" />
            {!m.isOpen && <span title="Restricted"><LockTiny /></span>}
            <StatusChip m={m} progress={progress[m.id]} />
            <Participants m={m} people={people} />
          </button>
        ))}
      </div>
      </>
      )}
      {voiceRec !== 'idle' && createPortal(
        <div className="sheet-veil">
          <div className="sheet voice-sheet">
            <div className="sheet-title">Learn my voice</div>
            <p className="voice-hint">Read this out loud, at your normal pace — it takes about twenty seconds:</p>
            <p className="voice-script">
              “Hi team, it's just me teaching Exponential my voice. Every week we plan projects,
              set priorities and review progress together around this table. Sometimes I speak
              quickly when I'm excited, and sometimes slowly when I'm thinking something through.
              One, two, three, four, five, six, seven — red, green, blue, yellow. That should be
              plenty for the app to recognise me in our meetings from now on.”
            </p>
            <div className="voice-foot">
              {voiceRec === 'recording' ? <><span className="meet-reddot" /> Listening… {voiceSecs}s</> : 'Saving your voice…'}
              <span className="panel-spacer" />
              {voiceRec === 'recording' && <button className="pill" onClick={() => { voiceCancel.current = true; }}>Cancel</button>}
            </div>
          </div>
        </div>, document.body)}
      {drag && <div className="meet-drop-hint">Drop audio to transcribe</div>}
    </div>
  );
}

/** Who spoke, at a glance: identified members as an avatar stack, plus +N for other voices. */
function Participants({ m, people }: { m: Meeting; people: Person[] }) {
  const whos = [...new Set((m.transcript ?? []).map((s) => s.who).filter(Boolean))] as string[];
  const members = whos.map((w) => people.find((x) => x.id === w)).filter(Boolean) as Person[];
  const extras = whos.length - members.length;
  const owner = people.find((x) => x.id === m.owner);
  if (!members.length && !extras) return owner ? <Avatar person={owner} size={20} /> : null;
  return (
    <span className="meet-people" title={[...members.map((x) => shortName(x.name)), ...(extras ? [`${extras} other${extras > 1 ? 's' : ''}`] : [])].join(', ')}>
      {members.slice(0, 4).map((x) => <Avatar key={x.id} person={x} size={20} />)}
      {extras > 0 && <span className="meet-extra">+{extras}</span>}
    </span>
  );
}

/** Voice-Memos-style strip: scrolling waveform, elapsed (recording) time, pause/resume, stop. */
function RecordBar({ rec, onStop }: { rec: RecordingSession; onStop: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samples = useRef<number[]>([]);
  const [, tick] = useState(0);
  const [paused, setPaused] = useState(rec.state() === 'paused');

  useEffect(() => {
    const t = window.setInterval(() => tick((v) => v + 1), 500);
    const s = window.setInterval(() => { if (rec.state() === 'recording') samples.current.push(rec.level()); }, 90);
    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      if (cv) {
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const cx = cv.getContext('2d')!;
        cx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cx.clearRect(0, 0, w, h);
        const bw = 2, gap = 1, n = Math.floor(w / (bw + gap));
        const data = samples.current.slice(-n);
        cx.fillStyle = '#e5484d';
        data.forEach((v, i) => {
          const x = w - (data.length - i) * (bw + gap);
          const bh = Math.max(2, v * (h - 6));
          cx.fillRect(x, (h - bh) / 2, bw, bh);
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { window.clearInterval(t); window.clearInterval(s); cancelAnimationFrame(raf); };
  }, [rec]);

  return (
    <div className="meet-wavebar">
      <span className={`meet-reddot${paused ? ' idle' : ''}`} />
      <span className="meet-rectime">{fmtClock(Math.round(rec.activeSecs()))}</span>
      <canvas ref={canvasRef} className="meet-wave" title={rec.systemAudio ? 'Recording microphone + system audio' : 'Recording microphone'} />
      <button className="pill" onClick={() => { if (paused) { rec.resume(); setPaused(false); } else { rec.pause(); setPaused(true); } }}>
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button className="pill stop" onClick={onStop}>Stop</button>
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

/** Who can open the meeting: one popup — Everyone (default) or hand-picked people. */
function AccessPicker({ m, me, people, onPatch }: { m: Meeting; me: string; people: Person[]; onPatch: (p: Partial<Meeting>) => void }) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.meet-access-menu')) setMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  const label = m.isOpen ? 'Everyone' : m.access.length === 0 ? 'Only me' : people.filter((x) => m.access.includes(x.id)).map((x) => shortName(x.name)).join(', ') || 'Only me';
  return (
    <>
      <button className="pill" onClick={(e) => setMenu((e.currentTarget as HTMLElement).getBoundingClientRect())} title="Who can open this meeting">
        <EyeGlyph /> {label}
      </button>
      {menu && createPortal(
        <div className="status-menu meet-access-menu" style={{ position: 'fixed', top: menu.bottom + 6, right: Math.max(12, window.innerWidth - menu.right) }}>
          <button className={m.isOpen ? 'on' : ''} onClick={() => { onPatch({ isOpen: true, access: [] }); setMenu(null); }}>
            Everyone on the team {m.isOpen ? '✓' : ''}
          </button>
          <button className={!m.isOpen && m.access.length === 0 ? 'on' : ''} onClick={() => { onPatch({ isOpen: false, access: [] }); setMenu(null); }}>
            Only me {!m.isOpen && m.access.length === 0 ? '✓' : ''}
          </button>
          <div className="menu-sep" />
          {people.filter((x) => x.id !== me && !x.id.startsWith('pending:')).map((x) => {
            const has = !m.isOpen && m.access.includes(x.id);
            return (
              <button key={x.id} className={has ? 'on' : ''}
                onClick={() => onPatch({ isOpen: false, access: has ? m.access.filter((a) => a !== x.id) : [...(m.isOpen ? [] : m.access), x.id] })}>
                <Avatar person={x} size={18} /> {shortName(x.name)} {has ? '✓' : ''}
              </button>
            );
          })}
        </div>, document.body)}
    </>
  );
}

function MeetingDetail({ meeting: m, me, people, cloud, canEdit, progress, onPatch, onRetranscribe, onDelete, onBack, onCloseAll }: {
  meeting: Meeting; me: string; people: Person[]; cloud: boolean; canEdit: boolean; progress?: Progress;
  onPatch: (patch: Partial<Meeting>) => void; onRetranscribe: () => void; onDelete: () => void; onBack: () => void; onCloseAll: () => void;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null); // the speaker label being renamed
  const [speakerMenu, setSpeakerMenu] = useState<{ who: string; rect: DOMRect } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!speakerMenu) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.meet-speaker-menu')) setSpeakerMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [speakerMenu]);
  useEffect(() => {
    let gone = false;
    meetingAudioUrl(m, cloud).then((u) => { if (!gone) setAudioUrl(u); });
    return () => { gone = true; };
  }, [m.id, m.audioPath, cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  const owner = people.find((x) => x.id === m.owner);
  const whoPerson = (who?: string) => (who && (UUID_RE.test(who) || people.some((x) => x.id === who)) ? people.find((x) => x.id === who) : undefined);
  const whoName = (who?: string) => {
    if (!who) return null;
    const person = whoPerson(who);
    if (person) return shortName(person.name);
    if (UUID_RE.test(who)) return 'Former member';
    return who;
  };
  const renameSpeaker = (from: string, to: string) => {
    const v = to.trim();
    if (!v || v === from) return;
    onPatch({ transcript: (m.transcript ?? []).map((s) => (s.who === from ? { ...s, who: v } : s)) });
  };

  // consecutive segments by the same voice read as one turn
  const blocks: { who?: string; segs: Segment[] }[] = [];
  for (const s of m.transcript ?? []) {
    const last = blocks[blocks.length - 1];
    if (last && last.who === s.who) last.segs.push(s);
    else blocks.push({ who: s.who, segs: [s] });
  }

  const transcriptText = () => {
    const lines: string[] = [`${m.title} — ${fmtStamp(m.startedAt)}${m.durationSecs ? ` · ${fmtDur(m.durationSecs)}` : ''}`, ''];
    for (const b of blocks) {
      if (b.who) lines.push(`${whoName(b.who)}:`);
      for (const s of b.segs) lines.push(`[${fmtClock(s.t0)}] ${s.text}`);
      lines.push('');
    }
    return lines.join('\n').trim();
  };
  const agentDoc = () => {
    const parts = [...new Set(blocks.map((b) => b.who && whoName(b.who)).filter(Boolean))];
    return [
      `# ${m.title}`,
      '',
      `- Type: Meeting transcript`,
      `- Recorded: ${fmtStamp(m.startedAt)}${m.durationSecs ? ` (${fmtDur(m.durationSecs)})` : ''}`,
      parts.length ? `- Participants: ${parts.join(', ')}` : '',
      '',
      '## Transcript',
      '',
      transcriptText(),
    ].filter((x) => x !== '').join('\n');
  };

  return (
    <div className="meet-detail-embed">
      <div className="side-head">
        <button className="meet-back" onClick={onBack}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          Meetings
        </button>
        <span className="panel-spacer" />
        <button className="icon-btn" title="Close" onClick={onCloseAll}><MXGlyph /></button>
      </div>
      <div className="meet-detail-scroll">
        {canEdit ? (
          <input key={m.title} className="detail-title" defaultValue={m.title}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== m.title) onPatch({ title: v }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        ) : <div className="detail-title as-text">{m.title}</div>}
        <div className="meet-detail-meta">
          {owner && <Avatar person={owner} size={18} />}
          <span>{fmtStamp(m.startedAt)}</span>
          {m.durationSecs ? <span>· {fmtDur(m.durationSecs)}</span> : null}
          <StatusChip m={m} progress={progress} />
          <span className="panel-spacer" />
          {canEdit && <AccessPicker m={m} me={me} people={people} onPatch={onPatch} />}
        </div>
        {audioUrl && <audio ref={audioRef} className="meet-audio" controls src={audioUrl} />}

        <div className="meet-actions">
          {audioUrl && (
            <button className="icon-btn" title="Download audio" onClick={async () => {
              try {
                const blob = await fetch(audioUrl).then((r) => r.blob());
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${m.title.replace(/[^\w\- ]+/g, '') || 'meeting'}.webm`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
              } catch { /* audio not reachable right now */ }
            }}><DownloadGlyph /></button>
          )}
          {(m.transcript?.length ?? 0) > 0 && (
            <button className="icon-btn" title={copied ? 'Copied!' : 'Copy transcript'} onClick={() => {
              navigator.clipboard.writeText(transcriptText());
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }}>{copied ? <CheckGlyph /> : <CopyGlyph />}</button>
          )}
          <span className="panel-spacer" />
          {canEdit && <button className="icon-btn danger" title="Delete meeting" onClick={onDelete}><TrashTiny /></button>}
        </div>

        <div className="meet-transcript">
          {blocks.map((b, bi) => (
            <div key={bi} className="meet-turn">
              {b.who && (
                <div className="meet-speaker">
                  {whoPerson(b.who) ? <Avatar person={whoPerson(b.who)!} size={18} /> : <span className="meet-speaker-dot" />}
                  {renaming === b.who && canEdit ? (
                    <input autoFocus className="meet-speaker-input" defaultValue={whoName(b.who) ?? ''}
                      onBlur={(e) => { renameSpeaker(b.who!, e.target.value); setRenaming(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                  ) : (
                    <button className="meet-speaker-name" disabled={!canEdit}
                      title={canEdit ? 'Who is this?' : undefined}
                      onClick={(e) => setSpeakerMenu({ who: b.who!, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
                      {whoName(b.who)}
                    </button>
                  )}
                </div>
              )}
              {b.segs.map((s, i) => (
                <p key={i} className="meet-seg" onClick={() => { const a = audioRef.current; if (a && Number.isFinite(s.t0)) { a.currentTime = s.t0; a.play().catch(() => {}); } }}>
                  <span className="meet-ts">{fmtClock(s.t0)}</span>
                  {s.text}
                </p>
              ))}
            </div>
          ))}
          {!m.transcript?.length && !progress && (
            <div className="meet-empty">
              No transcript yet.
              {(m.audioPath || !cloud) && <button className="pill" onClick={onRetranscribe}>Transcribe</button>}
            </div>
          )}
        </div>
      </div>
      <SendToAgent doc={agentDoc} />
      {speakerMenu && createPortal(
        <div className="status-menu meet-speaker-menu" style={{ position: 'fixed', top: Math.min(speakerMenu.rect.bottom + 6, window.innerHeight - 260), left: speakerMenu.rect.left }}>
          {people.filter((x) => !x.id.startsWith('pending:')).map((x) => (
            <button key={x.id} className={speakerMenu.who === x.id ? 'on' : ''}
              onClick={() => { renameSpeaker(speakerMenu.who, x.id); setSpeakerMenu(null); }}>
              <Avatar person={x} size={18} /> {shortName(x.name)} {speakerMenu.who === x.id ? '✓' : ''}
            </button>
          ))}
          <div className="menu-sep" />
          <button onClick={() => { setRenaming(speakerMenu.who); setSpeakerMenu(null); }}>Someone else…</button>
        </div>, document.body)}
    </div>
  );
}

function MXGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
function DownloadGlyph() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3M7 10l5 5 5-5M12 15V3" /></svg>;
}
function CopyGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
}
function TrashTiny() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-.8 14a2 2 0 0 1-2 1.9H7.8a2 2 0 0 1-2-1.9L5 6" /></svg>;
}
function CheckGlyph() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
}
function MicGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" /></svg>;
}
function LockTiny() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}
function EyeGlyph() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
}
