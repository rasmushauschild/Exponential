import { useEffect, useRef, useState } from 'react';
import { TeamMark } from './App';
import type { Data, Person } from './types';
import { DEFAULT_RETRO_FIELDS, PROJECT_COLORS, type RetroField } from './types';
import { Avatar } from './WeekPlan';
import { uid } from './store';
import { isPending, pendingId } from './cloud';

interface Props {
  team: Data;
  cloud: boolean; // members are invited by Google email and join when they sign in
  canDelete: boolean;
  onUpdate: (fn: (d: Data) => Data) => void;
  onDelete: () => void;
}

/** One click registers the bundled MCP server with Claude Desktop / Claude Code on this machine.
 *  The button reads the actual registration state, so it stays blue across restarts. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <span className="trash-kind" style={{ width: 68 }}>{label}</span>
      <code className="copy-code">{value}</code>
      <button className="pill small" onClick={() => { navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ClaudeConnect() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; messages: string[] } | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [entry, setEntry] = useState<{ command: string; serverPath: string } | null>(null);
  const [showOther, setShowOther] = useState(false);
  const refresh = () => window.exponential?.claudeStatus?.().then((s) => { setTargets(s.targets); setEntry(s.entry); }).catch(() => {});
  useEffect(() => { refresh(); }, []);
  const connect = async () => {
    setBusy(true);
    try { setResult(await window.exponential!.connectClaude!()); }
    catch (e) { setResult({ ok: false, messages: [String((e as Error).message ?? e)] }); }
    finally { setBusy(false); refresh(); }
  };
  const connected = targets.length > 0;
  return (
    <div>
      <button
        className={`pill toggle${connected ? ' active' : ''}`}
        onClick={connect}
        disabled={busy}
        title={connected ? `Connected: ${targets.join(' · ')} — click to re-register` : 'Register Exponential with Claude on this computer'}
      >
        {connected && !busy && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 -2px' }}>
            <path d="M4.5 12.5l5 5L19.5 7" />
          </svg>
        )}
        {busy ? 'Connecting…' : connected ? 'Connected to Claude' : 'Connect to Claude'}
      </button>
      {entry && (
        <button className="pill" style={{ marginLeft: 8 }} onClick={() => setShowOther((v) => !v)}>
          Connect another agent
        </button>
      )}
      {result?.messages.map((m, i) => <p key={i} className="hint" style={{ padding: '8px 0 0' }}>{m}</p>)}
      {showOther && entry && (
        <div className="agent-connect">
          <p className="hint" style={{ margin: '10px 0 8px' }}>
            Any MCP-capable agent can use Exponential. Register a stdio server with this command — as one line, or as the usual JSON entry:
          </p>
          <CopyRow label="Command" value={`ELECTRON_RUN_AS_NODE=1 "${entry.command}" "${entry.serverPath}"`} />
          <CopyRow label="JSON" value={JSON.stringify({ command: entry.command, args: [entry.serverPath], env: { ELECTRON_RUN_AS_NODE: '1' } })} />
        </div>
      )}
    </div>
  );
}

/** Members of the current team. Moderators can add, remove, and promote/demote. */
export function TeamPage({ team, cloud, canDelete, onUpdate, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isMod = team.moderators.includes(team.me);

  // Soft-deleted projects and tasks, newest first; anyone may bring one back.
  const trash = [
    ...team.projects.filter((p) => p.deletedAt).map((p) => ({ id: p.id, kind: 'Project', name: p.name, at: p.deletedAt! })),
    ...team.tasks.filter((t) => t.deletedAt).map((t) => ({ id: t.id, kind: 'Task', name: t.title || '(untitled)', at: t.deletedAt! })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const daysLeft = (at: string) => Math.max(1, Math.ceil(7 - (Date.now() - new Date(at).getTime()) / 86_400_000));
  const when = (at: string) => {
    const d = new Date(at);
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  };
  const recover = (id: string) => onUpdate((d) => ({
    ...d,
    projects: d.projects.map((p) => (p.id === id ? { ...p, deletedAt: undefined } : p)),
    tasks: d.tasks.map((t) => (t.id === id ? { ...t, deletedAt: undefined } : t)),
  }));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const add = () => {
    const n = name.trim(), em = email.trim().toLowerCase();
    if (cloud ? !em.includes('@') : !n) return;
    if (cloud && team.people.some((p) => p.email?.toLowerCase() === em)) { setAdding(false); return; }
    const color = PROJECT_COLORS[team.people.length % PROJECT_COLORS.length];
    const person: Person = cloud
      ? { id: pendingId(em), name: n || em, email: em, color }
      : { id: uid(), name: n, email: em || undefined, color };
    onUpdate((d) => ({ ...d, people: [...d.people, person] }));
    setName(''); setEmail(''); setAdding(false);
  };

  const remove = (id: string) =>
    onUpdate((d) => ({
      ...d,
      people: d.people.filter((p) => p.id !== id),
      moderators: d.moderators.filter((m) => m !== id),
      tasks: d.tasks.filter((t) => t.personId !== id),
      projects: d.projects.map((p) => (p.assignees?.includes(id) ? { ...p, assignees: p.assignees.filter((a) => a !== id) } : p)),
    }));

  const toggleMod = (id: string) =>
    onUpdate((d) => ({ ...d, moderators: d.moderators.includes(id) ? d.moderators.filter((m) => m !== id) : [...d.moderators, id] }));

  const fields = team.retroFields ?? DEFAULT_RETRO_FIELDS;
  const setFields = (next: RetroField[]) => onUpdate((d) => ({ ...d, retroFields: next }));
  const fileRef = useRef<HTMLInputElement>(null);
  const pickIcon = (file: File) => {
    // downscale to 256px so the data URL stays small in the saved file
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d')!;
      const sc = Math.max(256 / img.width, 256 / img.height);
      ctx.drawImage(img, (256 - img.width * sc) / 2, (256 - img.height * sc) / 2, img.width * sc, img.height * sc);
      const url = c.toDataURL('image/png');
      onUpdate((d) => ({ ...d, icon: url }));
    };
    img.src = URL.createObjectURL(file);
  };

  return (
    <section className="team-page">
      {/* ── Team: identity + Claude ── */}
      <div className="panel team-card">
        <div className="team-card-head">
          <TeamMark team={team} size={64} />
          <div className="team-card-name">
            {isMod ? (
              <input
                className="panel-title team-title-input"
                defaultValue={team.name}
                key={team.id}
                title="Rename team"
                onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== team.name) onUpdate((d) => ({ ...d, name: n })); else e.target.value = team.name; }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            ) : <div className="panel-title">{team.name}</div>}
            <div className="panel-sub-count">{team.people.length} {team.people.length === 1 ? 'member' : 'members'}</div>
          </div>
          {isMod && (
            <div className="icon-row">
              <button className="pill" onClick={() => fileRef.current?.click()}>{team.icon ? 'Change image' : 'Upload image'}</button>
              {team.icon && <button className="pill" onClick={() => onUpdate((d) => ({ ...d, icon: undefined }))}>Use the letter</button>}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickIcon(f); e.target.value = ''; }} />
            </div>
          )}
        </div>
        {!!window.exponential?.connectClaude && (
          <div className="team-card-sub">
            <div className="settings-title">Claude</div>
            <p className="hint" style={{ margin: '0 0 10px' }}>
              Let Claude read your plan and manage tasks. Editing the master plan needs Unlock.
            </p>
            <ClaudeConnect />
          </div>
        )}
      </div>

      {/* ── Members ── */}
      <div className="panel team-card">
        <div className="team-card-titlerow">
          <div className="settings-title">Members</div>
          {isMod && !adding && <button className="pill" onClick={() => setAdding(true)}>+ Add member</button>}
        </div>
        {adding && (
          <form className="member-row add" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <span className="avatar initials" style={{ width: 36, height: 36, background: 'var(--soft-2)', color: 'var(--text-3)', fontSize: 18 }}>+</span>
            {cloud ? (
              <input autoFocus className="member-input" placeholder="Google email — they join when they sign in" value={email} onChange={(e) => setEmail(e.target.value)} />
            ) : (
              <>
                <input autoFocus className="member-input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
                <input className="member-input" placeholder="Email (for Google Calendar)" value={email} onChange={(e) => setEmail(e.target.value)} />
              </>
            )}
            <button type="submit" className="btn primary" disabled={cloud ? !email.includes('@') : !name.trim()}>{cloud ? 'Invite' : 'Add'}</button>
            <button type="button" className="btn" onClick={() => { setAdding(false); setName(''); setEmail(''); }}>Cancel</button>
          </form>
        )}
        {team.people.map((p) => {
          const mod = team.moderators.includes(p.id);
          const self = p.id === team.me;
          const lastMod = mod && team.moderators.length === 1;
          return (
            <div key={p.id} className="member-row">
              <Avatar person={p} size={36} />
              <div className="member-info">
                <div className="member-name">{p.name}{self && <span className="you-tag">you</span>}</div>
                <div className="member-email">{isPending(p.id) ? `Invited · ${p.email} — waiting for them to sign in` : (p.email ?? 'No email yet')}</div>
              </div>
              <span className={`role${mod ? ' mod' : ''}`}>{mod ? 'Moderator' : 'Member'}</span>
              {isMod && (
                <div className="member-actions">
                  <button className="pill small" onClick={() => toggleMod(p.id)} disabled={lastMod} title={lastMod ? 'A team needs at least one moderator' : ''}>
                    {mod ? 'Make member' : 'Make moderator'}
                  </button>
                  {!self && <button className="pill small danger" onClick={() => remove(p.id)}>Remove</button>}
                </div>
              )}
            </div>
          );
        })}
        {!isMod && <p className="hint" style={{ padding: '10px 12px 2px' }}>Ask a moderator to add or remove people.</p>}
      </div>

      {/* ── Retro template ── */}
      {isMod && (
        <div className="panel team-card">
          <div className="settings-title">Retro questions</div>
          <p className="hint" style={{ margin: '0 0 8px' }}>These are the prompts everyone answers in each week's retro.</p>
          <div className="retro-config">
            {fields.map((f, i) => (
              <div key={f.key} className="retro-config-row">
                <input className="member-input" value={f.label} placeholder="Question" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input className="member-input" value={f.hint} placeholder="Hint shown when empty" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)))} />
                <button className="icon-btn" title="Remove" disabled={fields.length <= 1} onClick={() => setFields(fields.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="add-task" onClick={() => setFields([...fields, { key: uid(), label: '', hint: '' }])}><span className="plus">+</span> Add question</button>
          </div>
        </div>
      )}

      {/* ── Recently deleted ── */}
      <div className="panel team-card">
        <div className="settings-title">Recently deleted</div>
        {trash.length === 0 && <p className="hint" style={{ margin: 0 }}>Deleted projects and tasks stay here for 7 days.</p>}
        <div className="trash-list">
          {trash.map((x) => (
            <div key={x.id} className="trash-row">
              <span className="trash-kind">{x.kind}</span>
              <span className="trash-name">{x.name}</span>
              <span className="trash-when">{when(x.at)} · gone in {daysLeft(x.at)} day{daysLeft(x.at) === 1 ? '' : 's'}</span>
              <button className="pill small" onClick={() => recover(x.id)}>Recover</button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Delete team: plainly on the background, outside every box ── */}
      {isMod && canDelete && (
        <div className="team-danger">
          {confirmDelete ? (
            <div className="confirm-row">
              <span>Delete <b>{team.name}</b> with all its projects, tasks and retros for everyone? This can't be undone.</span>
              <button className="btn danger-btn" onClick={onDelete}>Delete team</button>
              <button className="btn" onClick={() => setConfirmDelete(false)}>Keep it</button>
            </div>
          ) : (
            <button className="pill danger" onClick={() => setConfirmDelete(true)}>Delete team…</button>
          )}
        </div>
      )}
    </section>
  );
}
