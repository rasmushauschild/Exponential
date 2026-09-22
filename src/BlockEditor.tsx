import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Person, Task } from './types';
import { STATUS_LABEL, shortName } from './types';
import { Avatar, StatusDot, StatusMenu } from './WeekPlan';
import { caretOffsets, decorate, htmlToMd, linkify, mdOffsetOf, mdToHtml, mdToVis, setCaretAt, setSelRange } from './richtext';

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
  /** Remove block i; a deleted TOGGLE releases its children (they outdent back to its level). */
  const withoutBlock = (bs: Block[], i: number): Block[] => {
    const b = bs[i];
    const out = bs.filter((_, j) => j !== i);
    if (b.kind !== 'tog') return out;
    const base = b.indent ?? 0;
    for (let j = i; j < out.length && (out[j].indent ?? 0) > base; j++) out[j] = { ...out[j], indent: Math.max(0, (out[j].indent ?? 0) - 1) };
    return out;
  };
  const removeAt = (i: number, focusPrev = true) => {
    const b = blocks[i];
    commit(withoutBlock(blocks, i));
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
    const q = (b && 'text' in b ? b.text : b?.kind === 'task' ? tasksRef.current.find((t) => t.id === b.taskId)?.title ?? '' : '').slice(1).toLowerCase();
    return SLASH_OPTS.filter((o) => o.label.toLowerCase().includes(q));
  };
  const applySlash = (kind: 'h1' | 'h2' | 'p' | 'tog' | 'task') => {
    const sl = slashRef.current;
    if (!sl) return;
    const i = sl.i;
    setSlash(null);
    const b = blocksRef.current[i];
    if (!b || b.kind === 'img') return;
    if (b.kind === 'task') {
      // converting a task block away deletes its (still unnamed) task
      if (kind === 'task') return;
      onDeleteTask(b.taskId);
      commit(blocksRef.current.map((x, j) => (j === i ? { key: newKey(), kind, text: '', indent: b.indent } as Block : x)));
      setFocus({ index: i, caret: 'start' });
      return;
    }
    if (kind === 'task') {
      const id = createTask('');
      commit(blocksRef.current.map((x, j) => (j === i ? { key: newKey(), kind: 'task', taskId: id, indent: b.indent } as Block : x)));
      setFocus({ index: i, caret: 'end' });
    } else {
      commit(blocksRef.current.map((x, j) => (j === i ? { ...b, kind, text: '' } as Block : x)));
      setFocus({ index: i, caret: 'start' });
    }
  };
  // What the menu filters on: the block's text, or the task's title for task blocks.
  const slashText = (b: Block | undefined) => (b && 'text' in b ? b.text : b?.kind === 'task' ? tasksRef.current.find((t) => t.id === b.taskId)?.title ?? '' : null);
  // The menu follows the block's text: it closes when the '/' is gone or the block changed shape.
  useEffect(() => {
    if (!slash) return;
    const b = blocks[slash.i];
    const txt = slashText(b);
    if (txt === null || (txt !== '' && !txt.startsWith('/'))) { setSlash(null); return; }
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
  const onTextKey = (i: number, e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const b = blocks[i] as Extract<Block, { kind: 'h1' | 'h2' | 'p' | 'tog' }>;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { selectAll(e); return; }
    // ⌘B / ⌘I / ⌘⇧X toggle real formatting on the selection; the input event then serialises the DOM back to Markdown.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const cmd = k === 'b' && !e.shiftKey ? 'bold' : k === 'i' && !e.shiftKey ? 'italic' : k === 'x' && e.shiftKey ? 'strikeThrough' : null;
      if (cmd) {
        e.preventDefault();
        // Headings are already bold, so execCommand('bold') would UN-bold them; toggle the
        // Markdown markers directly instead and let the re-render restyle.
        if (cmd === 'bold' && (b.kind === 'h1' || b.kind === 'h2')) {
          const { start, end } = caretOffsets(el);
          if (start === end) return;
          const mdS = mdOffsetOf(b.text, start), mdE = mdOffsetOf(b.text, end);
          const before = b.text.slice(0, mdS), inner = b.text.slice(mdS, mdE), after = b.text.slice(mdE);
          const text = before.endsWith('**') && after.startsWith('**')
            ? before.slice(0, -2) + inner + after.slice(2)
            : inner.startsWith('**') && inner.endsWith('**') && inner.length >= 4
              ? before + inner.slice(2, -2) + after
              : `${before}**${inner}**${after}`;
          setBlock(i, { text });
          window.setTimeout(() => setSelRange(el, start, end), 0); // markers are invisible: same visible offsets
          return;
        }
        document.execCommand(cmd);
        return;
      }
    }
    // The slash menu owns the arrows and Enter while it is open on this block.
    if (slashRef.current?.i === i) {
      const opts = slashOptions();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((v) => Math.min(opts.length - 1, v + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((v) => Math.max(0, v - 1)); return; }
      if (e.key === 'Enter') { e.preventDefault(); const o = opts[Math.min(slashSelRef.current, opts.length - 1)]; if (o) applySlash(o.kind); else setSlash(null); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
    }
    if (e.key === '/' && b.text === '') {
      setSlash({ i, rect: el.getBoundingClientRect() });
      setSlashSel(0);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      setBlock(i, { indent: Math.max(0, Math.min(MAX_IND, (b.indent ?? 0) + (e.shiftKey ? -1 : 1))) });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const { start, end } = caretOffsets(el);
      const head = b.text.slice(0, mdOffsetOf(b.text, start)), tail = b.text.slice(mdOffsetOf(b.text, end));
      const next = blocks.map((x, j) => (j === i ? { ...b, text: head } : x));
      // Enter on a toggle drops into it: the new line is a child, one level deeper.
      next.splice(i + 1, 0, { key: newKey(), kind: 'p', text: tail, indent: Math.min(MAX_IND, (b.indent ?? 0) + (b.kind === 'tog' ? 1 : 0)) });
      commit(next);
      if (b.kind === 'tog') setClosed((c) => { const n = new Set(c); n.delete(b.key); return n; });
      setFocus({ index: i + 1, caret: 'start' });
    } else if (e.key === 'Backspace' && caretOffsets(el).start === 0 && caretOffsets(el).end === 0) {
      if (b.text === '' && blocks.length > 1) { e.preventDefault(); removeAt(i); }
      else if (i > 0 && blocks[i - 1].kind !== 'task' && blocks[i - 1].kind !== 'img') {
        e.preventDefault();
        const prev = blocks[i - 1] as Extract<Block, { kind: 'h1' | 'h2' | 'p' | 'tog' }>;
        const merged = withoutBlock(blocks, i).map((x, j) => (j === i - 1 ? { ...prev, text: prev.text + b.text } : x));
        commit(merged);
        setFocus({ index: i - 1, caret: prev.text.length });
      }
    } else if (e.key === 'ArrowUp' && caretOffsets(el).start === 0 && i > 0) { e.preventDefault(); setFocus({ index: i - 1, caret: 'end' }); }
    else if (e.key === 'ArrowDown' && caretOffsets(el).end === (el.textContent ?? '').length && i < blocks.length - 1) { e.preventDefault(); setFocus({ index: i + 1, caret: 'end' }); }
  };

  const onTaskKey = (i: number, e: React.KeyboardEvent<HTMLDivElement>, task: Task | undefined, title: string, setLocalTitle: (t: string) => void) => {
    const el = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { selectAll(e); return; }
    // Formatting works on task titles too (they're Markdown like every other block).
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const cmd = k === 'b' && !e.shiftKey ? 'bold' : k === 'i' && !e.shiftKey ? 'italic' : k === 'x' && e.shiftKey ? 'strikeThrough' : null;
      if (cmd) { e.preventDefault(); document.execCommand(cmd); return; }
    }
    // The slash menu works here too: '/' on a still-unnamed task offers the block kinds.
    if (slashRef.current?.i === i) {
      const opts = slashOptions();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((v) => Math.min(opts.length - 1, v + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((v) => Math.max(0, v - 1)); return; }
      if (e.key === 'Enter') { e.preventDefault(); const o = opts[Math.min(slashSelRef.current, opts.length - 1)]; if (o) applySlash(o.kind); else setSlash(null); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
    }
    if (e.key === '/' && title === '') {
      setSlash({ i, rect: el.getBoundingClientRect() });
      setSlashSel(0);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      setBlock(i, { indent: Math.max(0, Math.min(MAX_IND, (blocks[i].indent ?? 0) + (e.shiftKey ? -1 : 1))) });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const b = blocks[i] as Extract<Block, { kind: 'task' }>;
      if (title === '') {
        // Enter on an empty task turns it back into plain text instead of chaining another task.
        commit(blocks.map((x, j) => (j === i ? { key: newKey(), kind: 'p', text: '', indent: blocks[i].indent } as Block : x)));
        onDeleteTask(b.taskId);
        setFocus({ index: i, caret: 'start' });
        return;
      }
      const { start, end } = caretOffsets(el);
      const visLen = (el.textContent ?? '').length;
      if (end < visLen) {
        // mid-title: split the line at the caret — the tail becomes the next task
        const head = title.slice(0, mdOffsetOf(title, start));
        const tail = title.slice(mdOffsetOf(title, end));
        setLocalTitle(head);
        onUpdateTask(b.taskId, { title: head });
        const id = createTask(tail);
        insertAt(i + 1, { key: newKey(), kind: 'task', taskId: id, indent: blocks[i].indent });
      } else {
        const id = createTask('');
        insertAt(i + 1, { key: newKey(), kind: 'task', taskId: id, indent: blocks[i].indent });
      }
    } else if (e.key === 'Backspace') {
      const { start, end } = caretOffsets(el);
      if (title === '') { e.preventDefault(); removeAt(i); }
      else if (start === 0 && end === 0 && i > 0) {
        const b = blocks[i] as Extract<Block, { kind: 'task' }>;
        const prev = blocks[i - 1];
        if (prev.kind === 'task') {
          // join back into the task above (the inverse of the Enter split)
          e.preventDefault();
          const pt = tasksRef.current.find((x) => x.id === prev.taskId);
          const joined = (pt?.title ?? '') + title;
          onUpdateTask(prev.taskId, { title: joined });
          commit(withoutBlock(blocks, i));
          onDeleteTask(b.taskId);
          setFocus({ index: i - 1, caret: (pt?.title ?? '').length });
        } else if (prev.kind !== 'img') {
          // join into the text block above; this task dissolves into plain text
          e.preventDefault();
          const pv = prev as Extract<Block, { kind: 'h1' | 'h2' | 'p' | 'tog' }>;
          const merged = withoutBlock(blocks, i).map((x, j) => (j === i - 1 ? { ...pv, text: pv.text + title } : x));
          commit(merged);
          onDeleteTask(b.taskId);
          setFocus({ index: i - 1, caret: pv.text.length });
        }
      }
    }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); setFocus({ index: i - 1, caret: 'end' }); }
    else if (e.key === 'ArrowDown' && i < blocks.length - 1) { e.preventDefault(); setFocus({ index: i + 1, caret: 'end' }); }
    else if (e.key === 'Escape' && task && !task.title) removeAt(i);
  };

  /* ── toolbar actions on the focused block ── */
  const activeRef = useRef(0);
  const setActive = (i: number) => { activeRef.current = i; };
  const turnInto = (kind: 'h1' | 'h2' | 'p' | 'tog' | 'task') => {
    // With a block selection, the whole selection converts (images stay images) — except
    // Toggle, which wraps the selection: a fresh toggle with the selected blocks as children.
    const s = selRef.current;
    if (s && kind === 'tog') {
      const lo = Math.min(s.a, s.b), hi = Math.max(s.a, s.b);
      const bs = blocksRef.current;
      const base = Math.min(...bs.slice(lo, hi + 1).map((x) => x.indent ?? 0));
      const kids = bs.slice(lo, hi + 1).map((x) => ({ ...x, indent: Math.min(MAX_IND, (x.indent ?? 0) + 1) }));
      commit([...bs.slice(0, lo), { key: newKey(), kind: 'tog', text: '', indent: base } as Block, ...kids, ...bs.slice(hi + 1)]);
      setSel(null);
      setFocus({ index: lo, caret: 'start' });
      return;
    }
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
  // Notes images live inline in the DB and are re-downloaded on EVERY team load by every
  // client (this once blew the Supabase egress quota), so big pastes are compressed hard:
  // capped at 1600px on the long side and re-encoded as JPEG unless already tiny.
  const insertImage = (file: File, at: number) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result);
      const place = (src: string) => insertAt(at, { key: newKey(), kind: 'img', src }, 'end');
      if (file.size < 150_000) { place(raw); return; }
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        const jpg = canvas.toDataURL('image/jpeg', 0.82);
        place(jpg.length < raw.length ? jpg : raw);
      };
      img.onerror = () => place(raw);
      img.src = raw;
    };
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
    // Collapsed toggle children render display:none (zero rects): drops only consider visible
    // rows, and the insertion index lands after any hidden subtree — never inside a closed toggle.
    const othersAll = rects.map((r, j) => ({ r, j })).filter(({ j }) => j < from || j >= from + count);
    const vis = othersAll.map((o, k0) => ({ ...o, k0 })).filter((o) => o.r.height > 0);
    const insAt = (y: number) => {
      let vk = 0;
      vis.forEach((o, k) => { if (y > o.r.top + o.r.height / 2) vk = k + 1; });
      return vk < vis.length ? vis[vk].k0 : othersAll.length;
    };
    const prevVisibleFor = (ins: number) => { let p: (typeof vis)[number] | undefined; for (const o of vis) { if (o.k0 < ins) p = o; else break; } return p; };
    const homeIns = othersAll.filter(({ j }) => j < from).length;
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
        // The landing spot decides the depth: under an OPEN toggle means inside it, under a
        // closed one means sibling; otherwise match the visible block above.
        const prevVis = prevVisibleFor(latest.ins);
        const pb = prevVis ? bs[prevVis.j] : undefined;
        let destInd = pb ? Math.min(MAX_IND, (pb.indent ?? 0) + (pb.kind === 'tog' && !closed.has(pb.key) ? 1 : 0)) : 0;
        // dropping just below a toggle's trailing empty line steps OUT of the toggle:
        // the depth follows whatever comes next instead of the filler line
        if (pb && pb.kind === 'p' && pb.text === '' && (pb.indent ?? 0) > 0) {
          const nextVis = vis.find((o) => o.k0 >= latest.ins);
          destInd = nextVis ? (bs[nextVis.j].indent ?? 0) : 0;
        }
        const delta = destInd - (group[0].indent ?? 0);
        const shifted = group.map((g) => ({ ...g, indent: Math.max(0, Math.min(MAX_IND, (g.indent ?? 0) + delta)) }));
        commit([...rest.slice(0, latest.ins), ...shifted, ...rest.slice(latest.ins)]);
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
      let bs = blocksRef.current;
      for (const b of bs.slice(lo, hi + 1)) if (b.kind === 'task') onDeleteTask(b.taskId);
      for (let j = hi; j >= lo; j--) bs = withoutBlock(bs, j); // back to front; ex-toggle children outdent
      commit(bs);
      setSel(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const d = e.shiftKey ? -1 : 1;
        commit(blocksRef.current.map((b, j) => (j >= lo && j <= hi ? { ...b, indent: Math.max(0, Math.min(MAX_IND, (b.indent ?? 0) + d)) } : b)));
        return;
      }
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
                onKey={(e, t, title, setLocal) => onTaskKey(i, e, t, title, setLocal)}
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
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    out.push(b);
    // a toggle always holds at least one line
    if (b.kind === 'tog') {
      const nxt = blocks[i + 1];
      if (!nxt || (nxt.indent ?? 0) <= (b.indent ?? 0)) out.push({ key: newKey(), kind: 'p', text: '', indent: Math.min(MAX_IND, (b.indent ?? 0) + 1) });
    }
  }
  const last = out[out.length - 1];
  if (last && last.kind === 'p' && last.text === '' && !(last.indent ?? 0)) return out;
  return [...out, { key: newKey(), kind: 'p', text: '' }];
}

