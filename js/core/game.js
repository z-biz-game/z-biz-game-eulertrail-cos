// A game in progress: pure state plus the rules that touch it. No DOM anywhere in here,
// which is what lets test/game.test.mjs and tools/playtest.mjs drive the same object the
// screen does.
//
// The three口径 the whole repo is built on, all enforced here and nowhere else:
//
//   1. A stroke is a *trail*: edges may not repeat, vertices may. The pen may only move
//      along an undrawn edge, and the stroke ends by itself the moment the vertex it is
//      standing on has no undrawn neighbour left (spec 0.1 — this is the theorem's premise,
//      so it is not a courtesy rule but the model itself).
//   2. Dragging over an already drawn edge does nothing: no extra coverage, no error, no
//      penalty. It is reported as `{ ok: false, reason: 'drawn' }` so the view can flash a
//      hint without the rules pretending anything went wrong.
//   3. Lifting the pen early is legal. An unfinished stroke is committed as-is and the next
//      stroke may start immediately; only the *stroke budget* judges you, never the fact
//      that you released mid-trail.

import { compile, edgeBetween, otherEnd } from './graph.js';
import { par as theoryPar, oddCount } from './theory.js';

export function createGame(lot) {
  const g = lot.g || compile(lot.spec);
  return {
    id: lot.id,
    tier: lot.tier,
    g,
    par: Number.isFinite(lot.par) ? lot.par : theoryPar(g),
    odd: Number.isFinite(lot.odd) ? lot.odd : oddCount(g),
    // The baked `par`-stroke cover from construct.js — the proof that the budget shown on
    // screen is reachable, and what the hint walks the player along.
    baked: (lot.trails || []).map((t) => ({ verts: t.verts.slice(), edges: t.edges.slice() })),
    drawn: new Uint8Array(g.m),
    covered: 0,
    strokes: [],   // committed: { verts, edges, natural }
    cur: null,     // in progress: { verts, edges }
    outcome: 'playing',
    events: [],    // a small audit trail the tests read: {type, ...}
  };
}

function log(game, ev) {
  game.events.push(ev);
  if (game.events.length > 400) game.events.shift();
}

// Undrawn edges out of `v`: where the pen could still go from here.
export function freeMoves(game, v) {
  const g = game.g;
  const out = [];
  if (v < 0 || v >= g.n) return out;
  for (const e of g.inc[v]) {
    if (!game.drawn[e]) out.push({ edge: e, to: otherEnd(g, e, v) });
  }
  return out;
}

// The on-screen "已用笔数". A press that has not drawn yet is still a stroke in the air:
// beginStroke() opened it (see the note there: "a fresh press is a fresh stroke"), the pen
// is on the paper, and the budget line "还能用 par - strokesUsed" must reserve a stroke for
// it. What is *never* billed is a press that gets lifted without ever moving — endStroke
// below drops it without committing, and it leaves the board exactly as it found it.
export function strokesUsed(game) {
  return game.strokes.length + (game.cur ? 1 : 0);
}

// Called by the view on pointerdown. Always closes an in-progress stroke first, so a fresh
// press is a fresh stroke even when the player never lifted the button (pointer capture
// lost, for instance).
export function beginStroke(game, v) {
  if (game.outcome === 'won') {
    log(game, { type: 'blocked', why: 'complete' });
    return { ok: false, reason: 'complete' };
  }
  if (game.cur) endStroke(game);
  if (game.covered === game.g.m) {
    log(game, { type: 'blocked', why: 'complete' });
    return { ok: false, reason: 'complete' };
  }
  if (!freeMoves(game, v).length) {
    log(game, { type: 'off', vertex: v });
    return { ok: false, reason: 'no undrawn edge at that vertex' };
  }
  game.cur = { verts: [v], edges: [] };
  log(game, { type: 'begin', vertex: v });
  return { ok: true, vertex: v };
}

// Extend the current stroke to a neighbouring vertex. This is the only place an edge gets
// marked drawn.
export function stepTo(game, v) {
  if (!game.cur) return { ok: false, reason: 'no stroke in progress' };
  if (game.outcome === 'won') return { ok: false, reason: 'complete' };
  const g = game.g;
  const at = game.cur.verts[game.cur.verts.length - 1];
  if (v === at) return { ok: false, reason: 'same vertex' };
  const e = edgeBetween(g, at, v);
  if (e < 0) {
    log(game, { type: 'off', from: at, to: v });
    return { ok: false, reason: 'no edge between those pins' };
  }
  if (game.drawn[e]) {
    // 口径 2: drawing over an edge again does not "un-draw" or double-count it.
    log(game, { type: 'again', edge: e });
    return { ok: false, reason: 'drawn', edge: e };
  }
  game.drawn[e] = 1;
  game.covered++;
  game.cur.verts.push(v);
  game.cur.edges.push(e);
  const stranded = freeMoves(game, v).length === 0;
  log(game, { type: 'step', edge: e, vertex: v, stranded });
  if (stranded) {
    // 口径 1: the stroke ends by itself, so the player can press again right away.
    endStroke(game);
    judge(game);
    return { ok: true, edge: e, vertex: v, autoEnded: true };
  }
  return { ok: true, edge: e, vertex: v, autoEnded: false };
}

