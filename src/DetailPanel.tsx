import { useEffect, useRef, useState } from 'react';
import type { Deadline, ISODate, Notification, Person, Project, Retro, RetroField, Status, Task } from './types';
import { htmlToMarkdown } from './store';
import { PROJECT_COLORS, STATUS_LABEL, shortName } from './types';
import { Avatar, StatusDot, StatusMenu } from './WeekPlan';
import { BlockEditor } from './BlockEditor';
import { addDays, formatRange, isoWeekNumber } from './dates';

export type Selection =
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'deadline'; id: string }
  | { kind: 'retro'; id: ISODate }
  | { kind: 'inbox'; id: 'inbox' };

interface Props {
  selection: Selection;
  width: number;
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
  retroFields: RetroField[];
  onOpen: (sel: Selection) => void;
  onMarkRead: (ids: string[]) => void;
  onDelete: () => void;
  tasks: Task[]; // all tasks of the team
  onCreateLinked: (link: { projectId?: string; parentId?: string }, title: string) => string;
  onDeleteTask: (id: string) => void;
  onClaimTask: (id: string) => void;
}

export function DetailPanel(p: Props) {
  const { selection, project, task, deadline, retro, people, me, onClose, onDelete } = p;

  const style = { width: p.width };
  if (selection.kind === 'inbox') return <Inbox {...p} />;
  if (selection.kind === 'retro') return <RetroDoc week={selection.id} retro={retro} fields={p.retroFields} onUpdate={p.onUpdateRetro} onClose={onClose} width={p.width} />;

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
  const kind = project ? 'Project' : task ? 'Task' : 'Deadline';

  const agentDoc = () => {
    const who = (id?: string) => (id ? shortName(people.find((x) => x.id === id)?.name ?? '') : '');
    const lines = [`# ${title}`, '', `- Type: ${kind}`];
    if (project) {
      lines.push(`- Starts: ${project.start}`, `- Ends: ${project.end}`);
      if (project.assignees?.length) lines.push(`- People: ${project.assignees.map(who).join(', ')}`);
    }
    if (task) {
      lines.push(`- Status: ${STATUS_LABEL[task.status]}`, `- Owner: ${who(task.personId)}`, `- Date: ${task.date ? `${task.date}${task.end ? ` → ${task.end}` : ''}` : 'backlog (no date yet)'}`);
      if (task.reviewerId) lines.push(`- Reviewer: ${who(task.reviewerId)}`);
    }
    if (deadline) lines.push(`- Date: ${deadline.date}`);
    if (item.notes?.trim()) {
      const live = item.notes.replace(/^- \[( |x)\] ?(.*?)\s*<!--task:([0-9a-f-]{36})-->\s*$/gim, (_m, _c, _t, id) => {
        const t = p.tasks.find((x) => x.id === id);
        return t ? `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.personId ? ` (${who(t.personId)}, ${STATUS_LABEL[t.status]})` : ' (unassigned)'}` : '';
      });
      lines.push('', '## Notes', '', live.trim());
    }
    return lines.join('\n');
  };

  return (
    <aside className="detail" style={style}>
      <div className="detail-top">
        <span className="detail-kind">{kind}</span>
        <span className="panel-spacer" />
        <button className="icon-btn" title="Delete" onClick={onDelete}><TrashIcon /></button>
        <button className="icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
      </div>

      <div className="detail-scroll">
        <TitleInput key={item.id} value={title} onChange={setTitle} />

        <div className="props">
          {project && (
            <>
              <Prop label="Dates">
                <DateRange start={project.start} end={project.end}
                  onChange={(start, end) => p.onUpdateProject(project.id, { start, end })} />
              </Prop>
              <Prop label="People">
                <AssigneePicker people={people} me={me} assignees={project.assignees ?? []} onToggle={(id) => p.onToggleAssignee(project.id, id)} />
              </Prop>
              <Prop label="Colour">
                <ColorPicker value={project.color} onChange={(c) => p.onUpdateProject(project.id, { color: c })} />
              </Prop>
            </>
          )}
          {task && (
            <>
              <Prop label="Status">
                <StatusSelect
                  value={task.status}
                  reviewerId={task.reviewerId}
                  people={people.filter((x) => x.id !== task.personId)}
                  onPick={(status, reviewerId) => p.onUpdateTask(task.id, reviewerId !== undefined ? { status, reviewerId } : { status })}
                />
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
              <Prop label="Dates">
                {task.date ? (
                  <>
                    <DateRange start={task.date} end={task.end ?? task.date}
                      onChange={(start, end) => p.onUpdateTask(task.id, { date: start, end: end === start ? undefined : end })} />
                    <button className="icon-btn small" title="Move to backlog" onClick={() => p.onUpdateTask(task.id, { date: undefined, end: undefined })}>×</button>
                  </>
                ) : (
                  <label className="date-pill empty" title="Pick a date">
                    Backlog · set date
                    <input type="date" style={{ width: 0, opacity: 0 }} onChange={(e) => e.target.value && p.onUpdateTask(task.id, { date: e.target.value })} />
                  </label>
                )}
              </Prop>
              {task.createdBy && task.createdBy !== task.personId && (
                <Prop label="Added by"><span className="prop-text">{shortName(people.find((x) => x.id === task.createdBy)?.name ?? '')}</span></Prop>
              )}
            </>
          )}
          {deadline && (
            <Prop label="Date">
              <span className="date-pill">
                <input type="date" value={deadline.date} onChange={(e) => e.target.value && p.onUpdateDeadline(deadline.id, { date: e.target.value })} />
              </span>
            </Prop>
          )}
        </div>

        {deadline ? (
          <MarkdownEditor key={`ed-${item.id}`} value={item.notes ?? ''} onChange={setNotes} />
        ) : (
          <BlockEditor
            key={`blocks-${item.id}`}
            value={item.notes ?? ''}
            onChange={setNotes}
            tasks={p.tasks.filter((t) => (project ? t.projectId === project.id : t.parentId === task!.id))}
            people={people}
            me={me}
            claimable={!!project}
            createTask={(title) => p.onCreateLinked(project ? { projectId: project.id } : { parentId: task!.id }, title)}
            onUpdateTask={(id, patch) => p.onUpdateTask(id, patch)}
            onDeleteTask={p.onDeleteTask}
            onClaim={p.onClaimTask}
            onOpenTask={(id) => p.onOpen({ kind: 'task', id })}
          />
        )}
      </div>
      <SendToAgent doc={agentDoc} />
    </aside>
  );
}

