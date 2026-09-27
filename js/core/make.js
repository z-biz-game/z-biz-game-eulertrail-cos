// The generator. There is no hand-authored level file in this repo, and that is
// deliberate: a level is only worth offering once a theorem says how many strokes it takes
// and a construction says that number is reachable.
//
// This runs at build time (tools/bake.mjs), never on tap — see that file and test/balance.mjs
// for the measured cost. Nothing in the shipped game imports it.
//
// How a level is made:
//
//   1. grow a connected region of lattice pins edge by edge (a random spanning tree over a
//      randomly growing set of pins), so connectivity is structural and cannot fail;
//   2. close extra unit cycles inside the region one edge at a time. Each added edge flips
//      the parity of its two endpoints, so `odd` moves by -2, 0 or +2 and the running prefix
//      lengths that land in the band are the candidates — the knob *is* the odd-degree
//      count, which is what makes `par` a dial rather than a wish;
//   3. filter on the side dimensions, because the parity band alone accepts nearly anything
//      and "high acceptance plus unknown difficulty" is this repo's real risk:
//        - `forks`: vertices of degree >= 3, i.e. how many places the pen has to choose;
//        - `dead`: the longest degree-2 chain hanging off a dead end, i.e. how much of the
//          level is corridor rather than decision;
//        - `badRatio`: measured, not guessed — the share of *oriented first moves* from
//          which no par-stroke cover exists any more (js/core/bruteforce.js). This is the
//          only filter that says "a player can lose this level on the very first drag";
//        - `dead` openings must be zero: an opening that cannot be completed at all is a
//          design defect, not difficulty, since the rules give no way to un-draw an edge.
//
// The thresholds below were read off the distribution `node test/balance.mjs` prints, not
// picked. That rig stays in the repo so the bands stay checkable.

import { compile, validate, toSpec } from './graph.js';
import { par } from './theory.js';
import { firstMoveAudit, exhaustiveAllowed } from './bruteforce.js';
import { coverWith } from './construct.js';
import { rngFrom } from './rng.js';

// Every unit lattice segment of a rows x cols point grid, in a fixed order. Memoised: it is
// a pure function of the dimensions and the generator asks for it thousands of times.
const latticeCache = new Map();

export function latticeEdges(rows, cols) {
  const key = `${rows}x${cols}`;
  const hit = latticeCache.get(key);
  if (hit) return hit;
  const edges = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = r * cols + c;
      if (c + 1 < cols) edges.push([v, v + 1]);
      if (r + 1 < rows) edges.push([v, v + cols]);
    }
  }
  const pack = { rows, cols, edges };
  latticeCache.set(key, pack);
  return pack;
}

function neighboursOf(rows, cols) {
  const key = `n${rows}x${cols}`;
  const hit = latticeCache.get(key);
  if (hit) return hit;
  const total = rows * cols;
  const nbrs = Array.from({ length: total }, () => []);
  const { edges } = latticeEdges(rows, cols);
  edges.forEach((e, i) => { nbrs[e[0]].push([e[1], i]); nbrs[e[1]].push([e[0], i]); });
  latticeCache.set(key, nbrs);
  return nbrs;
}

// Step 1a: a compact set of pins. Growing a *tree* directly gives long thin snakes whose
// induced graph has almost no chords, and the parity walk in step 2 then has nothing to
// play with — that version measured 0/12 accepted seeds on every tier. Growing the vertex
// set compactly (prefer the boundary point with the most neighbours already inside, with a
// 35% chance of a wild pick so shapes stay irregular) makes the induced graph chord-rich,
// which is what `odd` needs to be steerable at all.
export function growRegion(rng, rows, cols, nv) {
  const nbrs = neighboursOf(rows, cols);
  const total = rows * cols;
  const inside = new Uint8Array(total);
  const start = rng.int(total);
  inside[start] = 1;
  let count = 1;
  let boundary = nbrs[start].map(([w]) => w).filter((w) => !inside[w]);
  while (count < nv) {
    if (!boundary.length) return null;
    let pick;
    if (rng.chance(0.35)) {
      pick = boundary[rng.int(boundary.length)];
    } else {
      let bestScore = -1;
      let best = [];
      for (const w of boundary) {
        let s = 0;
        for (const [x] of nbrs[w]) if (inside[x]) s++;
        if (s > bestScore) { bestScore = s; best = [w]; } else if (s === bestScore) best.push(w);
      }
      pick = rng.pick(best);
    }
    inside[pick] = 1;
    count++;
    boundary = boundary.filter((w) => w !== pick);
    for (const [x] of nbrs[pick]) if (!inside[x] && !boundary.includes(x)) boundary.push(x);
  }
  return inside;
}

