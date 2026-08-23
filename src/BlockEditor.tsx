import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Person, Task } from './types';
import { STATUS_LABEL, shortName } from './types';
import { Avatar, StatusDot, StatusMenu } from './WeekPlan';

/**
 * Notion-style notes: a column of blocks (heading, text, image, task). Enter makes a new block,
 * Backspace on an empty block removes it, blocks drag up and down. Task blocks are real tasks
 * (status, owner, claimable in projects); everything is stored as Markdown, with a task block
 * written as `- [ ] Title <!--task:id-->` so the task's id survives round-trips.
 */

type Block =
  | { key: string; kind: 'h1' | 'h2' | 'p'; text: string }
  | { key: string; kind: 'img'; src: string }
  | { key: string; kind: 'task'; taskId: string };

const TASK_RE = /^- \[( |x)\] ?(.*?)\s*<!--task:([0-9a-f-]{36})-->\s*$/i;
let keyCounter = 0;
const newKey = () => `b${++keyCounter}`;

export function parseBlocks(md: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ key: newKey(), kind: 'p', text: para.join('\n') }); para = []; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const task = line.match(TASK_RE);
    const img = line.match(/^!\[[^\]]*\]\((data:image\/[^)]+|https?:[^)]+)\)\s*$/);
    const h = line.match(/^(#{1,2})\s+(.*)$/);
    if (task) { flush(); out.push({ key: newKey(), kind: 'task', taskId: task[3] }); }
    else if (img) { flush(); out.push({ key: newKey(), kind: 'img', src: img[1] }); }
    else if (h) { flush(); out.push({ key: newKey(), kind: h[1].length === 1 ? 'h1' : 'h2', text: h[2] }); }
    else if (!line.trim()) flush();
    else para.push(line.replace(/^- \[( |x)\] /, '☐ ').replace(/^- /, '• '));
  }
  flush();
  return out;
}

export function serializeBlocks(blocks: Block[], tasks: Task[]): string {
  return blocks.map((b) => {
    if (b.kind === 'h1') return `# ${b.text}`;
    if (b.kind === 'h2') return `## ${b.text}`;
    if (b.kind === 'img') return `![](${b.src})`;
    if (b.kind === 'task') { const t = tasks.find((x) => x.id === b.taskId); return `- [${t?.status === 'done' ? 'x' : ' '}] ${t?.title ?? ''} <!--task:${b.taskId}-->`; }
    return b.text;
  }).join('\n\n');
}

interface Props {
  value: string;
  onChange: (md: string) => void;
  tasks: Task[]; // tasks linked to this project / parent task
  people: Person[];
  me: string;
  claimable: boolean; // projects: yes; subtasks: no
  createTask: (title: string) => string; // returns the new id
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onClaim: (id: string) => void;
  onOpenTask: (id: string) => void;
}

type Caret = 'start' | 'end' | number;
type Focus = { index: number; caret: Caret } | null;

