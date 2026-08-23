import { useState } from 'react';
import type { Data, Person } from './types';
import { PROJECT_COLORS } from './types';
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

  return (
    <section className="panel team-page">
      <div className="panel-head">
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
