import { useEffect, useRef, useState } from 'react';

/**
 * Confidence as a stepper: − and + around a big number, 0–10. The signal is a
 * glow behind the number — red (worry) / amber (shaky) / green (on track) /
 * hyperspace blue at 10 — breathing slowly when it's ≤2. Stepping up thumps the
 * number; stepping down shakes it. From 7 the whole key-result row flies at
 * warp speed, streaks growing longer and faster the higher it goes.
 */

export const dialColor = (v: number) => (v <= 2 ? '#ff3b30' : v <= 6 ? '#ff9500' : v < 10 ? '#34c759' : '#5aa2ff');

type Star = { x: number; y: number; speed: number; len: number; width: number; life: number };

export function ConfidenceStepper({ value, onChange }: {
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  const v = value ?? 0;
  const rated = value !== undefined;
  const [fx, setFx] = useState<{ dir: 'up' | 'down'; n: number } | null>(null);

  const bump = (delta: number) => {
    const next = Math.max(0, Math.min(10, v + delta));
    if (next === v && rated) return;
    onChange(next);
    setFx((f) => ({ dir: delta > 0 ? 'up' : 'down', n: (f?.n ?? 0) + 1 }));
  };

  /* ── warp field ── */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stars = useRef<Star[]>([]);
  const hyperRef = useRef(false);
  hyperRef.current = v >= 10;
  const intRef = useRef(0); // 0 at 7 → 1 at 10: longer, faster streaks the higher it goes
  intRef.current = Math.max(0, Math.min(1, (v - 7) / 3));
  const warp = rated && v >= 7;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (!warp) {
      stars.current = [];
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      return;
    }
    // the canvas spans the whole key-result row (CSS) — keep the bitmap in sync at 2x
    const fit = () => {
      const w = Math.round(c.clientWidth * 2), h = Math.round(c.clientHeight * 2);
      if (w && h && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    const spawn = (x: number, H: number) => ({
      x,
      y: H / 2 + (Math.random() + Math.random() - 1) * H * 0.46,
      speed: 2.2 + Math.random() * 5,
      len: 8 + Math.random() * 22,
      width: 1 + Math.random() * 1.4,
      life: 0,
    });
    // start with a field already in flight, not an empty screen filling up
    if (!stars.current.length) for (let i = 0; i < 20; i++) stars.current.push({ ...spawn(Math.random() * c.width, c.height), life: 1 });

    let raf = 0;
    const step = () => {
      const ctx = c.getContext('2d')!;
      const W = c.width, H = c.height;
      const hyper = hyperRef.current;
      const t = intRef.current;
      for (let i = 0; i < 2 + Math.round(t * 2); i++) {
        if (stars.current.length < 40 + t * 35 && Math.random() < 0.7) stars.current.push(spawn(W + Math.random() * 40, H));
      }
      ctx.clearRect(0, 0, W, H);
      stars.current = stars.current.filter((s) => s.x + s.len + s.speed * 8 > -10);
      for (const s of stars.current) {
        s.x -= s.speed * (1 + t * 1.4);
        s.speed = Math.min(13, s.speed * 1.012); // ever accelerating = warp
        s.life = Math.min(1, s.life + 0.08);
        const len = (s.len + s.speed * 2.2) * (1 + t * 1.8); // higher score = longer streaks
        const head = s.x, tail = s.x + len;
        // gentle fade over ~15% of the row at BOTH ends, and toward top/bottom — nothing clips
        const fadeX = W * 0.15;
        const edge = Math.min(1, s.y / 14, (H - s.y) / 14, tail / fadeX, (W - head) / fadeX);
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
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [warp]);

  const danger = rated && v <= 2;

  return (
    <div className={`cstep${danger ? ' danger' : ''}`}>
      <canvas ref={canvasRef} className="cstep-canvas" />
      <button className="cstep-btn" title="Less confident" disabled={rated && v <= 0} onClick={() => bump(-1)}>−</button>
      <span
        key={fx?.n ?? 'still'}
        className={`cstep-value${rated ? '' : ' unrated'}${fx ? ` fx-${fx.dir}` : ''}`}
        style={rated ? { ['--gc' as string]: `${dialColor(v)}cc` } : undefined}
        onAnimationEnd={(e) => { if (e.animationName.startsWith('step-pop') || e.animationName.startsWith('step-shake')) setFx(null); }}
      >{rated ? v : '–'}</span>
      <button className="cstep-btn" title="More confident" disabled={rated && v >= 10} onClick={() => bump(1)}>+</button>
    </div>
  );
}
