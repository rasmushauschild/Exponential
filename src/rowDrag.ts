/**
 * Pointer-driven vertical reorder for small row lists (retro lists, template
 * rows in Team settings). Call from a handle's onPointerDown. A release within
 * 5px counts as a tap (onTap — e.g. cycling a priority chip); past that it's a
 * drag: onMove(from, to) fires live each time the pointer crosses a row
 * midpoint, onState tracks the dragged index for styling, onDone fires on drop.
 */
export function dragRows(e: { clientX: number; clientY: number }, opts: {
  index: number;
  rowAt: (i: number) => HTMLElement | null;
  count: () => number;
  onMove: (from: number, to: number) => void;
  onState?: (dragging: number | null) => void;
  onTap?: () => void;
  onDone?: (moved: boolean) => void;
}) {
  const sx = e.clientX, sy = e.clientY;
  let cur = opts.index, started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
      started = true;
      opts.onState?.(cur);
      document.body.classList.add('cursor-grabbing');
    }
    const n = opts.count();
    let target = cur;
    for (let j = 0; j < n; j++) {
      if (j === cur) continue;
      const el = opts.rowAt(j);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const mid = b.top + b.height / 2;
      if (j < cur && ev.clientY < mid) target = Math.min(target, j);
      if (j > cur && ev.clientY > mid) target = Math.max(target, j);
    }
    if (target !== cur) {
      opts.onMove(cur, target);
      opts.onState?.(target);
      cur = target;
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('cursor-grabbing');
    if (started) {
      opts.onState?.(null);
      opts.onDone?.(cur !== opts.index);
    } else opts.onTap?.();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