// Step 1b: a random spanning tree of the induced subgraph (randomised Prim over the region),
// so the leftover induced edges are exactly the chords the parity walk plays.
export function growTree(rng, rows, cols, nv) {
  const { edges } = latticeEdges(rows, cols);
  const nbrs = neighboursOf(rows, cols);
  const inside = growRegion(rng, rows, cols, nv);
  if (!inside) return null;
  const induced = [];
  edges.forEach((e, i) => { if (inside[e[0]] && inside[e[1]]) induced.push(i); });
  const inTree = new Uint8Array(edges.length);
  const tree = [];
  const start = induced.length ? edges[induced[0]][0] : -1;
  if (start < 0) return null;
  const taken = new Uint8Array(inside.length);
  taken[start] = 1;
  let count = 1;
  let frontier = [];
  const push = (v) => {
    for (const [w, ei] of nbrs[v]) if (inside[w] && !taken[w]) frontier.push(ei);
  };
  push(start);
  while (count < nv && frontier.length) {
    const at = rng.int(frontier.length);
    const ei = frontier[at];
    frontier[at] = frontier[frontier.length - 1];
    frontier.pop();
    if (inTree[ei]) continue;
    const [a, b] = edges[ei];
    const w = taken[a] ? b : taken[b] ? a : -1;
    if (w < 0) continue;
    taken[w] = 1;
    inTree[ei] = 1;
    tree.push(ei);
    count++;
    push(w);
  }
  if (count < nv) return null;
  const extra = induced.filter((i) => !inTree[i]);
  rng.shuffle(extra);
  return { tree, extra, inside };
}

// Longest corridor of degree-2 pins leading away from a dead end.
function deadChainFrom(g, start) {
  let len = 0;
  let cur = start;
  let came = -1;
  const seen = new Set([cur]);
  for (;;) {
    let next = -1;
    let e = -1;
    for (const ei of g.inc[cur]) {
      if (ei === came) continue;
      const w = g.ea[ei] === cur ? g.eb[ei] : g.ea[ei];
      if (seen.has(w)) continue;
      e = ei;
      next = w;
      break;
    }
    if (e < 0) break;
    len++;
    if (g.deg[next] !== 2) break;
    seen.add(next);
    came = e;
    cur = next;
  }
  return len;
}

// Shape metrics — the side dimensions the bands filter on.
export function shapeStats(g) {
  let forks = 0;
  let leaves = 0;
  for (const v of g.verts) {
    if (g.deg[v] >= 3) forks++;
    if (g.deg[v] === 1) leaves++;
  }
  let dead = 0;
  for (const v of g.verts) {
    if (g.deg[v] !== 1) continue;
    const len = deadChainFrom(g, v);
    if (len > dead) dead = len;
  }
  return { forks, leaves, dead };
}

