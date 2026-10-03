// Canvas renderer + pointer handling. This file owns pixels and gestures and decides
// nothing about legality: every finger position becomes a `beginStroke` / `stepTo` /
// `endStroke` call into js/core/game.js, which is the only place an edge can turn drawn.
//
// That split is deliberate and it is what makes @pointer meaningful. A headless test can
// dispatch real `Input.dispatchMouseEvent` points at real client coordinates; if the view
// mutated the state itself the test would prove nothing about the game, only about the
// test. Here the drag can only ever *ask*, so an illegal ask (a pin with no free edge, a
// jump across two cells, a coordinate outside the board) is rejected by the rules exactly
// the way a player's is.

import {
  beginStroke, endStroke, stepTo, freeMoves, strokesUsed,
} from './core/game.js';
import {
  PAD, MIN_TOL, geomFor, vertexLocal, vertexAtLocal, edgeAtLocal, clampRC,
} from './core/geometry.js';

// One hue per stroke index, so "which pen made this line" is readable without a legend.
const INK = ['#e8b04b', '#5fc9e0', '#b78bf2', '#7fd08a', '#f2748b', '#e0a63c', '#79a8ff'];
const UNDRAWN = 'rgba(226, 232, 240, 0.30)';
const BOARD = '#171a21';
const FRAME = '#2a2f3a';
const GRID = 'rgba(226, 232, 240, 0.06)';
const PIN = '#8fa2bd';
const PIN_HOT = '#f4f7fb';

