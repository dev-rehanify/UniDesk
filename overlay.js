// Shared stroke renderer: used by the host's transparent overlay and the viewer's preview canvas.
// Strokes are lists of normalized points [0..1]; each stroke fades out FADE_MS after it ends.
(function () {
  const FADE_MS = 2500, HOLD_MS = 1200;
  function StrokeLayer(canvas) {
    const ctx = canvas.getContext('2d');
    const strokes = new Map(); // id -> { pts, color, ended }
    let raf = 0;
    function fit() { const r = devicePixelRatio || 1; canvas.width = canvas.clientWidth * r; canvas.height = canvas.clientHeight * r; }
    addEventListener('resize', fit); fit();
    function frame() {
      raf = 0; const now = performance.now(), W = canvas.width, H = canvas.height, r = devicePixelRatio || 1;
      ctx.clearRect(0, 0, W, H);
      for (const [id, s] of strokes) {
        let a = 1;
        if (s.ended) { const t = now - s.ended - HOLD_MS; if (t > 0) a = 1 - t / FADE_MS; if (a <= 0) { strokes.delete(id); continue; } }
        ctx.globalAlpha = a; ctx.lineCap = ctx.lineJoin = 'round';
        // soft glow + solid core
        for (const [w, alpha] of [[14, .25], [5, 1]]) {
          ctx.strokeStyle = s.color; ctx.globalAlpha = a * alpha; ctx.lineWidth = w * r;
          ctx.beginPath(); s.pts.forEach(([x, y], i) => i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H));
          if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * W + .1, s.pts[0][1] * H);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (strokes.size) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    return {
      apply(m) {
        if (m.k === 'start') strokes.set(m.id, { pts: [[m.x, m.y]], color: m.color || '#ff4f8b', ended: 0 });
        else if (m.k === 'pt') strokes.get(m.id)?.pts.push([m.x, m.y]);
        else if (m.k === 'end') { const s = strokes.get(m.id); if (s) s.ended = performance.now(); }
        else if (m.k === 'clear') strokes.clear();
        kick();
      },
      fit
    };
  }
  window.StrokeLayer = StrokeLayer;
  const c = document.getElementById('c');
  if (c && window.overlay) { const layer = StrokeLayer(c); window.overlay.onDraw((m) => layer.apply(m)); }
})();
