import { useEffect, useRef, useState } from 'react';
import type { Deadline, Person, Project, Status, Task } from './types';
import { PROJECT_COLORS, STATUS_LABEL, STATUS_ORDER, shortName } from './types';
import { StatusDot } from './WeekPlan';

export type Selection =
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'deadline'; id: string };

interface Props {
  selection: Selection;
  project?: Project;
  task?: Task;
  deadline?: Deadline;
  people: Person[];
  onClose: () => void;
  onUpdateProject: (id: string, patch: Partial<Project>) => void;
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  onUpdateDeadline: (id: string, patch: Partial<Deadline>) => void;
  onDelete: () => void;
}

export function DetailPanel(p: Props) {
  const { selection, project, task, deadline, people, onClose, onDelete } = p;
  const item = project ?? task ?? deadline;
  if (!item) return null;

  const title = project ? project.name : task ? task.title : deadline!.name;
  const setTitle = (v: string) => {
    if (project) p.onUpdateProject(project.id, { name: v });
    else if (task) p.onUpdateTask(task.id, { title: v });
    else if (deadline) p.onUpdateDeadline(deadline.id, { name: v });
  };
  const setNotes = (html: string) => {
    if (project) p.onUpdateProject(project.id, { notes: html });
    else if (task) p.onUpdateTask(task.id, { notes: html });
    else if (deadline) p.onUpdateDeadline(deadline.id, { notes: html });
  };

  const kindLabel = selection.kind === 'project' ? 'Project' : selection.kind === 'task' ? 'Task' : 'Deadline';

  return (
    <aside className="detail">
      <div className="detail-top">
        <span className="detail-kind">{kindLabel}</span>
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
              <Prop label="Starts"><input type="date" value={task.date} max={task.end}
                onChange={(e) => e.target.value && p.onUpdateTask(task.id, { date: e.target.value })} /></Prop>
              <Prop label="Ends"><input type="date" value={task.end ?? task.date} min={task.date}
                onChange={(e) => e.target.value && p.onUpdateTask(task.id, { end: e.target.value === task.date ? undefined : e.target.value })} /></Prop>
              <Prop label="Owner">
                <span className="prop-text">{shortName(people.find((x) => x.id === task.personId)?.name ?? '')}</span>
              </Prop>
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

function StatusSelect({ value, onChange }: { value: Status; onChange: (s: Status) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.status-select')) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
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
