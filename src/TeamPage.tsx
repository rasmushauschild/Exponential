import { useRef, useState } from 'react';
import { TeamMark } from './App';
import type { Data, Person } from './types';
import { DEFAULT_RETRO_FIELDS, PROJECT_COLORS, type RetroField } from './types';
import { Avatar } from './WeekPlan';
import { uid } from './store';

interface Props {
  team: Data;
  onUpdate: (fn: (d: Data) => Data) => void;
}

/** Members of the current team. Moderators can add, remove, and promote/demote. */
export function TeamPage({ team, onUpdate }: Props) {
  const isMod = team.moderators.includes(team.me);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const add = () => {
    const n = name.trim();
    if (!n) return;
    const person: Person = { id: uid(), name: n, email: email.trim() || undefined, color: PROJECT_COLORS[team.people.length % PROJECT_COLORS.length] };
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
    <section className="panel team-page">
      <div className="panel-head">
        <TeamMark team={team} size={38} />
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
        <div className="panel-spacer" />
        {isMod && !adding && <button className="pill" onClick={() => setAdding(true)}>+ Add member</button>}
      </div>

      <div className="team-body">
        {isMod && (
          <div className="settings-block">
            <div className="settings-title">Icon</div>
            <div className="icon-row">
              <TeamMark team={team} size={64} />
              <button className="pill" onClick={() => fileRef.current?.click()}>{team.icon ? 'Change image' : 'Upload image'}</button>
              {team.icon && <button className="pill" onClick={() => onUpdate((d) => ({ ...d, icon: undefined }))}>Use the letter</button>}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickIcon(f); e.target.value = ''; }} />
            </div>

            <div className="settings-title" style={{ marginTop: 22 }}>Retro questions</div>
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

            <div className="settings-title" style={{ marginTop: 22 }}>Members</div>
          </div>
        )}
        {adding && (
          <form className="member-row add" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <span className="avatar initials" style={{ width: 36, height: 36, background: 'var(--soft-2)', color: 'var(--text-3)', fontSize: 18 }}>+</span>
            <input autoFocus className="member-input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="member-input" placeholder="Email (for Google Calendar)" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button type="submit" className="btn primary" disabled={!name.trim()}>Add</button>
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
                <div className="member-email">{p.email ?? (p.id === team.me ? 'Sign in with Google to add your email' : 'No email yet')}</div>
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
        {!isMod && <p className="hint" style={{ padding: '14px 12px' }}>Ask a moderator to add or remove people.</p>}
      </div>
    </section>
  );
}
