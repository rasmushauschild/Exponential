import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Person, Task } from './types';
import { STATUS_LABEL, shortName } from './types';
import { Avatar, StatusDot, StatusMenu } from './WeekPlan';

/**
 * Notion-style notes: a column of blocks (heading, text, image, task). Enter makes a new block,
 * Backspace on an empty block removes it, blocks drag up and down. Task blocks are real tasks
 * (status, owner, claimable in projects); everything is stored as Markdown, with a task block
 * written as `- [ ] Title <!--task:id-->` so the task's id survives round-trips.
 * Dragging the cursor across block boundaries switches to Notion-style block selection:
 * the range highlights, Backspace deletes it, dragging any selected block moves the whole range.
 */

type Block =
  | { key: string; kind: 'h1' | 'h2' | 'p' | 'tog'; text: string; indent?: number }
  | { key: string; kind: 'img'; src: string; indent?: number }
  | { key: string; kind: 'task'; taskId: string; indent?: number };

const TASK_RE = /^(\s*)- \[( |x)\] ?(.*?)\s*<!--task:([0-9a-f-]{36})-->\s*$/i;
const MAX_IND = 4;
const indOf = (spaces: string) => Math.min(MAX_IND, Math.floor(spaces.length / 2));
const newKey = () => `b${crypto.randomUUID().slice(0, 8)}`;

export function parseBlocks(md: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let paraInd = 0;
  const flush = () => { if (para.length) { out.push({ key: newKey(), kind: 'p', text: para.join('\n'), indent: paraInd }); para = []; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const ind = indOf(line.match(/^ */)?.[0] ?? '');
    const body = line.replace(/^ +/, '');
    const task = line.match(TASK_RE);
    const img = body.match(/^!\[[^\]]*\]\((data:image\/[^)]+|https?:[^)]+)\)\s*$/);
    const tog = body.match(/^>>\s?(.*)$/);
    const h = body.match(/^(#{1,2})\s+(.*)$/);
    if (task) { flush(); out.push({ key: newKey(), kind: 'task', taskId: task[4], indent: indOf(task[1]) }); }
    else if (img) { flush(); out.push({ key: newKey(), kind: 'img', src: img[1], indent: ind }); }
    else if (tog) { flush(); out.push({ key: newKey(), kind: 'tog', text: tog[1], indent: ind }); }
    else if (h) { flush(); out.push({ key: newKey(), kind: h[1].length === 1 ? 'h1' : 'h2', text: h[2], indent: ind }); }
    else if (!body.trim()) flush();
    else {
      if (para.length && ind !== paraInd) flush();
      if (!para.length) paraInd = ind;
      para.push(body.replace(/^- \[( |x)\] /, '☐ ').replace(/^- /, '• '));
    }
  }
  flush();
  return out;
}