export function BlockEditor({ value, onChange, tasks, people, me, claimable, createTask, onUpdateTask, onDeleteTask, onClaim, onOpenTask }: Props) {
  const [blocks, setBlocks] = useState<Block[]>(() => withOrphans(parseBlocks(value), tasks));
  const [focus, setFocus] = useState<Focus>(null);
  const lastEmitted = useRef(value);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Adopt outside changes (undo, another person) but never our own echo.
  useEffect(() => {
    if (value !== lastEmitted.current) { lastEmitted.current = value; setBlocks(withOrphans(parseBlocks(value), tasks)); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tasks created elsewhere (e.g. in the week view) for this project get a block appended.
  useEffect(() => { setBlocks((b) => { const n = withOrphans(b, tasks); return n.length === b.length ? b : n; }); }, [tasks]);

  const commit = (next: Block[]) => {
    setBlocks(next);
    const md = serializeBlocks(next, tasks);
    lastEmitted.current = md;
    onChange(md);
  };
  const setBlock = (i: number, patch: Partial<Block>) => commit(blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)));
  const insertAt = (i: number, b: Block, caret: Caret = 'start') => { commit([...blocks.slice(0, i), b, ...blocks.slice(i)]); setFocus({ index: i, caret }); };
  const removeAt = (i: number, focusPrev = true) => {
    const b = blocks[i];
    commit(blocks.filter((_, j) => j !== i));
    if (b.kind === 'task') onDeleteTask(b.taskId);
    if (focusPrev && i > 0) setFocus({ index: i - 1, caret: 'end' });
  };

  /* ── keyboard behaviour for text blocks ── */
  const onTextKey = (i: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const b = blocks[i] as Extract<Block, { kind: 'h1' | 'h2' | 'p' }>;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const head = el.value.slice(0, el.selectionStart), tail = el.value.slice(el.selectionEnd);
      const next = blocks.map((x, j) => (j === i ? { ...b, text: head } : x));
      next.splice(i + 1, 0, { key: newKey(), kind: 'p', text: tail });
      commit(next);
      setFocus({ index: i + 1, caret: 'start' });
    } else if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (b.text === '' && blocks.length > 1) { e.preventDefault(); removeAt(i); }
      else if (i > 0 && blocks[i - 1].kind !== 'task' && blocks[i - 1].kind !== 'img') {
        e.preventDefault();
        const prev = blocks[i - 1] as Extract<Block, { kind: 'h1' | 'h2' | 'p' }>;
        const merged = blocks.filter((_, j) => j !== i).map((x, j) => (j === i - 1 ? { ...prev, text: prev.text + b.text } : x));
        commit(merged);
        setFocus({ index: i - 1, caret: prev.text.length });
      }
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && i > 0) { e.preventDefault(); setFocus({ index: i - 1, caret: 'end' }); }
    else if (e.key === 'ArrowDown' && el.selectionStart === el.value.length && i < blocks.length - 1) { e.preventDefault(); setFocus({ index: i + 1, caret: 'end' }); }
  };

  const onTaskKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>, task: Task | undefined) => {
    const el = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      const id = createTask('');
      insertAt(i + 1, { key: newKey(), kind: 'task', taskId: id });
    } else if (e.key === 'Backspace' && el.value === '' ) { e.preventDefault(); removeAt(i); }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); setFocus({ index: i - 1, caret: 'end' }); }
    else if (e.key === 'ArrowDown' && i < blocks.length - 1) { e.preventDefault(); setFocus({ index: i + 1, caret: 'end' }); }
    else if (e.key === 'Escape' && task && !task.title) removeAt(i);
  };

  /* ── toolbar actions on the focused block ── */
  const activeRef = useRef(0);
  const setActive = (i: number) => { activeRef.current = i; };
  const turnInto = (kind: 'h1' | 'h2' | 'p' | 'task') => {
    const active = activeRef.current;
    const b = blocks[active];
    if (!b) { if (kind === 'task') { const id = createTask(''); insertAt(blocks.length, { key: newKey(), kind: 'task', taskId: id }); } else insertAt(blocks.length, { key: newKey(), kind, text: '' }); return; }
    if (kind === 'task') {
      if (b.kind === 'task') return;
      const id = createTask(b.kind === 'img' ? '' : b.text);
      commit(blocks.map((x, j) => (j === active ? { key: newKey(), kind: 'task', taskId: id } as Block : x)));
      setFocus({ index: active, caret: 'end' });
      return;
    }
    if (b.kind === 'task') { const t = tasks.find((x) => x.id === b.taskId); commit(blocks.map((x, j) => (j === active ? { key: newKey(), kind, text: t?.title ?? '' } as Block : x))); onDeleteTask(b.taskId); setFocus({ index: active, caret: 'end' }); return; }
    if (b.kind === 'img') return;
    setBlock(active, { kind });
    setFocus({ index: active, caret: 'end' });
  };

  /* ── images ── */
  const insertImage = (file: File, at: number) => {
    const reader = new FileReader();
    reader.onload = () => insertAt(at, { key: newKey(), kind: 'img', src: String(reader.result) }, 'end');
    reader.readAsDataURL(file);
  };

  /* ── drag to reorder ── */
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number; h: number } | null>(null);
  const onHandleDown = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const rows = Array.from(listRef.current!.querySelectorAll<HTMLElement>('.blk'));
    const rects = rows.map((r) => r.getBoundingClientRect());
    const h = rects[i].height + 4;
    const startY = e.clientY;
    let latest = { from: i, to: i, dy: 0, h };
    setDrag(latest);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const y = rects[i].top + rects[i].height / 2 + dy;
      let to = 0;
      rects.forEach((r, j) => { if (j !== i && y > r.top + r.height / 2) to = j < i ? j + 1 : j; });
      if (dy < 0) { to = 0; rects.forEach((r, j) => { if (j < i && y > r.top + r.height / 2) to = j + 1; }); if (to > i) to = i; }
      else { to = i; rects.forEach((r, j) => { if (j > i && y > r.top + r.height / 2) to = j; }); }
      latest = { from: i, to, dy, h };
      setDrag(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (latest.to !== latest.from) {
        const next = [...blocks];
        const [b] = next.splice(latest.from, 1);
        next.splice(latest.to, 0, b);
        commit(next);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const shift = (j: number) => {
    if (!drag) return 0;
    if (j === drag.from) return drag.dy;
    if (drag.to > drag.from && j > drag.from && j <= drag.to) return -drag.h;
    if (drag.to < drag.from && j >= drag.to && j < drag.from) return drag.h;
    return 0;
  };

  return (
    <div className="blocks">
      <div className="toolbar">
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('h1')} title="Heading 1">H1</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('h2')} title="Heading 2">H2</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('p')} title="Text">Text</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('task')} title="Task block">Task</button>
      </div>
      <div
        ref={listRef}
        className="blk-list"
        onDrop={(e) => { const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f, blocks.length); } }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onPaste={(e) => { const f = Array.from(e.clipboardData.files)[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f, activeRef.current + 1); } }}
      >
        {blocks.map((b, i) => (
          <div
            key={b.key}
            className={`blk blk-${b.kind}${drag?.from === i ? ' dragging' : ''}${drag && drag.from !== i ? ' shifting' : ''}`}
            style={shift(i) ? { transform: `translateY(${shift(i)}px)` } : undefined}
            onFocus={() => setActive(i)}
            onPointerDownCapture={() => setActive(i)}
            onKeyDownCapture={() => setActive(i)}
          >
            <button className="blk-handle" title="Drag to move" onPointerDown={(e) => onHandleDown(i, e)}>⋮⋮</button>
            {b.kind === 'task' ? (
              <TaskBlock
                task={tasks.find((t) => t.id === b.taskId)}
                people={people}
                me={me}
                claimable={claimable}
                focus={focus?.index === i ? focus : null}
                onFocused={() => setFocus(null)}
                onKey={(e, t) => onTaskKey(i, e, t)}
                onTitle={(title) => onUpdateTask(b.taskId, { title })}
                onUpdate={(patch) => onUpdateTask(b.taskId, patch)}
                onDelete={() => removeAt(i, false)}
                onClaim={() => onClaim(b.taskId)}
                onOpen={() => onOpenTask(b.taskId)}
              />
            ) : b.kind === 'img' ? (
              <img src={b.src} alt="" className="blk-img" onClick={() => setActive(i)} />
            ) : (
              <TextBlock
                block={b}
                focus={focus?.index === i ? focus : null}
                onFocused={() => setFocus(null)}
                onChange={(text) => setBlock(i, { text })}
                onKey={(e) => onTextKey(i, e)}
              />
            )}
            {b.kind === 'img' && <button className="blk-x" title="Remove image" onClick={() => removeAt(i)}>×</button>}
          </div>
        ))}
        {blocks.length === 0 && (
          <button className="add-task list-add" onClick={() => insertAt(0, { key: newKey(), kind: 'p', text: '' })}><span className="plus">+</span> Write something</button>
        )}
      </div>
    </div>
  );
}

