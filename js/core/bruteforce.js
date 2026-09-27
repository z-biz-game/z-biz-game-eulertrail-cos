// The "and no fewer" half, computed rather than quoted.
//
// DP over (remaining edge set, where the pen currently is):
//
//   f(mask, cur) = minimum number of *new* strokes still needed
//                = min over unused edges e at cur of f(mask \ e, other(e, cur))       (extend, free)
//                  min over unused edges e = (a,b) anywhere of 1 + f(mask \ e, other)  (lift, new stroke)
//
// The mask strictly shrinks, so the recursion is a DAG and memoised recursion is exact —
// no iterative deepening, no heuristic, no budget that quietly makes the answer smaller.
// `f(all, -1)` is the true minimum stroke count for that graph.
//
// This is the only place in the repo that can say "fewer than par is impossible" without
// quoting Euler, which is why the three-way reconciliation (theorem / construction / this)
// is the centre of test/bruteforce.test.mjs. Cost is 2^m * |V| states, so `maxEdges`
// bounds it: everything shipped here has at most 14 edges and is therefore exhaustively
// certified, and `budgetMs` is a belt-and-braces guard for anything called on a bigger
// graph (the answer then comes back `truncated: true` and must not be printed anywhere).

import { par } from './theory.js';

export const MAX_EDGES = 14;

export function exhaustiveAllowed(g) {
  return g.m <= MAX_EDGES;
}

function makeDP(g, opts = {}) {
  const budgetMs = opts.budgetMs || 4000;
  const stateCap = opts.stateCap || 400000;
  const m = g.m;
  const full = (1 << m) - 1;
  const stride = g.n + 1;
  const memo = new Map();
  const inc = g.inc;
  const ea = g.ea;
  const eb = g.eb;
  const deadline = Date.now() + budgetMs;
  let truncated = false;

  const f = (mask, cur) => {
    if (truncated) return Infinity;
    if (mask === 0) return 0;
    if (memo.size > stateCap || Date.now() > deadline) {
      truncated = true;
      return Infinity;
    }
    const key = mask * stride + cur + 1;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    if (cur >= 0) {
      const list = inc[cur];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!(mask & (1 << e))) continue;
        const r = f(mask ^ (1 << e), ea[e] === cur ? eb[e] : ea[e]);
        if (r < best) best = r;
      }
    }
    for (let e = 0; e < m; e++) {
      if (!(mask & (1 << e))) continue;
      const rest = mask ^ (1 << e);
      let r = f(rest, eb[e]);
      if (r + 1 < best) best = r + 1;
      r = f(rest, ea[e]);
      if (r + 1 < best) best = r + 1;
    }
    memo.set(key, best);
    return best;
  };

  return {
    f, full, m,
    states: () => memo.size,
    truncated: () => truncated,
  };
}

// minTrails(g) -> { ok, trails, states, truncated, error? }
export function minTrails(g, opts = {}) {
  if (g.m > MAX_EDGES && opts.force !== true) {
    return { ok: false, error: `${g.m} edges is past the ${MAX_EDGES}-edge exhaustive cap`, trails: -1, truncated: false, states: 0 };
  }
  const dp = makeDP(g, opts);
  const best = dp.f(dp.full, -1);
  if (dp.truncated()) return { ok: false, error: 'out of budget', trails: -1, truncated: true, states: dp.states() };
  if (best === Infinity) return { ok: false, error: 'no cover exists', trails: -1, truncated: false, states: dp.states() };
  return { ok: true, trails: best, truncated: false, states: dp.states() };
}

// Audit every possible first move, exactly.
//
// For each *oriented* first edge (start at a, draw a-b is a different opening from start
// at b, draw b-a) the optimal remaining count is 1 + f(all \ e, far end). Three outcomes:
//
//   value === par   the opening is still winnable at par
//   value >  par    a wrong first move: the player has thrown the level away
//   value === inf   a dead opening (no cover at all) — a design defect, never shipped
//
// `badRatio` is the measured "错首手比例" the tiers are filtered on, and it is the one
// number in this repo that means "you can actually get this wrong": a graph with
// badRatio 0 is a puzzle you can't lose, no matter how many odd vertices it has.
export function firstMoveAudit(g, opts = {}) {
  const dp = makeDP(g, opts);
  const whole = dp.f(dp.full, -1);
  if (dp.truncated()) {
    return { ok: false, truncated: true, states: dp.states(), par: par(g), min: -1, total: 0, bad: 0, good: 0, dead: 0, badRatio: 0, deadRatio: 0, openings: [] };
  }
  const want = par(g);
  const openings = [];
  for (let e = 0; e < dp.m; e++) {
    const a = g.ea[e], b = g.eb[e];
    const rest = dp.full ^ (1 << e);
    openings.push({ edge: e, from: a, to: b, strokes: 1 + dp.f(rest, b) });
    openings.push({ edge: e, from: b, to: a, strokes: 1 + dp.f(rest, a) });
  }
  let bad = 0;
  let dead = 0;
  let good = 0;
  for (const o of openings) {
    if (o.strokes === Infinity) dead++;
    else if (o.strokes > want) bad++;
    else good++;
  }
  return {
    ok: true,
    truncated: false,
    states: dp.states(),
    par: want,
    min: whole,
    total: openings.length,
    bad,
    good,
    dead,
    badRatio: openings.length ? bad / openings.length : 0,
    deadRatio: openings.length ? dead / openings.length : 0,
    openings,
  };
}
