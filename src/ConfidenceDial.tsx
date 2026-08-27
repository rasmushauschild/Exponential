import { useEffect, useRef, useState } from 'react';

/**
 * A rotary confidence dial, 0–10. Drag (or click) around the arc to set it.
 * Turning it up fires warp-speed streaks outward; low values shift through amber
 * into red, and at ≤2 the whole dial pulses like a warning light.
 */

const START = -225; // degrees; arc sweeps 270° clockwise to +45
const SWEEP = 270;

export const dialColor = (v: number) => `hsl(${Math.round(v * 12.2)} 80% ${46 + v * 0.8}%)`;

type Streak = { angle: number; r: number; speed: number; len: number; life: number; hue: number };

export function ConfidenceDial({ value, onChange, label }: {
  value: number | undefined;
  onChange: (v: number) => void;
  label: string;
}) {
  const committed = value ?? 0;
  const [live, setLive] = useState<number | null>(null); // while dragging
  const v = live ?? committed;
  const rated = value !== undefined || live !== null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streaks = useRef<Streak[]>([]);
  const raf = useRef(0);
  const lastV = useRef(v);

  /* ── warp streaks ── */
  const spawn = (n: number, forV: number) => {
    const hue = forV * 12.2;
    for (let i = 0; i < n; i++) {
      streaks.current.push({
        angle: Math.random() * Math.PI * 2,
        r: 26 + Math.random() * 8,
        speed: 2.2 + Math.random() * 3.4,
        len: 6 + Math.random() * 12,
        life: 1,
        hue,
      });
    }
    if (!raf.current) tick();
  };
  const tick = () => {
    const c = canvasRef.current;
    if (!c) { raf.current = 0; return; }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    const cx = c.width / 2, cy = c.height / 2;
    streaks.current = streaks.current.filter((s) => s.life > 0.03 && s.r < c.width / 2);
    for (const s of streaks.current) {
      s.r += s.speed;
      s.speed *= 1.06; // accelerating outward = warp
      s.life *= 0.92;
      const x1 = cx + Math.cos(s.angle) * s.r;
      const y1 = cy + Math.sin(s.angle) * s.r;
      const x2 = cx + Math.cos(s.angle) * (s.r + s.len);
      const y2 = cy + Math.sin(s.angle) * (s.r + s.len);
      ctx.strokeStyle = `hsla(${s.hue}, 85%, 60%, ${s.life})`;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    raf.current = streaks.current.length ? requestAnimationFrame(tick) : 0;
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // A step up sprays streaks; the bigger the jump (and the higher the value), the more of them.
  useEffect(() => {
    const prev = lastV.current;
    lastV.current = v;
    if (v > prev) spawn(Math.min(18, 3 + Math.round((v - prev) * 3) + Math.round(v / 2)), v);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── rotary interaction ── */
  const dialRef = useRef<HTMLDivElement>(null);
  const valueAt = (clientX: number, clientY: number) => {
    const r = dialRef.current!.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI; // (-180, 180], 0 = east
    if (deg > 45) deg -= 360; // → (-315, 45], the dial's own frame
    if (deg < START) deg = deg < -270 ? 45 : START; // bottom gap snaps to the nearest end
    return Math.round(Math.min(10, Math.max(0, ((deg - START) / SWEEP) * 10)));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setLive(valueAt(e.clientX, e.clientY));
    const move = (ev: PointerEvent) => setLive(valueAt(ev.clientX, ev.clientY));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const final = valueAt(ev.clientX, ev.clientY);
      setLive(null);
      lastV.current = final;
      onChange(final);
      if (final >= 8) spawn(16, final); // landing high earns a burst
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ── arc geometry ── */
  const R = 34, C = 44; // radius, center (88px viewBox)
  const arc = (from: number, to: number) => {
    const a0 = (from * Math.PI) / 180, a1 = (to * Math.PI) / 180;
    const large = to - from > 180 ? 1 : 0;
    return `M ${C + R * Math.cos(a0)} ${C + R * Math.sin(a0)} A ${R} ${R} 0 ${large} 1 ${C + R * Math.cos(a1)} ${C + R * Math.sin(a1)}`;
  };
  const end = START + (v / 10) * SWEEP;
  const color = dialColor(v);
  const danger = rated && v <= 2;

  return (
    <div className={`dial${danger ? ' danger' : ''}`}>
      <canvas ref={canvasRef} className="dial-canvas" width={200} height={200} />
      <div ref={dialRef} className="dial-face" onPointerDown={onPointerDown} title={`${label}: drag to rate confidence 0–10`}>
        <svg width={88} height={88} viewBox="0 0 88 88">
          <path d={arc(START, START + SWEEP)} fill="none" stroke="var(--soft-2)" strokeWidth={7} strokeLinecap="round" />
          {rated && v > 0 && <path d={arc(START, end)} fill="none" stroke={color} strokeWidth={7} strokeLinecap="round" style={{ transition: live !== null ? 'none' : 'stroke 0.2s' }} />}
          {rated && (
            <circle cx={C + R * Math.cos((end * Math.PI) / 180)} cy={C + R * Math.sin((end * Math.PI) / 180)} r={5.5} fill={color} stroke="var(--panel)" strokeWidth={2} />
          )}
        </svg>
        <span className="dial-value" style={{ color: rated ? color : 'var(--text-3)' }}>{rated ? v : '–'}</span>
      </div>
      <span className="dial-label" title={label}>{label}</span>
    </div>
  );
}