export function serializeBlocks(blocks: Block[], tasks: Task[]): string {
  return blocks.filter((b, i) => !(i === blocks.length - 1 && b.kind === 'p' && b.text === '')).map((b) => {
    const pre = '  '.repeat(b.indent ?? 0);
    if (b.kind === 'h1') return `${pre}# ${b.text}`;
    if (b.kind === 'h2') return `${pre}## ${b.text}`;
    if (b.kind === 'img') return `${pre}![](${b.src})`;
    if (b.kind === 'tog') return `${pre}>> ${b.text}`;
    if (b.kind === 'task') { const t = tasks.find((x) => x.id === b.taskId); return `${pre}- [${t?.status === 'done' ? 'x' : ' '}] ${t?.title ?? ''} <!--task:${b.taskId}-->`; }
    return b.text.split('\n').map((l) => pre + l).join('\n');
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
  onClaim: (id: string, personId?: string) => void;
  onUnclaim: (id: string) => void;
  onOpenTask: (id: string) => void;
}

type Caret = 'start' | 'end' | number;
type Focus = { index: number; caret: Caret } | null;
type Sel = { a: number; b: number } | null;

export function BlockEditor({ value, onChange, tasks, people, me, claimable, createTask, onUpdateTask, onDeleteTask, onClaim, onUnclaim, onOpenTask }: Props) {
  const [blocks, setBlocks] = useState<Block[]>(() => withOrphans(parseBlocks(value), tasks));
  const [focus, setFocus] = useState<Focus>(null);
  const [sel, setSel] = useState<Sel>(null);
  const lastEmitted = useRef(value);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const selRef = useRef(sel);
  selRef.current = sel;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  // Adopt outside changes (undo, another person) but never our own echo.
  useEffect(() => {
    if (value !== lastEmitted.current && pending.current === null) { lastEmitted.current = value; setBlocks(withOrphans(parseBlocks(value), tasks)); setSel(null); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tasks created elsewhere (e.g. in the week view) for this project get a block appended.
  useEffect(() => { setBlocks((b) => { const n = withOrphans(b, tasks); return n.length === b.length ? b : n; }); }, [tasks]);
  // Backspace on the final empty block must not remove it: removeAt keeps one via ensureTrailing.

  // Emit Markdown on a short pause rather than every keystroke; flush when the editor goes away.
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const flush = () => { window.clearTimeout(timer.current); if (pending.current !== null) { onChange(pending.current); pending.current = null; } };
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (raw: Block[]) => {
    const next = ensureTrailing(raw);
    setBlocks(next);
    const md = serializeBlocks(next, tasks);
    lastEmitted.current = md;
    pending.current = md;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 350);
  };
  const setBlock = (i: number, patch: Partial<Block>) => commit(blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)));
  const insertAt = (i: number, b: Block, caret: Caret = 'start') => { commit([...blocks.slice(0, i), b, ...blocks.slice(i)]); setFocus({ index: i, caret }); };
  const removeAt = (i: number, focusPrev = true) => {
    const b = blocks[i];
    commit(blocks.filter((_, j) => j !== i));
    if (b.kind === 'task') onDeleteTask(b.taskId);
    if (focusPrev && i > 0) setFocus({ index: i - 1, caret: 'end' });
  };

  /* ── toggles: children are the following deeper-indented blocks; closing hides them ── */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const hidden = (() => {
    const h = new Set<number>();
    let level: number | null = null;
    blocks.forEach((b, i) => {
      const ind = b.indent ?? 0;
      if (level !== null && ind > level) { h.add(i); return; }
      level = null;
      if (b.kind === 'tog' && closed.has(b.key)) level = ind;
    });
    return h;
  })();

  /* ── slash menu: '/' on an empty block offers the block kinds ── */
  const SLASH_OPTS: { label: string; kind: 'h1' | 'h2' | 'p' | 'tog' | 'task' }[] = [
    { label: 'Heading 1', kind: 'h1' },
    { label: 'Heading 2', kind: 'h2' },
    { label: 'Text', kind: 'p' },
    { label: 'Task', kind: 'task' },
    { label: 'Toggle', kind: 'tog' },
  ];
  const [slash, setSlash] = useState<{ i: number; rect: DOMRect } | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const [slashSel, setSlashSel] = useState(0);
  const slashSelRef = useRef(0);
  slashSelRef.current = slashSel;
  const slashOptions = () => {
    const sl = slashRef.current;
    if (!sl) return SLASH_OPTS;
    const b = blocksRef.current[sl.i];
    const q = b && 'text' in b ? b.text.slice(1).toLowerCase() : '';
    return SLASH_OPTS.filter((o) => o.label.toLowerCase().includes(q));
  };
  const applySlash = (kind: 'h1' | 'h2' | 'p' | 'tog' | 'task') => {
    const sl = slashRef.current;
    if (!sl) return;
    const i = sl.i;
    setSlash(null);
    const b = blocksRef.current[i];
    if (!b || b.kind === 'img') return;
    if (kind === 'task') {
      const id = createTask('');
      commit(blocksRef.current.map((x, j) => (j === i ? { key: newKey(), kind: 'task', taskId: id, indent: b.indent } as Block : x)));
      setFocus({ index: i, caret: 'end' });
    } else {
      commit(blocksRef.current.map((x, j) => (j === i ? { ...b, kind, text: '' } as Block : x)));
      setFocus({ index: i, caret: 'start' });
    }
  };
  // The menu follows the block's text: it closes when the '/' is gone or the block changed shape.
  useEffect(() => {
    if (!slash) return;
    const b = blocks[slash.i];
    if (!b || !('text' in b) || (b.text !== '' && !b.text.startsWith('/'))) { setSlash(null); return; }
    setSlashSel((v) => Math.min(v, Math.max(0, slashOptions().length - 1)));
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.slash-menu')) setSlash(null); };
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [slash, blocks]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── keyboard behaviour for text blocks ── */
  // ⌘A anywhere in the notes selects every block (not the current field's text).
  const selectAll = (e: React.KeyboardEvent) => {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
    setSel({ a: 0, b: blocksRef.current.length - 1 });
  };
  const onTextKey = (i: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const b = blocks[i] as Extract<Block, { kind: 'h1' | 'h2' | 'p' | 'tog' }>;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { selectAll(e); return; }
    // The slash menu owns the arrows and Enter while it is open on this block.
    if (slashRef.current?.i === i) {
      const opts = slashOptions();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((v) => Math.min(opts.length - 1, v + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((v) => Math.max(0, v - 1)); return; }
      if (e.key === 'Enter') { e.preventDefault(); const o = opts[Math.min(slashSelRef.current, opts.length - 1)]; if (o) applySlash(o.kind); else setSlash(null); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
    }
    if (e.key === '/' && el.value === '') {
      const r = el.getBoundingClientRect();
      setSlash({ i, rect: r });
      setSlashSel(0);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      setBlock(i, { indent: Math.max(0, Math.min(MAX_IND, (b.indent ?? 0) + (e.shiftKey ? -1 : 1))) });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const head = el.value.slice(0, el.selectionStart), tail = el.value.slice(el.selectionEnd);
      const next = blocks.map((x, j) => (j === i ? { ...b, text: head } : x));
      // Enter on a toggle drops into it: the new line is a child, one level deeper.
      next.splice(i + 1, 0, { key: newKey(), kind: 'p', text: tail, indent: Math.min(MAX_IND, (b.indent ?? 0) + (b.kind === 'tog' ? 1 : 0)) });
      commit(next);
      if (b.kind === 'tog') setClosed((c) => { const n = new Set(c); n.delete(b.key); return n; });
      setFocus({ index: i + 1, caret: 'start' });
    } else if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (b.text === '' && blocks.length > 1) { e.preventDefault(); removeAt(i); }
      else if (i > 0 && blocks[i - 1].kind !== 'task' && blocks[i - 1].kind !== 'img') {
        e.preventDefault();
        const prev = blocks[i - 1] as Extract<Block, { kind: 'h1' | 'h2' | 'p' | 'tog' }>;
        const merged = blocks.filter((_, j) => j !== i).map((x, j) => (j === i - 1 ? { ...prev, text: prev.text + b.text } : x));
        commit(merged);
        setFocus({ index: i - 1, caret: prev.text.length });
      }
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && i > 0) { e.preventDefault(); setFocus({ index: i - 1, caret: 'end' }); }
    else if (e.key === 'ArrowDown' && el.selectionStart === el.value.length && i < blocks.length - 1) { e.preventDefault(); setFocus({ index: i + 1, caret: 'end' }); }
  };

  const onTaskKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>, task: Task | undefined) => {
    const el = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { selectAll(e); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      setBlock(i, { indent: Math.max(0, Math.min(MAX_IND, (blocks[i].indent ?? 0) + (e.shiftKey ? -1 : 1))) });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (el.value === '') {
        // Enter on an empty task turns it back into plain text instead of chaining another task.
        const b = blocks[i] as Extract<Block, { kind: 'task' }>;
        commit(blocks.map((x, j) => (j === i ? { key: newKey(), kind: 'p', text: '', indent: blocks[i].indent } as Block : x)));
        onDeleteTask(b.taskId);
        setFocus({ index: i, caret: 'start' });
      } else {
        const id = createTask('');
        insertAt(i + 1, { key: newKey(), kind: 'task', taskId: id, indent: blocks[i].indent });
      }
    } else if (e.key === 'Backspace' && el.value === '' ) { e.preventDefault(); removeAt(i); }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); setFocus({ index: i - 1, caret: 'end' }); }
    else if (e.key === 'ArrowDown' && i < blocks.length - 1) { e.preventDefault(); setFocus({ index: i + 1, caret: 'end' }); }
    else if (e.key === 'Escape' && task && !task.title) removeAt(i);
  };

  /* ── toolbar actions on the focused block ── */
  const activeRef = useRef(0);
  const setActive = (i: number) => { activeRef.current = i; };
  const turnInto = (kind: 'h1' | 'h2' | 'p' | 'tog' | 'task') => {
    // With a block selection, the whole selection converts (images stay images).
    const s = selRef.current;
    if (s) {
      const lo = Math.min(s.a, s.b), hi = Math.max(s.a, s.b);
      const next = [...blocksRef.current];
      for (let i = lo; i <= hi; i++) {
        const b = next[i];
        if (b.kind === 'img' || b.kind === kind) continue;
        if (kind === 'task') {
          if (b.kind === 'task') continue;
          const id = createTask(b.text);
          next[i] = { key: newKey(), kind: 'task', taskId: id, indent: b.indent };
        } else if (b.kind === 'task') {
          const t = tasks.find((x) => x.id === b.taskId);
          next[i] = { key: newKey(), kind, text: t?.title ?? '', indent: b.indent };
          onDeleteTask(b.taskId);
        } else {
          next[i] = { ...b, kind };
        }
      }
      commit(next);
      return;
    }
    const active = activeRef.current;
    const b = blocks[active];
    if (!b) { if (kind === 'task') { const id = createTask(''); insertAt(blocks.length, { key: newKey(), kind: 'task', taskId: id }); } else insertAt(blocks.length, { key: newKey(), kind, text: '' }); return; }
    if (kind === 'task') {
      if (b.kind === 'task') return;
      const id = createTask(b.kind === 'img' ? '' : b.text);
      commit(blocks.map((x, j) => (j === active ? { key: newKey(), kind: 'task', taskId: id, indent: b.indent } as Block : x)));
      setFocus({ index: active, caret: 'end' });
      return;
    }
    if (b.kind === 'task') { const t = tasks.find((x) => x.id === b.taskId); commit(blocks.map((x, j) => (j === active ? { key: newKey(), kind, text: t?.title ?? '', indent: b.indent } as Block : x))); onDeleteTask(b.taskId); setFocus({ index: active, caret: 'end' }); return; }
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

  /* ── drag to reorder (a single block from its handle, or the whole selection) ── */
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; count: number; ins: number; dy: number; h: number } | null>(null);
  const startDrag = (from: number, count: number, startY: number, clickIndex?: number) => {
    const rows = Array.from(listRef.current!.querySelectorAll<HTMLElement>('.blk'));
    const rects = rows.map((r) => r.getBoundingClientRect());
    const h = rects.slice(from, from + count).reduce((s, r) => s + r.height, 0) + 4 * count;
    // Everything is computed against the list without the dragged group: `ins` is where it lands.
    const others = rects.map((r, j) => ({ r, j })).filter(({ j }) => j < from || j >= from + count);
    const insAt = (y: number) => { let ins = 0; others.forEach(({ r }, k) => { if (y > r.top + r.height / 2) ins = k + 1; }); return ins; };
    const homeIns = others.filter(({ j }) => j < from).length;
    const mid0 = (rects[from].top + rects[from + count - 1].bottom) / 2;
    let latest = { from, count, ins: homeIns, dy: 0, h };
    let moved = false;
    setDrag(latest);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 3) moved = true;
      latest = { from, count, ins: insAt(mid0 + dy), dy, h };
      setDrag(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!moved) {
        // A plain click on a selected block: deselect and start editing it.
        if (clickIndex !== undefined) { setSel(null); setFocus({ index: clickIndex, caret: 'end' }); }
        return;
      }
      if (latest.ins !== homeIns) {
        const bs = blocksRef.current;
        const group = bs.slice(from, from + count);
        const rest = [...bs.slice(0, from), ...bs.slice(from + count)];
        commit([...rest.slice(0, latest.ins), ...group, ...rest.slice(latest.ins)]);
        if (count > 1) setSel({ a: latest.ins, b: latest.ins + count - 1 });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onHandleDown = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const s = selRef.current;
    const lo = s ? Math.min(s.a, s.b) : -1, hi = s ? Math.max(s.a, s.b) : -1;
    if (s && i >= lo && i <= hi) startDrag(lo, hi - lo + 1, e.clientY);
    else { setSel(null); startDrag(i, 1, e.clientY); }
  };
  const shift = (j: number) => {
    if (!drag) return 0;
    const { from, count, ins, dy, h } = drag;
    if (j >= from && j < from + count) return dy;
    const k = j < from ? j : j - count; // this row's slot once the group is lifted out
    if (j < from && ins <= k) return h;
    if (j >= from + count && ins > k) return -h;
    return 0;
  };

  /* ── block selection: drag across block boundaries to select a range ── */
  const onRowPointerDown = (i: number, e: React.PointerEvent) => {
    setActive(i);
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.blk-handle, .status-btn, .claim, .owner-chip, .blk-x, .blk-link, .status-menu')) return;
    const s = selRef.current;
    if (s) {
      const lo = Math.min(s.a, s.b), hi = Math.max(s.a, s.b);
      if (i >= lo && i <= hi) { e.preventDefault(); startDrag(lo, hi - lo + 1, e.clientY, i); return; }
      setSel(null);
    }
    // Watch for the pointer crossing into another block; until then, native text selection runs.
    const rects = Array.from(listRef.current!.querySelectorAll<HTMLElement>('.blk')).map((r) => r.getBoundingClientRect());
    let started = false;
    const move = (ev: PointerEvent) => {
      let over = 0;
      rects.forEach((r, j) => { if (ev.clientY > r.top - 2) over = j; });
      if (!started && over !== i) {
        started = true;
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
      }
      if (started) setSel({ a: i, b: over });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // While a selection exists: Backspace deletes it, ⌘C/⌘X copy it as portable
  // Markdown (task blocks become plain checkboxes so a paste elsewhere makes fresh
  // tasks), Escape or clicking elsewhere clears it.
  useEffect(() => {
    if (!sel) return;
    const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
    const removeSel = () => {
      const bs = blocksRef.current;
      for (const b of bs.slice(lo, hi + 1)) if (b.kind === 'task') onDeleteTask(b.taskId);
      commit(bs.filter((_, j) => j < lo || j > hi));
      setSel(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        removeSel();
      } else if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
        e.preventDefault();
        const md = blocksRef.current.slice(lo, hi + 1).map((b) => {
          if (b.kind === 'task') { const t = tasksRef.current.find((x) => x.id === b.taskId); return `- [${t?.status === 'done' ? 'x' : ' '}] ${t?.title ?? ''}`; }
          if (b.kind === 'img') return `![](${b.src})`;
          if (b.kind === 'h1') return `# ${b.text}`;
          if (b.kind === 'h2') return `## ${b.text}`;
          return b.text;
        }).join('\n\n');
        navigator.clipboard.writeText(md);
        if (e.key.toLowerCase() === 'x') removeSel();
      } else if (e.key === 'Escape') setSel(null);
    };
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.blk-list, .toolbar')) setSel(null); };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', down); };
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const selLo = sel ? Math.min(sel.a, sel.b) : -1;
  const selHi = sel ? Math.max(sel.a, sel.b) : -1;
  const docEmpty = blocks.length === 1 && blocks[0].kind === 'p' && blocks[0].text === '';

  return (
    <div className="blocks">
      <div className="toolbar">
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('h1')} title="Heading 1">H1</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('h2')} title="Heading 2">H2</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('p')} title="Text">Text</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('task')} title="Task block">Task</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => turnInto('tog')} title="Toggle block">Toggle</button>
      </div>
      <div
        ref={listRef}
        className={`blk-list${sel ? ' selecting' : ''}`}
        onDrop={(e) => { const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f, blocks.length); } }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onPaste={(e) => {
          const f = Array.from(e.clipboardData.files)[0];
          if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f, activeRef.current + 1); return; }
          // Block-shaped text (headings, checkboxes, images) pastes as blocks; checkbox
          // lines become fresh real tasks. Plain prose still pastes natively.
          const text = e.clipboardData.getData('text/plain');
          if (!text || !/(^|\n)(#{1,2} |!\[|- \[( |x)\])/i.test(text)) return;
          e.preventDefault();
          const built: Block[] = [];
          for (const line of text.replace(/\r/g, '').split('\n')) {
            const m = line.match(/^- \[( |x)\] ?(.*?)(\s*<!--task:[0-9a-f-]{36}-->)?\s*$/i);
            if (m && m[2].trim()) {
              const id = createTask(m[2].trim());
              if (m[1].toLowerCase() === 'x') onUpdateTask(id, { status: 'done' });
              built.push({ key: newKey(), kind: 'task', taskId: id });
            } else built.push(...parseBlocks(line));
          }
          if (!built.length) return;
          const s = selRef.current;
          const at = s ? Math.max(s.a, s.b) + 1 : Math.min(activeRef.current + 1, blocksRef.current.length);
          commit([...blocksRef.current.slice(0, at), ...built, ...blocksRef.current.slice(at)]);
          setSel(null);
        }}
      >
        {blocks.map((b, i) => (
          <div
            key={b.key}
            className={`blk blk-${b.kind}${drag && i >= drag.from && i < drag.from + drag.count ? ' dragging' : ''}${drag && (i < drag.from || i >= drag.from + drag.count) ? ' shifting' : ''}${i >= selLo && i <= selHi ? ' selected' : ''}`}
            style={{
              ...(shift(i) ? { transform: `translateY(${shift(i)}px)` } : null),
              ...(b.indent ? { marginLeft: `calc(${b.indent * 24}px - 26px)` } : null),
              ...(hidden.has(i) ? { display: 'none' } : null),
            }}
            onFocus={() => setActive(i)}
            onPointerDownCapture={(e) => onRowPointerDown(i, e)}
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
                onClaim={(pid) => onClaim(b.taskId, pid)}
                onUnclaim={() => onUnclaim(b.taskId)}
                onOpen={() => onOpenTask(b.taskId)}
              />
            ) : b.kind === 'img' ? (
              <img src={b.src} alt="" className="blk-img" onClick={() => setActive(i)} />
            ) : b.kind === 'tog' ? (
              <div className="tog-blk">
                <button
                  className="tog-arrow"
                  title={closed.has(b.key) ? 'Expand' : 'Collapse'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(b.key)) n.delete(b.key); else n.add(b.key); return n; })}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: closed.has(b.key) ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }}>
                    <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <TextBlock
                  block={b}
                  placeholder="Toggle"
                  focus={focus?.index === i ? focus : null}
                  onFocused={() => setFocus(null)}
                  onChange={(text) => setBlock(i, { text })}
                  onKey={(e) => onTextKey(i, e)}
                />
              </div>
            ) : (
              <TextBlock
                block={b}
                placeholder={b.kind !== 'p' ? 'Heading' : docEmpty ? 'Write something…' : ''}
                focus={focus?.index === i ? focus : null}
                onFocused={() => setFocus(null)}
                onChange={(text) => setBlock(i, { text })}
                onKey={(e) => onTextKey(i, e)}
              />
            )}
            {b.kind === 'img' && <button className="blk-x" title="Remove image" onClick={() => removeAt(i)}>×</button>}
          </div>
        ))}
        {slash && createPortal(
          <div className="status-menu slash-menu" style={{ position: 'fixed', left: slash.rect.left, top: slash.rect.bottom + 6 }}>
            {slashOptions().map((o, k) => (
              <button key={o.kind} className={k === Math.min(slashSel, slashOptions().length - 1) ? 'current' : ''}
                onMouseDown={(e) => e.preventDefault()} onClick={() => applySlash(o.kind)}>{o.label}</button>
            ))}
            {slashOptions().length === 0 && <div className="hint" style={{ padding: '6px 10px' }}>No match</div>}
          </div>, document.body)}
      </div>
    </div>
  );
}

