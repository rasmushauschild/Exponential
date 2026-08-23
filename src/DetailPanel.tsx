import { useEffect, useRef, useState } from 'react';
import type { Deadline, ISODate, Notification, Person, Project, Retro, Status, Task } from './types';
import { PROJECT_COLORS, STATUS_LABEL, STATUS_ORDER, shortName } from './types';
import { Avatar, StatusDot } from './WeekPlan';
import { addDays, formatRange, isoWeekNumber } from './dates';

export type Selection =
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'deadline'; id: string }
  | { kind: 'retro'; id: ISODate }
  | { kind: 'inbox'; id: 'inbox' };

interface Props {
  selection: Selection;
  project?: Project;
  task?: Task;
  deadline?: Deadline;
  retro?: Retro;
  notifications: Notification[];
  people: Person[];
  me: string;
  onClose: () => void;
  onUpdateProject: (id: string, patch: Partial<Project>, coalesce?: string) => void;
  onToggleAssignee: (projectId: string, personId: string) => void;
  onUpdateTask: (id: string, patch: Partial<Task>, coalesce?: string) => void;
  onUpdateDeadline: (id: string, patch: Partial<Deadline>, coalesce?: string) => void;
  onUpdateRetro: (week: ISODate, patch: Partial<Retro>, coalesce?: string) => void;
  onOpen: (sel: Selection) => void;
  onMarkRead: (ids: string[]) => void;
  onDelete: () => void;
}

export function DetailPanel(p: Props) {
  const { selection, project, task, deadline, retro, people, me, onClose, onDelete } = p;

  if (selection.kind === 'inbox') return <Inbox {...p} />;
  if (selection.kind === 'retro') return <RetroDoc week={selection.id} retro={retro} onUpdate={p.onUpdateRetro} onClose={onClose} />;

  const item = project ?? task ?? deadline;
  if (!item) return null;

  const title = project ? project.name : task ? task.title : deadline!.name;
  const setTitle = (v: string) => {
    if (project) p.onUpdateProject(project.id, { name: v });
    else if (task) p.onUpdateTask(task.id, { title: v });
    else if (deadline) p.onUpdateDeadline(deadline.id, { name: v });
  };
  const setNotes = (html: string) => {
    const key = `notes:${item.id}`;
    if (project) p.onUpdateProject(project.id, { notes: html }, key);
    else if (task) p.onUpdateTask(task.id, { notes: html }, key);
    else if (deadline) p.onUpdateDeadline(deadline.id, { notes: html }, key);
  };

  const others = people.filter((x) => x.id !== me);

  return (
    <aside className="detail">
      <div className="detail-top">
        <span className="panel-spacer" />
        <button className="icon-btn" title="Delete" onClick={onDelete}><TrashIcon /></button>
        <button className="icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
      </div>

      <div className="detail-scroll">
        <TitleInput key={item.id} value={title} onChange={setTitle} />

        <div className="props">
          {project && (
            <>
              <Prop label="Starts"><input type="date" value={project.start} max={project.end}
                onChange={(e) => e.target.value && p.onUpdateProject(project.id, { start: e.target.value })} /></Prop>
              <Prop label="Ends"><input type="date" value={project.end} min={project.start}
                onChange={(e) => e.target.value && p.onUpdateProject(project.id, { end: e.target.value })} /></Prop>
              <Prop label="People">
                <div className="people-pick">
                  {people.map((x) => {
                    const on = project.assignees?.includes(x.id);
                    return (
                      <button key={x.id} className={`pick${on ? ' on' : ''}`} title={x.name}
                        onClick={() => p.onToggleAssignee(project.id, x.id)}>
                        <Avatar person={x} size={22} />
                        <span>{x.id === me ? 'Me' : shortName(x.name).split(' ')[0]}</span>
                      </button>
                    );
                  })}
                </div>
              </Prop>
              <Prop label="Colour">
                <div className="swatches">
                  {PROJECT_COLORS.map((c) => (
                    <button key={c} className={`swatch${(project.color ?? '') === c ? ' on' : ''}`} style={{ ['--pc' as string]: c }}
                      onClick={() => p.onUpdateProject(project.id, { color: c })} />
                  ))}
                </div>
              </Prop>
            </>
          )}
          {task && (
            <>
              <Prop label="Status">
                <StatusSelect value={task.status} onChange={(s) => p.onUpdateTask(task.id, { status: s })} />
              </Prop>
              {task.status === 'review' && (
                <Prop label="Review by">
                  <PersonSelect people={others} value={task.reviewerId} placeholder="Choose a reviewer"
                    onChange={(id) => p.onUpdateTask(task.id, { reviewerId: id })} />
                </Prop>
              )}
              <Prop label="Owner">
                <PersonSelect people={people} value={task.personId} me={me}
                  onChange={(id) => id && p.onUpdateTask(task.id, { personId: id })} />
              </Prop>
              <Prop label="Starts"><input type="date" value={task.date} max={task.end}
                onChange={(e) => e.target.value && p.onUpdateTask(task.id, { date: e.target.value })} /></Prop>
              <Prop label="Ends"><input type="date" value={task.end ?? task.date} min={task.date}
                onChange={(e) => e.target.value && p.onUpdateTask(task.id, { end: e.target.value === task.date ? undefined : e.target.value })} /></Prop>
              {task.createdBy && task.createdBy !== task.personId && (
                <Prop label="Added by"><span className="prop-text">{shortName(people.find((x) => x.id === task.createdBy)?.name ?? '')}</span></Prop>
              )}
            </>
          )}
          {deadline && (
            <Prop label="Date"><input type="date" value={deadline.date}
              onChange={(e) => e.target.value && p.onUpdateDeadline(deadline.id, { date: e.target.value })} /></Prop>
          )}
        </div>

        <Editor key={`ed-${item.id}`} html={item.notes ?? ''} onChange={setNotes} />
      </div>
    </aside>
  );
}

