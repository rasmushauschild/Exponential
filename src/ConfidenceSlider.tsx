import { useEffect, useRef, useState } from 'react';

/**
 * A linear confidence slider, 0–10. Drag (or click) along the track to set it.
 * Low values shift through amber into red — at ≤2 the fill pulses like a warning
 * light — and above 7 the whole row flies at warp speed: a continuous field of
 * star streaks races past for as long as confidence stays that high.
 */

// Discrete, matching the health marks: red (worry) / amber (shaky) / green (on track).
export const dialColor = (v: number) => (v <= 2 ? '#ff3b30' : v <= 6 ? '#ff9500' : '#34c759');

type Star = { x: number; y: number; speed: number; len: number; life: number };

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
  const warp = rated && v > 7;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (!warp) {
      stars.current = [];
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      return;
    }
    let raf = 0;
    const step = () => {
      const ctx = c.getContext('2d')!;
      const W = c.width, H = c.height;
      // new stars enter from the right, biased toward the track's centerline
      for (let i = 0; i < 2; i++) {
        if (stars.current.length < 60 && Math.random() < 0.75) {
          const spread = (Math.random() + Math.random() - 1) * 0.5; // triangular, denser mid
          stars.current.push({
            x: W + Math.random() * 40,
            y: H / 2 + spread * H * 0.9,
            speed: 3 + Math.random() * 7,
            len: 10 + Math.random() * 30,
            life: 0,
          });
        }
      }
      ctx.clearRect(0, 0, W, H);
      stars.current = stars.current.filter((s) => s.x + s.len > -10);
      for (const s of stars.current) {
        s.x -= s.speed;
        s.speed *= 1.015; // ever accelerating = warp
        s.life = Math.min(1, s.life + 0.12);
        ctx.strokeStyle = `rgba(52, 199, 89, ${0.5 * s.life})`;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + s.len, s.y);
        ctx.stroke();
      }
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

  return (
    <div className={`cslider${danger ? ' danger' : ''}`} title={'drag to rate confidence 0–10'}>
      <canvas ref={canvasRef} className="cslider-canvas" width={400} height={88} />
      <div ref={trackRef} className="cslider-track" onPointerDown={onPointerDown}>
        <div className="cslider-rail" />
        {rated && v > 0 && (
          <div className="cslider-fill" style={{ width: `${pct}%`, background: color, transition: live !== null ? 'none' : 'background 0.2s' }} />
        )}
        <div
          className="cslider-thumb"
          style={{ left: `${pct}%`, background: rated ? color : 'var(--text-3)', transition: live !== null ? 'none' : 'background 0.2s' }}
        />
      </div>
      <span className="cslider-value" style={{ color: rated ? color : 'var(--text-3)' }}>{rated ? v : '–'}</span>
    </div>
  );
}