/** Tasks that exist for this project but aren't in the notes yet get a block at the end. */
function withOrphans(blocks: Block[], tasks: Task[]): Block[] {
  const present = new Set(blocks.filter((b): b is Extract<Block, { kind: 'task' }> => b.kind === 'task').map((b) => b.taskId));
  const missing = tasks.filter((t) => !present.has(t.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // drop task blocks whose task is gone
  const kept = blocks.filter((b) => b.kind !== 'task' || tasks.some((t) => t.id === b.taskId));
  return missing.length ? [...kept, ...missing.map((t) => ({ key: newKey(), kind: 'task' as const, taskId: t.id }))] : kept;
}

function TextBlock({ block, focus, onFocused, onChange, onKey }: {
  block: Extract<Block, { kind: 'h1' | 'h2' | 'p' }>; focus: Focus; onFocused: () => void;
  onChange: (text: string) => void; onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const el = ref.current; if (el) { el.style.height = '0'; el.style.height = `${el.scrollHeight}px`; } }, [block.text, block.kind]);
  useEffect(() => {
    if (!focus || !ref.current) return;
    const el = ref.current;
    el.focus();
    const pos = focus.caret === 'start' ? 0 : focus.caret === 'end' ? el.value.length : focus.caret;
    el.setSelectionRange(pos, pos);
    onFocused();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea
      ref={ref}
      className={`blk-text ${block.kind}`}
      rows={1}
      value={block.text}
      placeholder={block.kind === 'p' ? 'Write something…' : 'Heading'}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKey}
      spellCheck
    />
  );
}

function TaskBlock({ task, people, me, claimable, focus, onFocused, onKey, onTitle, onUpdate, onDelete, onClaim, onOpen }: {
  task: Task | undefined; people: Person[]; me: string; claimable: boolean; focus: Focus; onFocused: () => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>, t: Task | undefined) => void;
  onTitle: (title: string) => void; onUpdate: (patch: Partial<Task>) => void; onDelete: () => void; onClaim: () => void; onOpen: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [title, setTitle] = useState(task?.title ?? '');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (task && task.title !== title && document.activeElement !== ref.current) setTitle(task.title); }, [task?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focus || !ref.current) return;
    ref.current.focus();
    const pos = focus.caret === 'start' ? 0 : ref.current.value.length;
    ref.current.setSelectionRange(pos, pos);
    onFocused();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.status-menu')) setMenu(null); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);
  if (!task) return <div className="blk-text p hint">(task removed)</div>;
  const owner = task.personId ? people.find((p) => p.id === task.personId) : undefined;
  const change = (v: string) => { setTitle(v); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => onTitle(v), 400); };
  return (
    <div className={`blk-task wk-row task ${task.status}${owner ? '' : ' unassigned'}`}>
      <button className="status-btn" title={STATUS_LABEL[task.status]}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu((m) => (m ? null : r)); }}>
        <StatusDot status={task.status} />
      </button>
      <input ref={ref} className="blk-task-title" value={title} placeholder="Task" onChange={(e) => change(e.target.value)} onKeyDown={(e) => onKey(e, task)} onBlur={() => { window.clearTimeout(timer.current); if (title !== task.title) onTitle(title); }} />
      {owner ? (
        <button className="from-chip" title={`${owner.name} · ${STATUS_LABEL[task.status]} — open`} onClick={onOpen}>
          <Avatar person={owner} size={14} /> {owner.id === me ? 'you' : shortName(owner.name).split(' ')[0]}
        </button>
      ) : claimable ? (
        <button className="pill small claim" onClick={onClaim}>+ Add to my week</button>
      ) : null}
      {menu && (
        <StatusMenu
          value={task.status}
          reviewerId={task.reviewerId}
          people={people.filter((x) => x.id !== task.personId)}
          onPick={(status, reviewerId) => { onUpdate(reviewerId !== undefined ? { status, reviewerId } : { status }); setMenu(null); }}
          onDelete={() => { setMenu(null); onDelete(); }}
          anchor={menu}
        />
      )}
    </div>
  );
}