/** Tasks that exist for this project but aren't in the notes yet get a block at the end; the list always ends with an empty text block. */
function withOrphans(blocks: Block[], tasks: Task[]): Block[] {
  const present = new Set(blocks.filter((b): b is Extract<Block, { kind: 'task' }> => b.kind === 'task').map((b) => b.taskId));
  const missing = tasks.filter((t) => !present.has(t.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // drop task blocks whose task is gone
  const kept = blocks.filter((b) => b.kind !== 'task' || tasks.some((t) => t.id === b.taskId));
  const withTasks = missing.length ? [...kept, ...missing.map((t) => ({ key: newKey(), kind: 'task' as const, taskId: t.id }))] : kept;
  return ensureTrailing(withTasks);
}

function ensureTrailing(blocks: Block[]): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === 'p' && last.text === '') return blocks;
  return [...blocks, { key: newKey(), kind: 'p', text: '' }];
}

/* ── links inside text blocks ── */
const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;

/** Split text into plain runs and links; null when there is no link at all. */
function linkify(text: string): (string | { url: string; label: string })[] | null {
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(text)) return null;
  URL_RE.lastIndex = 0; // test() advanced it; matchAll starts from lastIndex
  const parts: (string | { url: string; label: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let label = m[0];
    const trail = label.match(/[),.;:!?\]]+$/)?.[0] ?? ''; // sentence punctuation isn't part of the URL
    label = label.slice(0, label.length - trail.length);
    if (!label) continue;
    parts.push(text.slice(last, m.index));
    parts.push({ url: label.startsWith('www.') ? `https://${label}` : label, label });
    last = (m.index ?? 0) + label.length;
  }
  parts.push(text.slice(last));
  return parts;
}