/* ─── Retro ─────────────────────────────────────────── */

function RetroDoc({ week, retro, fields, onUpdate, onClose, width }: { week: ISODate; retro?: Retro; fields: RetroField[]; onUpdate: Props['onUpdateRetro']; onClose: () => void; width: number }) {
  return (
    <aside className="detail" style={{ width }}>
      <div className="detail-top">
        <span className="detail-kind">Retro</span>
        <span className="panel-spacer" />
        <button className="icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
      </div>
      <div className="detail-scroll">
        <h1 className="detail-title static">Week {isoWeekNumber(week)}</h1>
        <div className="retro-fields">
          {fields.map((f) => (
            <label key={f.key} className="retro-field">
              <span className="retro-label">{f.label}</span>
              <AutoTextarea
                value={retro?.answers[f.key] ?? ''}
                placeholder={f.hint}
                onChange={(v) => onUpdate(week, { answers: { [f.key]: v } }, `retro:${week}:${f.key}`)}
              />
            </label>
          ))}
        </div>
        <div className="retro-label" style={{ marginTop: 22 }}>Notes</div>
        <MarkdownEditor key={`retro-${week}`} value={retro?.notes ?? ''} onChange={(md) => onUpdate(week, { notes: md }, `retro:${week}:notes`)} />
      </div>
      <SendToAgent doc={() => [`# Retro — Week ${isoWeekNumber(week)} (${formatRange(week, addDays(week, 6))})`, '',
        ...fields.flatMap((f) => [`## ${f.label}`, '', retro?.answers[f.key]?.trim() || '_(empty)_', '']),
        ...(retro?.notes?.trim() ? ['## Notes', '', retro.notes.trim()] : [])].join('\n')} />
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

function Inbox({ notifications, people, me, onClose, onOpen, onMarkRead, width }: Props) {
  const mine = notifications.filter((n) => n.to === me).sort((a, b) => b.at.localeCompare(a.at));
  const unreadKey = mine.filter((n) => !n.read).map((n) => n.id).join(',');
  useEffect(() => {
    if (!unreadKey) return;
    const t = setTimeout(() => onMarkRead(unreadKey.split(',')), 1500);
    return () => clearTimeout(t);
  }, [unreadKey, onMarkRead]);
  return (
    <aside className="detail" style={{ width }}>
      <div className="detail-top">
        <span className="detail-kind">Inbox</span>
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

/** One pill holding both ends of a range; moving the start past the end (or vice versa) drags the other along. */
function DateRange({ start, end, onChange }: { start: string; end: string; onChange: (start: string, end: string) => void }) {
  return (
    <span className="date-pill">
      <input type="date" value={start} onChange={(e) => { const v = e.target.value; if (v) onChange(v, v > end ? v : end); }} />
      <span className="dash">–</span>
      <input type="date" value={end} onChange={(e) => { const v = e.target.value; if (v) onChange(v < start ? v : start, v); }} />
    </span>
  );
}

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

function StatusSelect({ value, reviewerId, people, onPick }: {
  value: Status; reviewerId?: string; people: Person[]; onPick: (s: Status, reviewerId?: string) => void;
}) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  useClickAway(!!open, '.status-select', () => setOpen(null));
  return (
    <div className="status-select">
      <button className="pill small" onClick={(e) => setOpen((o) => (o ? null : (e.currentTarget as HTMLElement).getBoundingClientRect()))}><StatusDot status={value} /> {STATUS_LABEL[value]}</button>
      {open && <StatusMenu value={value} reviewerId={reviewerId} people={people} onPick={(s, r) => { onPick(s, r); setOpen(null); }} anchor={open} />}
    </div>
  );
}

/** Assigned people as chips, plus a "+" that opens a list of everyone not yet assigned. */
function AssigneePicker({ people, me, assignees, onToggle }: { people: Person[]; me: string; assignees: string[]; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  useClickAway(open, '.assignee-picker', () => setOpen(false));
  const assigned = assignees.map((id) => people.find((x) => x.id === id)).filter(Boolean) as Person[];
  const rest = people.filter((x) => !assignees.includes(x.id));
  return (
    <div className="assignee-picker status-select">
      <div className="chips">
        {assigned.map((x) => (
          <span key={x.id} className="chip" title={x.name}>
            <Avatar person={x} size={18} />
            {x.id === me ? 'Me' : shortName(x.name)}
            <button className="chip-x" title="Remove" onClick={() => onToggle(x.id)}>×</button>
          </span>
        ))}
        <button className="chip add" title="Add person" onClick={() => setOpen((o) => !o)} disabled={rest.length === 0}>+</button>
      </div>
      {open && (
        <div className="status-menu" style={{ top: 34, left: 0 }}>
          {rest.map((x) => (
            <button key={x.id} onClick={() => { onToggle(x.id); if (rest.length <= 1) setOpen(false); }}>
              <Avatar person={x} size={18} /> {x.id === me ? 'Me' : shortName(x.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value?: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  useClickAway(open, '.color-picker', () => setOpen(false));
  const cur = value ?? PROJECT_COLORS[0];
  return (
    <div className="color-picker status-select">
      <button className="chip" onClick={() => setOpen((o) => !o)} title="Change colour">
        <span className="swatch small" style={{ ['--pc' as string]: cur }} /> <span className="chev">▾</span>
      </button>
      {open && (
        <div className="status-menu swatch-menu" style={{ top: 34, left: 0 }}>
          {PROJECT_COLORS.map((c) => (
            <button key={c} className={`swatch${cur === c ? ' on' : ''}`} style={{ ['--pc' as string]: c }} onClick={() => { onChange(c); setOpen(false); }} />
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

/**
 * Notes are stored as Markdown. By default they're edited as rich text (a contenteditable that
 * renders the Markdown and converts edits back); a "Markdown" toggle shows the raw source.
 */
function MarkdownEditor({ value, onChange }: { value: string; onChange: (md: string) => void }) {
  const [source] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const lastEmitted = useRef(value);
  const pending = useRef<string | null>(null);
  const flush = () => {
    window.clearTimeout(timer.current);
    if (pending.current !== null) { onChange(pending.current); pending.current = null; }
  };
  const emit = (md: string) => {
    lastEmitted.current = md;
    pending.current = md;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 250);
  };
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="editor">
      {source
        ? <SourceEditor value={pending.current ?? value} onEmit={emit} onToggle={() => {}} />
        : <RichEditor value={value} lastEmitted={lastEmitted} onEmit={emit} />}
    </div>
  );
}

function ToolbarButton({ label, title, onClick, active }: { label: string; title: string; onClick: () => void; active?: boolean }) {
  return <button className={active ? 'on' : ''} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>;
}

function RichEditor({ value, lastEmitted, onEmit }: { value: string; lastEmitted: React.MutableRefObject<string>; onEmit: (md: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Only re-render the DOM when the value changed from outside (undo, another item), never for our own edits.
  useEffect(() => {
    if (ref.current && value !== lastEmitted.current) { ref.current.innerHTML = renderMarkdown(value, true); lastEmitted.current = value; }
  }, [value, lastEmitted]);
  useEffect(() => { if (ref.current) ref.current.innerHTML = renderMarkdown(value, true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    // checkbox state lives on the DOM property; mirror it to the attribute so it survives serialisation
    el.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.checked ? c.setAttribute('checked', '') : c.removeAttribute('checked')));
    onEmit(htmlToMarkdown(el.innerHTML));
  };
  const cmd = (name: string, arg?: string) => { ref.current?.focus(); document.execCommand(name, false, arg); sync(); };
  const insertImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => cmd('insertHTML', `<img src="${reader.result}"><p><br></p>`);
    reader.readAsDataURL(file);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); cmd('bold'); }
    if (k === 'i') { e.preventDefault(); cmd('italic'); }
  };

  return (
    <>
      <div className="toolbar">
        <ToolbarButton label="H1" title="Heading 1" onClick={() => cmd('formatBlock', 'h1')} />
        <ToolbarButton label="H2" title="Heading 2" onClick={() => cmd('formatBlock', 'h2')} />
        <ToolbarButton label="Text" title="Plain paragraph" onClick={() => cmd('formatBlock', 'p')} />
        <ToolbarButton label="Todo" title="To-do — teammates can add it to their week" onClick={() => cmd('insertHTML', '<ul><li><input type="checkbox"> </li></ul>')} />
      </div>
      <div
        ref={ref}
        className="rich-body"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write something…"
        onInput={sync}
        onClick={(e) => { if ((e.target as HTMLElement).tagName === 'INPUT') setTimeout(sync, 0); }}
        onKeyDown={onKeyDown}
        onPaste={(e) => { const f = Array.from(e.clipboardData.files)[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f); } }}
        onDrop={(e) => { const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f); } }}
      />
    </>
  );
}

function SourceEditor({ value, onEmit, onToggle }: { value: string; onEmit: (md: string) => void; onToggle: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${Math.max(200, el.scrollHeight)}px`;
  }, [local]);
  const commit = (v: string) => { setLocal(v); onEmit(v); };
  return (
    <>
      <div className="toolbar">
        <span className="hint">Markdown source</span>
        <span className="panel-spacer" />
        <ToolbarButton label="Rich text" title="Back to rich text" onClick={onToggle} active />
      </div>
      <textarea ref={ref} className="md-source" value={local} placeholder="Write something…" onChange={(e) => commit(e.target.value)} spellCheck />
    </>
  );
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) =>
  esc(s)
    .replace(/!\[([^\]]*)\]\((data:image\/[^)]+|https?:[^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/** Small Markdown subset: headings, paragraphs, bullet/numbered lists, checkboxes, bold/italic/code, images. */
export function renderMarkdown(md: string, editable = false): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(?:\[([ x])\]\s+)?(.*)/);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (li) {
      const kind = li[2] ? 'ol' : 'ul';
      if (list !== kind) { close(); list = kind; out.push(`<${kind}>`); }
      const box = li[3] !== undefined ? `<input type="checkbox"${editable ? '' : ' disabled'}${li[3] === 'x' ? ' checked' : ''}> ` : '';
      out.push(`<li>${box}${inline(li[4])}</li>`);
    }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('') || (editable ? '<p><br></p>' : '');
}

function SendToAgent({ doc }: { doc: () => string }) {
  const [state, setState] = useState<'idle' | 'done'>('idle');
  const send = async () => {
    const md = doc();
    try { await navigator.clipboard.writeText(md); } catch { /* clipboard may be unavailable in the preview */ }
    setState('done');
    setTimeout(() => setState('idle'), 1800);
  };
  return (
    <div className="detail-foot">
      <button className="btn" onClick={send}>
        <SparkIcon /> {state === 'done' ? 'Copied as Markdown' : 'Send to Agent'}
      </button>
    </div>
  );
}

function SparkIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.7L19.5 9.5l-5.7 1.8L12 17l-1.8-5.7L4.5 9.5l5.7-1.8zM5 16l.9 2.6L8.5 19.5l-2.6.9L5 23l-.9-2.6L1.5 19.5l2.6-.9z" /></svg>;
}

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
function TrashIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;
}
