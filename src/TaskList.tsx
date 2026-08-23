import { useEffect, useRef, useState } from 'react';
import type { Person, Task } from './types';
import { STATUS_LABEL, shortName } from './types';
import { Avatar, StatusDot, StatusMenu } from './WeekPlan';
import { InlineName } from './BigPlan';

interface Props {
  tasks: Task[]; // the project's (or parent task's) tasks, assigned or not
  people: Person[];
  me: string;
  editingId?: string;
  onAdd: () => void;
  onRename: (id: string, title: string) => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onReorder: (id: string, delta: number) => void;
  onClaim: (id: string) => void;
  onOpen: (t: Task) => void;
}

/**
 * The task rows from the week view, reused inside a project or task: same status dot, inline
 * rename, status menu and drag-to-reorder. Unassigned rows offer "Add to my week".
 */
export function TaskList({ tasks, people, me, editingId, onAdd, onRename, onUpdate, onDelete, onReorder, onClaim, onOpen }: Props) {
  const sorted = [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  const [lift, setLift] = useState<{ id: string; dy: number; rowH: number } | null>(null);
  const liftIdx = lift ? sorted.findIndex((t) => t.id === lift.id) : -1;
  const liftSteps = lift ? Math.min(sorted.length - 1 - liftIdx, Math.max(-liftIdx, Math.round(lift.dy / lift.rowH))) : 0;
  const liftStepsRef = useRef(0);
  liftStepsRef.current = liftSteps;
  const offset = (i: number) => {
    if (!lift) return 0;
    if (i === liftIdx) return Math.min((sorted.length - 1 - liftIdx) * lift.rowH, Math.max(-liftIdx * lift.rowH, lift.dy));
    if (i > liftIdx && i <= liftIdx + liftSteps) return -lift.rowH;
    if (i < liftIdx && i >= liftIdx + liftSteps) return lift.rowH;
    return 0;
  };

  return (
    <div className="task-list">
      {sorted.map((t, i) => (
        <Row
          key={t.id}
          task={t}
          people={people}
          me={me}
          editing={editingId === t.id}
          offset={offset(i)}
          lifting={lift?.id === t.id}
          onLift={(dy, rowH) => setLift({ id: t.id, dy, rowH })}
          onDrop={() => { if (liftStepsRef.current !== 0) onReorder(t.id, liftStepsRef.current); setLift(null); }}
          onRename={onRename}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onClaim={onClaim}
          onOpen={onOpen}
        />
      ))}
      <button className="add-task list-add" onClick={onAdd}><span className="plus">+</span> Add task</button>
    </div>
  );
}

function Row({ task, people, me, editing, offset, lifting, onLift, onDrop, onRename, onUpdate, onDelete, onClaim, onOpen }: {
  task: Task; people: Person[]; me: string; editing: boolean; offset: number; lifting: boolean;
  onLift: (dy: number, rowH: number) => void; onDrop: () => void;
  onRename: Props['onRename']; onUpdate: Props['onUpdate']; onDelete: Props['onDelete']; onClaim: Props['onClaim']; onOpen: Props['onOpen'];
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const owner = task.personId ? people.find((p) => p.id === task.personId) : undefined;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.status-menu')) setMenu(null); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.status-btn, .status-menu, .inline-name, .pill')) return;
    e.preventDefault();
    const startY = e.clientY;
    const rowH = rowRef.current?.offsetHeight ?? 36;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      if (moved) onLift(dy, rowH);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) onOpen(task); else onDrop();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={rowRef}
      className={`wk-row task ${task.status}${lifting ? ' lifting' : ''}${offset && !lifting ? ' shifted' : ''}${owner ? '' : ' unassigned'}`}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
    >
      <div className="wk-list" onPointerDown={onDown} style={{ cursor: 'grab' }}>
        <button className="status-btn" title={STATUS_LABEL[task.status]}
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu((m) => (m ? null : r)); }}>
          <StatusDot status={task.status} />
        </button>
        {editing
          ? <InlineName initial={task.title} placeholder="Task name…" onDone={(t) => onRename(task.id, t)} />
          : <button className="task-title">{task.title}</button>}
        {owner ? (
          <span className="from-chip" title={`${owner.name} · ${STATUS_LABEL[task.status]}`}>
            <Avatar person={owner} size={14} /> {owner.id === me ? 'you' : shortName(owner.name).split(' ')[0]}
          </span>
        ) : (
          <button className="pill small claim" onClick={() => onClaim(task.id)}>+ Add to my week</button>
        )}
        {menu && (
          <StatusMenu
            value={task.status}
            reviewerId={task.reviewerId}
            people={people.filter((x) => x.id !== task.personId)}
            onPick={(status, reviewerId) => { onUpdate(task.id, reviewerId !== undefined ? { status, reviewerId } : { status }); setMenu(null); }}
            onDelete={() => { setMenu(null); onDelete(task.id); }}
            anchor={menu}
          />
        )}
      </div>
    </div>
  );
}