/* ─── Retro ─────────────────────────────────────────── */

const RETRO_FIELDS: { key: keyof Pick<Retro, 'wentWell' | 'improve' | 'learnings' | 'nextFocus'>; label: string; hint: string }[] = [
  { key: 'wentWell', label: 'What went well', hint: 'Wins, things to keep doing…' },
  { key: 'improve', label: 'What could be better', hint: 'Friction, misses, surprises…' },
  { key: 'learnings', label: 'Learnings', hint: 'What we know now that we didn’t before…' },
  { key: 'nextFocus', label: 'Focus for next week', hint: 'The one or two things that matter most…' },
];

function RetroDoc({ week, retro, onUpdate, onClose }: { week: ISODate; retro?: Retro; onUpdate: Props['onUpdateRetro']; onClose: () => void }) {
  return (
    <aside className="detail">
      <div className="detail-top">
        <span className="detail-kind">Retro · {formatRange(week, addDays(week, 6))}</span>
        <span className="panel-spacer" />
        <button className="icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
      </div>
      <div className="detail-scroll">
        <h1 className="detail-title static">Week {isoWeekNumber(week)}</h1>
        <div className="retro-fields">
          {RETRO_FIELDS.map((f) => (
            <label key={f.key} className="retro-field">
              <span className="retro-label">{f.label}</span>
              <AutoTextarea
                value={retro?.[f.key] ?? ''}
                placeholder={f.hint}
                onChange={(v) => onUpdate(week, { [f.key]: v }, `retro:${week}:${f.key}`)}
              />
            </label>
          ))}
        </div>
        <div className="retro-label" style={{ marginTop: 22 }}>Notes</div>
        <Editor key={`retro-${week}`} html={retro?.notes ?? ''} onChange={(html) => onUpdate(week, { notes: html }, `retro:${week}:notes`)} />
      </div>
    </aside>
  );
}