function TextBlock({ block, placeholder, focus, onFocused, onChange, onKey }: {
  block: Extract<Block, { kind: 'h1' | 'h2' | 'p' | 'tog' }>; placeholder: string; focus: Focus; onFocused: () => void;
  onChange: (text: string) => void; onKey: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);

  // The editor owns its DOM while the user types (so the caret survives); only OUTSIDE
  // changes — undo, realtime, turnInto, slash — rewrite the HTML from the Markdown source.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || block.text === lastEmitted.current) return;
    el.innerHTML = mdToHtml(block.text);
    lastEmitted.current = block.text;
  }, [block.text, block.kind]);

  const emit = () => {
    const el = ref.current!;
    let md = htmlToMd(el).replace(/\u00a0/g, ' ').replace(/\n+$/, '');
    if (md === '' && el.innerHTML !== '') el.innerHTML = ''; // drop stray <br> so :empty (and the placeholder) works
    lastEmitted.current = md;
    onChange(md);
  };

  useEffect(() => {
    if (!focus || !ref.current) return;
    const el = ref.current;
    el.focus();
    const visLen = (el.textContent ?? '').length;
    const pos = focus.caret === 'start' ? 0 : focus.caret === 'end' ? visLen : Math.min(visLen, mdToVis(block.text, focus.caret));
    setCaretAt(el, pos);
    onFocused();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // An empty block invites the slash menu while the caret is in it.
  const ph = block.text === '' ? (focused && block.kind === 'p' ? 'Type / for options…' : placeholder) : undefined;
  return (
    <div className="blk-textwrap">
      <div
        ref={ref}
        className={`blk-text ${block.kind}`}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-ph={ph || undefined}
        onInput={emit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKey}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a');
          if (a) { e.preventDefault(); window.open(a.getAttribute('href') ?? ''); }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          // Block-shaped text bubbles up to the list handler, which builds real blocks from it.
          if (!text || /(^|\n)(#{1,2} |!\[|- \[( |x)\])/i.test(text)) return;
          e.preventDefault();
          document.execCommand('insertText', false, text); // plain text only — no foreign HTML styling
        }}
      />
    </div>
  );
}

function TaskBlock({ task, people, me, claimable, focus, onFocused, onKey, onTitle, onUpdate, onDelete, onClaim, onUnclaim, onOpen }: {
  task: Task | undefined; people: Person[]; me: string; claimable: boolean; focus: Focus; onFocused: () => void;
  onKey: (e: React.KeyboardEvent<HTMLDivElement>, t: Task | undefined, title: string, setLocalTitle: (t: string) => void) => void;
  onTitle: (title: string) => void; onUpdate: (patch: Partial<Task>) => void; onDelete: () => void; onClaim: (personId: string) => void; onUnclaim: () => void; onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [claimMenu, setClaimMenu] = useState<DOMRect | null>(null);
  const [title, setTitle] = useState(task?.title ?? '');
  const timer = useRef<number | undefined>(undefined);
  const lastDrawn = useRef<string | null>(null);
  // Same ownership rule as TextBlock: the DOM is only redrawn from the Markdown when the
  // change came from outside (sync, split, merge) — never for the user's own keystrokes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || title === lastDrawn.current) return;
    el.innerHTML = mdToHtml(title);
    lastDrawn.current = title;
  }, [title]);
  useEffect(() => { if (task && task.title !== title && document.activeElement !== ref.current) setTitle(task.title); }, [task?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focus || !ref.current) return;
    const el = ref.current;
    el.focus();
    const visLen = (el.textContent ?? '').length;
    const pos = focus.caret === 'start' ? 0 : focus.caret === 'end' ? visLen : Math.min(visLen, mdToVis(title, focus.caret));
    setCaretAt(el, pos);
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
  const change = (v: string) => { setTitle(v); lastDrawn.current = v; window.clearTimeout(timer.current); timer.current = window.setTimeout(() => onTitle(v), 400); };
  const setTitleExternal = (v: string) => { setTitle(v); window.clearTimeout(timer.current); }; // redraw + drop any stale pending write
  return (
    <div className={`task-blk wk-row task ${task.status}${owner ? '' : ' unassigned'}`}>
      <button className="status-btn" title={STATUS_LABEL[task.status]}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu((m) => (m ? null : r)); }}>
        <StatusDot status={task.status} />
      </button>
      <div
        ref={ref}
        className="task-blk-title"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-ph={title === '' ? 'Task' : undefined}
        onInput={() => { const el = ref.current!; let md = htmlToMd(el).replace(/\u00a0/g, ' ').replace(/\n+/g, ' '); if (md === '' && el.innerHTML !== '') el.innerHTML = ''; change(md); }}
        onKeyDown={(e) => { if (e.key === 'Enter') window.clearTimeout(timer.current); onKey(e, task, title, setTitleExternal); }}
        onBlur={() => { window.clearTimeout(timer.current); if (title !== task.title) onTitle(title); }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          if (!text || /(^|\n)(#{1,2} |!\[|- \[( |x)\])/i.test(text)) return;
          e.preventDefault();
          document.execCommand('insertText', false, text.replace(/\n+/g, ' '));
        }}
      />
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
