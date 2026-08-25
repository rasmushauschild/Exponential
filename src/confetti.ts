/**
 * A small celebratory burst of green confetti from a point (the status dot when a task
 * is completed). Particles pop upward, flutter down and fade just before the bottom of
 * the window. One throwaway canvas per burst; removed when the last piece lands.
 */

const GREENS = ['#34c759', '#30d158', '#57d977', '#2aa84f', '#a4e8b0'];

export function confettiBurst(x: number, y: number) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '9999' });
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  const parts = Array.from({ length: 22 }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.7; // mostly upward, some sideways
    const speed = 2 + Math.random() * 5;
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.5,
      w: 3 + Math.random() * 3,
      h: 2 + Math.random() * 2,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      sway: Math.random() * Math.PI * 2,
      color: GREENS[Math.floor(Math.random() * GREENS.length)],
    };
  });

  const floor = window.innerHeight;
  const start = performance.now();
  // rAF freezes while the window is hidden; make sure the canvas never outstays its welcome.
  const kill = window.setTimeout(() => canvas.remove(), 6000);
  const tick = (now: number) => {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    let alive = false;
    for (const p of parts) {
      p.vy += 0.16; // gravity
      p.vx *= 0.99;
      p.vy *= 0.995;
      p.x += p.vx + Math.sin(now / 300 + p.sway) * 0.4; // gentle flutter
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > floor) continue;
      alive = true;
      ctx.save();
      ctx.globalAlpha = 0.95 * Math.max(0, Math.min(1, (floor - p.y) / 90)); // fade out over the last stretch
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive && now - start < 5000) requestAnimationFrame(tick);
    else { window.clearTimeout(kill); canvas.remove(); }
  };
  requestAnimationFrame(tick);
}