function AutoTextarea({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} className="retro-input" rows={1} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/* ─── Inbox ─────────────────────────────────────────── */

function Inbox({ notifications, people, me, onClose, onOpen, onMarkRead }: Props) {
  const mine = notifications.filter((n) => n.to === me).sort((a, b) => b.at.localeCompare(a.at));
  const unreadKey = mine.filter((n) => !n.read).map((n) => n.id).join(',');
  useEffect(() => {
    if (!unreadKey) return;
    const t = setTimeout(() => onMarkRead(unreadKey.split(',')), 1500);
    return () => clearTimeout(t);
  }, [unreadKey, onMarkRead]);
  return (
    <aside className="detail">
      <div className="detail-top">
        <span className="panel-spacer" />
        <button className="icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
      </div>
      <div className="detail-scroll">
        <h1 className="detail-title static">Notifications</h1>
        {mine.length === 0 && <p className="muted">Nothing yet. You’ll hear here when a task is added for you, a review is requested, or a project you’re on changes.</p>}
        <div className="notif-list">
          {mine.map((n) => {
            const from = people.find((x) => x.id === n.from);
            return (
              <button key={n.id} className={`notif${n.read ? '' : ' unread'}`} onClick={() => onOpen({ kind: n.ref.kind, id: n.ref.id } as Selection)}>
                {from && <Avatar person={from} size={28} />}
                <span className="notif-body">
                  <span className="notif-text">{n.text}</span>
                  <span className="notif-time">{relTime(n.at)}</span>
                </span>
                {!n.read && <span className="notif-dot" />}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/* ─── Shared bits ───────────────────────────────────── */

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop">
      <span className="prop-label">{label}</span>
      {children}
    </div>
  );
}

function TitleInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="detail-title"
      value={v}
      placeholder="Untitled"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { const t = v.trim(); if (t && t !== value) onChange(t); else setV(value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function useClickAway(open: boolean, cls: string, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(cls)) close(); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open, cls, close]);
}

function StatusSelect({ value, onChange }: { value: Status; onChange: (s: Status) => void }) {
  const [open, setOpen] = useState(false);
  useClickAway(open, '.status-select', () => setOpen(false));
  return (
    <div className="status-select">
      <button className="pill small" onClick={() => setOpen((o) => !o)}><StatusDot status={value} /> {STATUS_LABEL[value]}</button>
      {open && (
        <div className="status-menu" style={{ top: 34, left: 0 }}>
          {STATUS_ORDER.map((s) => (
            <button key={s} className={s === value ? 'current' : ''} onClick={() => { onChange(s); setOpen(false); }}>
              <StatusDot status={s} /> {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PersonSelect({ people, value, me, placeholder, onChange }: {
  people: Person[]; value?: string; me?: string; placeholder?: string; onChange: (id: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  useClickAway(open, '.person-select', () => setOpen(false));
  const cur = people.find((x) => x.id === value);
  return (
    <div className="person-select status-select">
      <button className={`pill small${cur ? '' : ' empty'}`} onClick={() => setOpen((o) => !o)}>
        {cur ? <><Avatar person={cur} size={16} /> {cur.id === me ? 'Me' : shortName(cur.name)}</> : placeholder ?? 'Choose…'}
      </button>
      {open && (
        <div className="status-menu" style={{ top: 34, left: 0 }}>
          {people.map((x) => (
            <button key={x.id} className={x.id === value ? 'current' : ''} onClick={() => { onChange(x.id); setOpen(false); }}>
              <Avatar person={x} size={18} /> {x.id === me ? 'Me' : shortName(x.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Minimal Notion-ish editor on contenteditable. Stores HTML; images are inlined as data URLs. */
function Editor({ html, onChange }: { html: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html;
  }, [html]);

  const emit = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ref.current && onChange(ref.current.innerHTML), 250);
  };

  const cmd = (name: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(name, false, value);
    emit();
  };

  const insertImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => cmd('insertHTML', `<img src="${reader.result}" /><p><br></p>`);
    reader.readAsDataURL(file);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); cmd('bold'); }
    if (k === 'i') { e.preventDefault(); cmd('italic'); }
    if (k === 'u') { e.preventDefault(); cmd('underline'); }
  };

  return (
    <div className="editor">
      <div className="toolbar">
        <button onClick={() => cmd('formatBlock', 'h1')} title="Heading 1">H1</button>
        <button onClick={() => cmd('formatBlock', 'h2')} title="Heading 2">H2</button>
        <button onClick={() => cmd('formatBlock', 'p')} title="Text">Aa</button>
        <span className="tb-sep" />
        <button onClick={() => cmd('bold')} title="Bold (⌘B)"><b>B</b></button>
        <button onClick={() => cmd('italic')} title="Italic (⌘I)"><i>I</i></button>
        <span className="tb-sep" />
        <button onClick={() => cmd('insertUnorderedList')} title="Bullet list">• List</button>
        <button onClick={() => cmd('insertOrderedList')} title="Numbered list">1.</button>
        <button onClick={() => cmd('insertHTML', '<input type="checkbox"> ')} title="Checkbox">☐</button>
        <span className="tb-sep" />
        <button onClick={() => fileRef.current?.click()} title="Insert image">Image</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImage(f); e.target.value = ''; }} />
      </div>
      <div
        ref={ref}
        className="editor-body"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write notes, add headings, bullet points or drop in an image…"
        onInput={emit}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const f = Array.from(e.clipboardData.files)[0];
          if (f && f.type.startsWith('image/')) { e.preventDefault(); insertImage(f); }
        }}
        onDrop={(e) => {
          const f = e.dataTransfer.files[0];
          if (f && f.type.startsWith('image/')) { e.preventDefault(); insertImage(f); }
        }}
      />
    </div>
  );
}

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
function TrashIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;
}