export function createView(canvas, { onEvent } = {}) {
  const ctx = canvas.getContext('2d');
  let game = null;
  let gm = geomFor(320, 320, 8, 8);
  let drag = null;          // { last: {x,y}, blocked: reason }
  let hint = null;          // { edge, until, vertex }
  let raf = 0;
  let last = 0;
  let flash = 0;            // 0..1, the "that edge is already drawn" nudge
  let flashEdge = -1;       // which edge got the nudge

  // ---- 减弱动效（prefers-reduced-motion）----
  // hintRing 的 t = (now % 900) / 900 是一段纯装饰的呼吸：线宽从 3 长到 8、透明度从 0.9 淡到 0.3。
  // 减弱动效下**把 t 钉在 0.5**——环还在、还是那条被指的边、亮度还是能看清，只是不再一涨一落。
  // 提示环本身是"往这儿走"的信息载体，连环一起删掉等于把提示删了，所以只停它的相位。
  let reduceMotion = false;
  const ringPhase = () => (reduceMotion ? 0.5 : (performance.now() % 900) / 900);

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(200, Math.round(box.width));
    const H = Math.max(200, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!game) return;
    gm = geomFor(W, H, game.g.rows, game.g.cols);
    draw();
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  // What is under a client coordinate. `v` is a pin id or -1, `clamped` says the point was
  // outside the board and got snapped to the outermost row/column instead of being allowed
  // to name a coordinate that does not exist.
  function probe(clientX, clientY) {
    const box = canvas.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    const g = game.g;
    const rawC = Math.round((x - gm.ox) / gm.cell);
    const rawR = Math.round((y - gm.oy) / gm.cell);
    const clamped = clampRC(g, rawR, rawC);
    return {
      v: vertexAtLocal(g, gm, x, y, MIN_TOL),
      edge: edgeAtLocal(g, gm, x, y, MIN_TOL),
      rc: clamped,
      clamped: clamped.r !== rawR || clamped.c !== rawC,
      local: { x, y },
    };
  }

  function report(ev) {
    if (onEvent) onEvent(ev);
  }

  function down(ev) {
    if (!game || game.outcome === 'won') return;
    const p = localPoint(ev);
    const v = vertexAtLocal(game.g, gm, p.x, p.y, MIN_TOL);
    if (v < 0) {
      drag = null;
      report({ type: 'miss' });
      return;
    }
    const r = beginStroke(game, v);
    drag = r.ok ? { last: p, active: true } : null;
    if (!r.ok) report({ type: 'blocked', reason: r.reason, vertex: v });
    if (hint && hint.vertex === v) hint = null;
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(ev.pointerId); } catch (err) { /* capture is a nicety */ }
    }
    draw();
    ev.preventDefault();
  }

  // Walk the straight line between two consecutive pointer samples in sub-steps, so a fast
  // drag that skips past a pin still counts it. Each candidate pin is *offered* to the
  // rules; a pin that is not adjacent to the pen's current vertex is refused there. This
  // function never marks an edge drawn — it can only ask.
  function sweep(from, to) {
    const step = Math.max(4, Math.floor(gm.cell / 3));
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const n = Math.max(1, Math.ceil(dist / step));
    let asked = 0;
    for (let i = 1; i <= n; i++) {
      const x = from.x + ((to.x - from.x) * i) / n;
      const y = from.y + ((to.y - from.y) * i) / n;
      const v = vertexAtLocal(game.g, gm, x, y, MIN_TOL);
      if (v < 0) continue;
      const cur = game.cur;
      if (!cur) {
        // The previous stroke ended on its own (口径 1: the pen hit a stranded pin). A
        // button that is still held down opens the next stroke here, which is the same
        // thing a player gets by lifting and pressing again — nothing is punished.
        if (!drag) continue;
        const b = beginStroke(game, v);
        if (b.ok) report({ type: 'restart', vertex: v });
        continue;
      }
      const at = cur.verts[cur.verts.length - 1];
      if (v === at) continue;
      const r = stepTo(game, v);
      asked++;
      if (!r.ok) {
        if (r.reason === 'drawn') { flash = 1; flashEdge = r.edge; report({ type: 'again', edge: r.edge, vertex: v }); }
        else report({ type: 'refused', reason: r.reason, vertex: v });
        continue;
      }
      report({ type: 'step', vertex: v, edge: r.edge, autoEnded: r.autoEnded });
      if (r.autoEnded && game.outcome !== 'playing') break;
    }
    return asked;
  }

  function move(ev) {
    if (!drag || !game) return;
    const p = localPoint(ev);
    sweep(drag.last, p);
    drag.last = p;
    ev.preventDefault();
  }

  // 口径 3: lifting the pen is legal at any moment and costs nothing but the stroke itself.
  function up(ev) {
    if (!drag) return;
    drag = null;
    if (ev && ev.preventDefault) ev.preventDefault();
    const r = endStroke(game);
    report({ type: 'lift', committed: r.committed, outcome: game.outcome });
    draw();
  }

  function lineFor(e, inset) {
    const g = game.g;
    const a = vertexLocal(g, gm, Math.floor(g.ea[e] / g.cols), g.ea[e] % g.cols);
    const b = vertexLocal(g, gm, Math.floor(g.eb[e] / g.cols), g.eb[e] % g.cols);
    if (!inset) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const t = inset / len;
    return { x1: a.x + dx * t, y1: a.y + dy * t, x2: b.x - dx * t, y2: b.y - dy * t };
  }

  function drawEdge(e, ink, width, alpha) {
    const l = lineFor(e, width * 0.5);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ink;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function draw() {
    const { cell, ox, oy } = { cell: gm.cell, ox: gm.ox, oy: gm.oy };
    const vw = gm.vw, vh = gm.vh;
    ctx.clearRect(0, 0, vw, vh);
    if (!game) return;
    const g = game.g;
    const w = (g.cols - 1) * cell;
    const h = (g.rows - 1) * cell;

    ctx.fillStyle = FRAME;
    roundRect(ctx, ox - PAD * 0.55, oy - PAD * 0.55, w + PAD * 1.1, h + PAD * 1.1, 16);
    ctx.fill();
    ctx.fillStyle = BOARD;
    roundRect(ctx, ox - PAD * 0.3, oy - PAD * 0.3, w + PAD * 0.6, h + PAD * 0.6, 10);
    ctx.fill();

    // Faint lattice so a pin's neighbour relation is visible even where there is no edge.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let r = 0; r < g.rows; r++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + r * cell);
      ctx.lineTo(ox + w, oy + r * cell);
      ctx.stroke();
    }
    for (let c = 0; c < g.cols; c++) {
      ctx.beginPath();
      ctx.moveTo(ox + c * cell, oy);
      ctx.lineTo(ox + c * cell, oy + h);
      ctx.stroke();
    }

    // Undrawn edges first: thick, grey, unmistakably "still on the page".
    const undrawnWidth = Math.max(5, Math.round(cell * 0.16));
    for (let e = 0; e < g.m; e++) {
      if (game.drawn[e]) continue;
      drawEdge(e, UNDRAWN, undrawnWidth, 1);
    }

    // Then the ink, in the order the pens went over it. Index by stroke so two pens of the
    // same band never share a colour by accident.
    const inkWidth = Math.max(6, Math.round(cell * 0.2));
    const pens = game.cur && game.cur.edges.length ? game.strokes.concat([game.cur]) : game.strokes;
    pens.forEach((t, i) => {
      const ink = INK[i % INK.length];
      for (const e of t.edges) drawEdge(e, ink, inkWidth, hint && hint.edge === e ? 0.5 : 1);
    });

    // The already-drawn flash: a drag that crossed a finished edge (口径 2 — nothing
    // happened, but the player should see *why* something happened to nothing).
    if (flash > 0.01 && flashEdge >= 0) {
      const l = lineFor(flashEdge, 0);
      ctx.globalAlpha = flash * 0.55;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(6, Math.round(cell * 0.2)) + 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Stroke-number badges at the start of each committed stroke: the theorem's `par` is
    // only checkable on screen if you can count the pens.
    game.strokes.concat(game.cur ? [game.cur] : []).forEach((t, i) => {
      if (!t.edges.length) return;
      const v = t.verts[0];
      const p = vertexLocal(g, gm, Math.floor(v / g.cols), v % g.cols);
      badge(p.x, p.y, i + 1, INK[i % INK.length]);
    });

    // Pins. A pin with free edges left is bright; a stranded one goes dim, which is the
    // picture of 口径 1 (the pen has nowhere to go, so the stroke is already over).
    for (const v of g.verts) {
      const p = vertexLocal(g, gm, Math.floor(v / g.cols), v % g.cols);
      const free = freeMoves(game, v).length;
      const used = g.inc[v].every((e) => game.drawn[e]);
      ctx.fillStyle = used ? 'rgba(143,162,189,0.45)' : PIN;
      if (free && game.outcome === 'playing') ctx.fillStyle = PIN_HOT;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, cell * (used ? 0.09 : 0.12)), 0, Math.PI * 2);
      ctx.fill();
      if (free && game.outcome === 'playing') {
        ctx.strokeStyle = 'rgba(244,247,251,0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(5, cell * 0.19), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // The pen head.
    if (game.cur && game.cur.verts.length) {
      const v = game.cur.verts[game.cur.verts.length - 1];
      const p = vertexLocal(g, gm, Math.floor(v / g.cols), v % g.cols);
      const ink = INK[Math.min(game.strokes.length, INK.length - 1)];
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(5, cell * 0.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (hint) hintRing();
  }

  function badge(x, y, n, ink) {
    const r = Math.max(7, gm.cell * 0.17);
    ctx.beginPath();
    ctx.arc(x - r * 0.9, y - r * 1.1, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,10,14,0.85)';
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(r * 1.2)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x - r * 0.9, y - r * 1.05);
  }

  function hintRing() {
    const t = ringPhase();
    const g = game.g;
    ctx.save();
    ctx.strokeStyle = `rgba(120,220,255,${(0.9 - t * 0.6).toFixed(3)})`;
    ctx.lineWidth = 3 + t * 5;
    ctx.lineCap = 'round';
    if (hint.edge >= 0 && hint.edge < g.m) {
      const l = lineFor(hint.edge, 2);
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    if (hint.vertex >= 0) {
      const p = vertexLocal(g, gm, Math.floor(hint.vertex / g.cols), hint.vertex % g.cols);
      ctx.beginPath();
      ctx.arc(p.x, p.y, gm.cell * (0.25 + t * 0.12), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(64, now - (last || now));
    last = now;
    let busy = false;
    if (flash > 0.01) { flash = Math.max(0, flash - dt / 320); busy = true; }
    if (hint && now >= hint.until) { hint = null; busy = true; }
    else if (hint) busy = true;
    if (drag) busy = true;
    if (busy) draw();
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  return {
    attach(next) {
      game = next;
      drag = null;
      hint = null;
      flash = 0;
      measure();
    },
    detach() { game = null; },
    measure,
    redraw: draw,
    // The gate the runtime pref flip lands on. `set` is idempotent and redraws, so a player who
    // toggles the OS switch sees the ring settle on the same frame rather than at the next hint.
    setReduceMotion(v) {
      const on = !!v;
      if (on === reduceMotion) return reduceMotion;
      reduceMotion = on;
      if (reduceMotion) draw();
      return reduceMotion;
    },
    isReducedMotion: () => reduceMotion,
    // The two mappings the spec demands of a test hook, in client pixels.
    vertexPoint(r, c) {
      const box = canvas.getBoundingClientRect();
      const g = game ? game.g : null;
      if (!g) return null;
      const p = vertexLocal(g, gm, Math.max(0, Math.min(g.rows - 1, r)), Math.max(0, Math.min(g.cols - 1, c)));
      return { x: Math.round(box.left + p.x), y: Math.round(box.top + p.y), cell: gm.cell, tol: MIN_TOL };
    },
    edgeAt(x, y) {
      if (!game) return -1;
      const box = canvas.getBoundingClientRect();
      return edgeAtLocal(game.g, gm, x - box.left, y - box.top, MIN_TOL);
    },
    vertexAt(x, y) { return game ? probe(x, y) : null; },
    // Where the pen is, in the same units the rules use — read by @pointer to tell a legal
    // stall from a bug.
    pen() {
      if (!game) return null;
      return {
        strokes: strokesUsed(game),
        par: game.par,
        covered: game.covered,
        total: game.g.m,
        outcome: game.outcome,
        holding: !!(game.cur && game.cur.edges.length),
      };
    },
    showHint(h) {
      hint = h ? { edge: h.edge, vertex: h.vertex === null ? -1 : h.vertex, until: performance.now() + 2600 } : null;
      draw();
    },
    start() {
      if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