// Step 2: walk the parity up or down to the target odd-count instead of hoping a random
// prefix lands there. Adding a unit edge flips the parity of both endpoints, so an
// even-even edge lifts `odd` by 2, an odd-odd edge drops it by 2 and an odd-even edge is
// neutral — which makes the target reachable deliberately:
//
//   odd < target   play an even-even edge
//   odd > target   play an odd-odd edge
//   odd === target optionally play neutral edges to reach a denser, less corridor-like
//                  picture without moving `par`
//
// Every state on the walk whose odd count *and* edge count are in band is a candidate; the
// last (densest) one wins, so levels land at the top of their edge band.
function parityWalk(pack, chosen, extra, target, edges, rng) {
  const parity = new Map(); // vertex -> degree so far
  const bump = (v) => parity.set(v, (parity.get(v) || 0) + 1);
  for (const i of chosen) { bump(pack.edges[i][0]); bump(pack.edges[i][1]); }
  let odd = 0;
  for (const [, d] of parity) if (d % 2 === 1) odd++;
  const pool = extra.slice();
  let best = null;
  const take = (want) => {
    // `want` is +1 (need even-even), -1 (need odd-odd) or 0 (need neutral).
    const hits = [];
    for (let i = 0; i < pool.length; i++) {
      const [a, b] = pack.edges[pool[i]];
      const pa = (parity.get(a) || 0) % 2;
      const pb = (parity.get(b) || 0) % 2;
      if (want > 0 && pa === 0 && pb === 0) hits.push(i);
      else if (want < 0 && pa === 1 && pb === 1) hits.push(i);
      else if (want === 0 && pa !== pb) hits.push(i);
    }
    if (!hits.length) return -1;
    const at = rng.pick(hits);
    const e = pool[at];
    pool.splice(at, 1);
    return e;
  };
  const record = () => {
    const m = chosen.length;
    if (odd === target && m >= edges[0] && m <= edges[1]) best = { chosen: chosen.slice(), odd, m };
  };
  record();
  let guard = 0;
  while (chosen.length < edges[1] && guard++ < 200) {
    const want = odd < target ? 1 : odd > target ? -1 : 0;
    if (want === 0 && !rng.chance(0.8)) break; // stop densifying sometimes, so bands keep a spread
    const e = take(want);
    if (e < 0) break;
    chosen.push(e);
    bump(pack.edges[e][0]);
    bump(pack.edges[e][1]);
    odd += want > 0 ? 2 : want < 0 ? -2 : 0;
    record();
  }
  return best;
}

function specOf(pack, chosen) {
  const edges = chosen.map((i) => pack.edges[i].slice());
  return { rows: pack.rows, cols: pack.cols, edges, verts: Array.from(new Set(edges.flat())).sort((a, b) => a - b) };
}

function attempt(seed, tier, stats) {
  const rng = rngFrom(`${tier.key}|${seed}`);
  const pack = latticeEdges(tier.rows, tier.cols);
  const hit = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  for (let inner = 0; inner < tier.probes; inner++) {
    const nv = rng.range(tier.nv[0], tier.nv[1]);
    const grown = growTree(rng, tier.rows, tier.cols, nv);
    if (!grown) { hit('nofit'); continue; }
    const walked = parityWalk(pack, grown.tree.slice(), grown.extra, tier.odd[0], tier.edges, rng);
    if (!walked || walked.m < tier.edges[0]) { hit('offBand'); continue; }
    const spec = specOf(pack, walked.chosen);
    const g = compile(spec);
    const cand = { spec, g, odd: walked.odd };
    if (!exhaustiveAllowed(g)) { hit('tooBigToCertify'); continue; }
    const p = par(g);
    if (p < tier.par[0] || p > tier.par[1]) { hit('parBand'); continue; }
    const sh = shapeStats(g);
    if (sh.forks < tier.minForks) { hit('tooFlat'); continue; }
    if (sh.dead > tier.maxDead) { hit('tooCorridory'); continue; }
    const err = validate(toSpec(cand.g), { odd: cand.odd, par: p });
    if (err) { hit('invalid'); continue; }
    const audit = firstMoveAudit(g, { budgetMs: tier.auditMs || 3000 });
    if (!audit.ok) { hit('auditTruncated'); continue; }
    if (audit.min !== p) { hit('auditDisagrees'); continue; }
    if (audit.dead) { hit('deadOpening'); continue; }
    if (audit.badRatio < tier.minBadRatio) { hit('tooObvious'); continue; }
    const cov = coverWith(cand.g, { rng: rngFrom(`${seed}|cover`) });
    if (!cov.ok) { hit('constructFailed'); if (stats) stats.lastError = cov.error; continue; }
    return {
      spec: toSpec(cand.g),
      trails: cov.trails,
      rating: {
        par: p, odd: cand.odd, edges: cand.g.m, verts: cand.g.verts.length,
        forks: sh.forks, dead: sh.dead, leaves: sh.leaves,
        badRatio: audit.badRatio, openings: audit.total, bad: audit.bad,
        dpStates: audit.states,
      },
      seed,
      tier: tier.key,
    };
  }
  hit('exhausted');
  return null;
}