function TextBlock({ block, placeholder, focus, onFocused, onChange, onKey }: {
  block: Extract<Block, { kind: 'h1' | 'h2' | 'p' | 'tog' }>; placeholder: string; focus: Focus; onFocused: () => void;
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
  // With links present the textarea's own text goes transparent and a mirror layer renders it,
  // links styled and clickable; the two must share exact metrics so glyphs line up.
  const links = linkify(block.text);
  return (
    <div className="blk-textwrap">
      <textarea
        ref={ref}
        className={`blk-text ${block.kind}${links ? ' has-links' : ''}`}
        rows={1}
        value={block.text}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        spellCheck
      />
      {links && (
        <div className={`blk-linklayer ${block.kind}`}>
          {links.map((p, k) => typeof p === 'string'
            ? <span key={k}>{p}</span>
            : <a key={k} className="blk-link" href={p.url} title={p.url} onClick={(e) => { e.preventDefault(); window.open(p.url); }}>{p.label}</a>)}
          {'\n'}
        </div>
      )}
    </div>
  );
}

function TaskBlock({ task, people, me, claimable, focus, onFocused, onKey, onTitle, onUpdate, onDelete, onClaim, onUnclaim, onOpen }: {
  task: Task | undefined; people: Person[]; me: string; claimable: boolean; focus: Focus; onFocused: () => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>, t: Task | undefined) => void;
  onTitle: (title: string) => void; onUpdate: (patch: Partial<Task>) => void; onDelete: () => void; onClaim: (personId: string) => void; onUnclaim: () => void; onOpen: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [claimMenu, setClaimMenu] = useState<DOMRect | null>(null);
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
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  if (!task) return <div className="blk-text p hint">(task removed)</div>;
  const owner = task.personId ? people.find((p) => p.id === task.personId) : undefined;
  const change = (v: string) => { setTitle(v); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => onTitle(v), 400); };
  return (
    <div className={`task-blk wk-row task ${task.status}${owner ? '' : ' unassigned'}`}>
      <button className="status-btn" title={STATUS_LABEL[task.status]}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu((m) => (m ? null : r)); }}>
        <StatusDot status={task.status} />
      </button>
      <input ref={ref} className="task-blk-title" value={title} placeholder="Task" onChange={(e) => change(e.target.value)} onKeyDown={(e) => onKey(e, task)} onBlur={() => { window.clearTimeout(timer.current); if (title !== task.title) onTitle(title); }} />
      {owner ? (
        <span className="from-chip owner-chip">
          <button className="owner-open" title={`${owner.name} · ${STATUS_LABEL[task.status]} — open`} onClick={onOpen}>
            <Avatar person={owner} size={14} /> {owner.id === me ? 'you' : shortName(owner.name).split(' ')[0]}
          </button>
          {claimable && (
            <button className="owner-x" title={owner.id === me ? 'Take me off this task' : `Remove ${shortName(owner.name)} from this task`}
              onClick={(e) => { e.stopPropagation(); onUnclaim(); }}>×</button>
          )}
        </span>
      ) : claimable ? (
        <button className="pill small claim"
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setClaimMenu((m) => (m ? null : r)); }}>+ Add to week</button>
      ) : null}
      {claimMenu && (
        <PersonMenu anchor={claimMenu} people={people} me={me}
          onPick={(pid) => { setClaimMenu(null); onClaim(pid); }}
          onClose={() => setClaimMenu(null)} />
      )}
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

/** Pick whose week a project task goes to (Me first, then alphabetical). */
function PersonMenu({ anchor, people, me, onPick, onClose }: {
  anchor: DOMRect; people: Person[]; me: string; onPick: (personId: string) => void; onClose: () => void;
}) {
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.status-menu')) onClose(); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ordered = [...people.filter((p) => p.id === me), ...people.filter((p) => p.id !== me).sort((a, b) => a.name.localeCompare(b.name))];
  const menuH = ordered.length * 36 + 12;
  const up = anchor.bottom + menuH > window.innerHeight - 8;
  const style: React.CSSProperties = { position: 'fixed', left: Math.min(anchor.left, window.innerWidth - 200), ...(up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }) };
  return createPortal(
    <div className="status-menu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {ordered.map((p) => (
        <button key={p.id} onClick={() => onPick(p.id)}>
          <Avatar person={p} size={16} /> {p.id === me ? 'Me' : shortName(p.name)}
        </button>
      ))}
    </div>,
    document.body,
  );
}