// Lift the pen. A stroke that never moved is not billed.
export function endStroke(game) {
  const cur = game.cur;
  game.cur = null;
  if (!cur || !cur.edges.length) return { committed: false };
  game.strokes.push({ verts: cur.verts.slice(), edges: cur.edges.slice(), natural: false });
  log(game, { type: 'lift', edges: cur.edges.length });
  judge(game);
  return { committed: true, index: game.strokes.length - 1 };
}

// Win needs every edge covered *within* the theorem's budget; going past it loses, but the
// board stays playable so nothing here ever throws or freezes (spec: 判负但不崩).
function judge(game) {
  if (game.outcome === 'won') return;
  if (game.strokes.length > game.par) {
    if (game.outcome !== 'lost') log(game, { type: 'lost', strokes: game.strokes.length, par: game.par });
    game.outcome = 'lost';
    return;
  }
  if (game.covered === game.g.m) game.outcome = 'won';
}

// Take the last committed stroke back off the board. The budget judgement is re-run rather
// than assumed: undoing one stroke of a five-stroke mess on a two-stroke level is still a
// loss, and pretending otherwise would let the screen show "playing" over an exhausted
// budget.
export function undoStroke(game) {
  const last = game.strokes.pop();
  if (!last) return false;
  for (const e of last.edges) {
    if (game.drawn[e]) { game.drawn[e] = 0; game.covered--; }
  }
  game.cur = null;
  game.outcome = 'playing';
  judge(game);
  log(game, { type: 'undo', edges: last.edges.length, outcome: game.outcome });
  return true;
}

export function reset(game) {
  game.drawn = new Uint8Array(game.g.m);
  game.covered = 0;
  game.strokes = [];
  game.cur = null;
  game.outcome = 'playing';
  game.events = [];
}

// The hint walks the baked `par`-stroke cover rather than re-solving: there is nothing to
// re-solve, since construct.js already proved the budget reachable and bake.mjs re-ran the
// verification on the serialised level. When the recommended stroke is still fully undrawn
// it is guaranteed playable; once the player has diverged inside it, the hint says so
// instead of naming a move that no longer exists.
export function hint(game) {
  if (game.outcome === 'won') return null;
  const g = game.g;
  for (let i = 0; i < game.baked.length; i++) {
    const t = game.baked[i];
    const firstOpen = t.edges.findIndex((e) => !game.drawn[e]);
    if (firstOpen < 0) continue;
    if (firstOpen === 0) {
      return {
        stroke: i + 1,
        vertex: t.verts[0],
        edge: t.edges[0],
        to: t.verts[1],
        kind: 'fresh',
        left: game.baked.length - game.strokes.length,
      };
    }
    return {
      stroke: i + 1,
      vertex: null,
      edge: t.edges[firstOpen],
      to: -1,
      kind: 'diverged',
      note: `第 ${i + 1} 笔已经画过一部分，接着画高亮的那条边`,
    };
  }
  // Every baked stroke is drawn through, yet edges remain: only possible if the player drew
  // edges in an order the baked cover never uses. Point at any undrawn edge instead.
  const e = Array.from(game.drawn).findIndex((d) => !d);
  if (e < 0) return null;
  return { stroke: strokesUsed(game) + 1, vertex: g.ea[e], edge: e, to: g.eb[e], kind: 'any', left: -1 };
}

// Grades are theorem-derived: covering everything takes at least `par` strokes, so hitting
// `par` is the ceiling and anything past it is a loss rather than a lesser win.
export function grade(game) {
  if (game.outcome === 'won') {
    if (game.strokes.length !== game.par) return { key: 'impossible', label: '定理出错了', stars: 0 };
    return { key: 'perfect', label: '一笔不浪费', stars: 3 };
  }
  if (game.outcome === 'lost') return { key: 'over', label: '超过笔数上限', stars: 0 };
  return { key: 'open', label: '还没画完', stars: 0 };
}

export function snapshot(game) {
  return {
    covered: game.covered,
    total: game.g.m,
    strokes: game.strokes.length,
    par: game.par,
    odd: game.odd,
    outcome: game.outcome,
  };
}