// makeLot(seed, tier, stats?) -> { spec, trails, rating } | null, deterministic in the seed.
export function makeLot(seed, tier, stats) {
  for (let i = 0; i < tier.restarts; i++) {
    const out = attempt(`${seed}#${i}`, tier, stats);
    if (out) {
      if (stats) stats.found = (stats.found || 0) + 1;
      return out;
    }
  }
  if (stats) stats.gaveUp = (stats.gaveUp || 0) + 1;
  return null;
}

// The generation ladder: four bands, separated first by `par` (a theorem's value, so the
// bands cannot overlap by construction) and then by the measured side dimensions.
//
// Every `minBadRatio` below is the p25 of that band's measured badRatio column in
// `node test/balance.mjs` (40 seeds per band, 40/40 accepted before the cut):
//
//   tandem 0.40 0.50 0.58 0.64 0.69   ->  cut 0.50
//   three  0.22 0.36 0.42 0.46 0.58   ->  cut 0.36
//   four   0.10 0.25 0.31 0.38 0.50   ->  cut 0.25
//   five   0.08 0.15 0.21 0.29 0.36   ->  cut 0.15
//
// The cut goes *down* as par rises because that is what the theorem does to the picture:
// more strokes means more openings that are still winnable, so a fixed floor would empty
// the top bands. `five` at 0.08 is the case the filter exists for — a 5-stroke level where
// the first move cannot be wrong is not hard, it is long.
//
// `minForks` is par + 1, which is not a taste call either: for a connected unit-lattice
// graph (max degree 4) the identity `odd = 2 * (1 + forks - cycles)` — asserted on 1000
// random graphs in test/theory.test.mjs — forces forks = par - 1 + cycles, so minForks is
// the statement "at least two independent cycles, i.e. this is not a tree with a chord".
// `edges` tops out at 14 so js/core/bruteforce.js certifies *every* shipped level rather
// than a sampled subset.
export const TIERS = [
  {
    key: 'tandem', label: '双笔', par: [2, 2], odd: [4, 4], rows: 8, cols: 8,
    nv: [7, 12], edges: [9, 14], minForks: 3, maxDead: 2, minBadRatio: 0.50,
    probes: 14, restarts: 30,
  },
  {
    key: 'three', label: '三笔', par: [3, 3], odd: [6, 6], rows: 8, cols: 8,
    nv: [7, 12], edges: [9, 14], minForks: 4, maxDead: 2, minBadRatio: 0.36,
    probes: 14, restarts: 30,
  },
  {
    key: 'four', label: '四笔', par: [4, 4], odd: [8, 8], rows: 8, cols: 8,
    nv: [7, 13], edges: [9, 14], minForks: 5, maxDead: 2, minBadRatio: 0.25,
    probes: 14, restarts: 30,
  },
  {
    key: 'five', label: '五笔', par: [5, 5], odd: [10, 10], rows: 8, cols: 8,
    nv: [8, 13], edges: [10, 14], minForks: 6, maxDead: 2, minBadRatio: 0.15,
    probes: 14, restarts: 30,
  },
];

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}
