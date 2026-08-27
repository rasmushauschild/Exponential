import { useEffect, useRef, useState } from 'react';

/**
 * A linear confidence slider, 0–10. Drag (or click) along the track to set it.
 * The slider itself stays neutral — the signal is a glow: red (worry) / amber
 * (shaky) / green (on track), and at ≤2 it pulses like a warning light. Above 7
 * the row flies at warp speed — a continuous field of star streaks races past —
 * and a 10 jumps to hyperspace: Star Wars blue-white.
 */

export const dialColor = (v: number) => (v <= 2 ? '#ff3b30' : v <= 6 ? '#ff9500' : v < 10 ? '#34c759' : '#5aa2ff');

type Star = { x: number; y: number; speed: number; len: number; width: number; life: number };

export function ConfidenceSlider({ value, onChange }: {
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  const committed = value ?? 0;
  const [live, setLive] = useState<number | null>(null); // while dragging
  const v = live ?? committed;
  const rated = value !== undefined || live !== null;

  /* ── warp field ── */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stars = useRef<Star[]>([]);
  const hyperRef = useRef(false);
  hyperRef.current = v >= 10;
  const warp = rated && v > 7;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (!warp) {
      stars.current = [];
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      return;
    }
    const W = c.width, H = c.height;
    const spawn = (x: number) => ({
      x,
      y: H / 2 + (Math.random() + Math.random() - 1) * H * 0.46,
      speed: 2.2 + Math.random() * 5,
      len: 8 + Math.random() * 22,
      width: 1 + Math.random() * 1.4,
      life: 0,
    });
    // start with a field already in flight, not an empty screen filling up
    if (!stars.current.length) for (let i = 0; i < 16; i++) stars.current.push({ ...spawn(Math.random() * W), life: 1 });

    let raf = 0;
    const step = () => {
      const ctx = c.getContext('2d')!;
      const hyper = hyperRef.current;
      for (let i = 0; i < (hyper ? 3 : 2); i++) {
        if (stars.current.length < (hyper ? 70 : 48) && Math.random() < 0.7) stars.current.push(spawn(W + Math.random() * 30));
      }
      ctx.clearRect(0, 0, W, H);
      stars.current = stars.current.filter((s) => s.x + s.len + s.speed * 3 > -10);
      for (const s of stars.current) {
        s.x -= s.speed * (hyper ? 1.5 : 1);
        s.speed = Math.min(13, s.speed * 1.012); // ever accelerating = warp
        s.life = Math.min(1, s.life + 0.08);
        const len = s.len + s.speed * 2.4; // speed stretches the streak
        const head = s.x, tail = s.x + len;
        // soft alpha falloff toward every canvas edge — nothing clips hard
        const edge = Math.min(1, s.y / 16, (H - s.y) / 16, (tail + 20) / 60, (W + 20 - head) / 50);
        const a = 0.55 * s.life * Math.max(0, edge);
        if (a <= 0.01) continue;
        const g = ctx.createLinearGradient(head, s.y, tail, s.y);
        if (hyper) {
          g.addColorStop(0, `rgba(225, 240, 255, ${a})`);
          g.addColorStop(0.25, `rgba(140, 190, 255, ${a * 0.8})`);
          g.addColorStop(1, 'rgba(90, 162, 255, 0)');
          ctx.shadowColor = 'rgba(90, 162, 255, 0.9)';
          ctx.shadowBlur = 6;
        } else {
          g.addColorStop(0, `rgba(190, 240, 200, ${a})`);
          g.addColorStop(0.3, `rgba(90, 210, 120, ${a * 0.7})`);
          g.addColorStop(1, 'rgba(52, 199, 89, 0)');
          ctx.shadowColor = 'rgba(52, 199, 89, 0.55)';
          ctx.shadowBlur = 4;
        }
        ctx.strokeStyle = g;
        ctx.lineWidth = s.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(head, s.y);
        ctx.lineTo(tail, s.y);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [warp]);

  /* ── interaction ── */
  const trackRef = useRef<HTMLDivElement>(null);
  const valueAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.round(Math.min(10, Math.max(0, ((clientX - r.left) / r.width) * 10)));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setLive(valueAt(e.clientX));
    const move = (ev: PointerEvent) => setLive(valueAt(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const final = valueAt(ev.clientX);
      setLive(null);
      onChange(final);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const color = dialColor(v);
  const danger = rated && v <= 2;
  const pct = (v / 10) * 100;
  const glowTransition = live !== null ? 'none' : 'box-shadow 0.25s';

  return (
    <div className={`cslider${danger ? ' danger' : ''}`} title={'drag to rate confidence 0–10'}>
      <canvas ref={canvasRef} className="cslider-canvas" width={368} height={124} />
      <div ref={trackRef} className="cslider-track" onPointerDown={onPointerDown}>
        <div className="cslider-rail" />
        {rated && v > 0 && (
          <div className="cslider-fill" style={{ width: `${pct}%`, boxShadow: `0 0 9px 1px ${color}90`, transition: glowTransition }} />
        )}
        <div
          className="cslider-thumb"
          style={{
            left: `${pct}%`,
            background: rated ? 'var(--text)' : 'var(--text-3)',
            boxShadow: rated ? `0 0 0 2px var(--soft), 0 0 10px 2px ${color}a6` : '0 0 0 2px var(--soft)',
            transition: glowTransition,
          }}
        />
      </div>
      <span className="cslider-value" style={{ color: danger ? '#ff3b30' : rated ? 'var(--text)' : 'var(--text-3)' }}>{rated ? v : '–'}</span>
    </div>
  );
}
