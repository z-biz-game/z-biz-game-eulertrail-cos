// The shipped lot pool. The game picks levels from here; it never generates them, and
// that is a measured decision — `node test/balance.mjs` says the generator costs 18-112 ms
// median and 235 ms worst case per level because the difficulty filter runs an exhaustive
// cover DP. Build that once (tools/bake.mjs), ship the result.
//
// Everything below is a pure lookup over js/data/lots.js, which is what makes the daily
// puzzle and a shared link reproducible with no state: the pool is fixed, the seed only
// chooses an index. `test/library.test.mjs` re-proves each row from its serialised spec,
// so this file is allowed to trust the data without re-checking it on every tap.

import { LOTS, TIERS_META } from '../data/lots.js';
import { compile } from './graph.js';
import { hashSeed } from './rng.js';

// Display-side band list, measured off the levels that shipped (label / blurb / ranges).
// The generation-side ladder with its search budgets lives in make.js and is not needed
// once the lots are baked.
export const TIERS = TIERS_META;

const prepared = LOTS.map((row) => ({
  id: row.id,
  tier: row.tier,
  par: row.par,
  odd: row.odd,
  edges: row.edges,
  verts: row.verts,
  forks: row.forks,
  dead: row.dead,
  badRatio: row.badRatio,
  bad: row.bad,
  openings: row.openings,
  states: row.states,
  spec: row.spec,
  trails: row.trails,
  g: compile(row.spec),
}));

export const ALL = prepared;

function pick(list, seed, salt) {
  if (!list.length) return null;
  return list[hashSeed(`${salt}|${seed}`) % list.length];
}

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

export function lotsIn(key) {
  return prepared.filter((l) => l.tier === key);
}

export function byId(id) {
  return prepared.find((l) => l.id === id) || null;
}

// The campaign: every baked lot, lowest band first and inside a band the *hardest* first —
// which is exactly the order tools/bake.mjs wrote them in (badRatio descending), so level
// 1 of a band is the one where the first move is most likely to be wrong.
export function campaign() {
  return prepared;
}

export function levelAt(index) {
  const n = prepared.length;
  return prepared[((Math.trunc(Number(index)) || 0) % n + n) % n];
}

// Endless play inside one band. A seed only chooses an index, so `#/random/four/abc` is the
// same level for everybody.
export function randomLot(seed, tierKey) {
  const list = tierKey ? lotsIn(tierKey) : prepared;
  return pick(list, seed, 'random');
}

// One puzzle per calendar day, the same for everyone, drawn from the whole pool.
export function dailyLot(dateKey) {
  return pick(prepared, dateKey, 'daily');
}

function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

function span(xs) {
  return { min: Math.min(...xs), max: Math.max(...xs), med: median(xs.slice().sort((a, b) => a - b)) };
}

// What the shipped pool actually contains, measured rather than claimed. The harness prints
// this so a re-bake that quietly loses difficulty shows up as a moved range instead of a
// shrug: `par` is fixed per band by the theorem, so the columns that can rot are the side
// dimensions (forks, dead ends) and the measured wrong-first-move share.
export function stats() {
  const byTier = {};
  for (const l of prepared) {
    const s = byTier[l.tier] || (byTier[l.tier] = { n: 0, par: [], edges: [], verts: [], forks: [], dead: [], badRatio: [], states: [] });
    s.n++;
    s.par.push(l.par);
    s.edges.push(l.edges);
    s.verts.push(l.verts);
    s.forks.push(l.forks);
    s.dead.push(l.dead);
    s.badRatio.push(l.badRatio);
    s.states.push(l.states);
  }
  for (const [key, s] of Object.entries(byTier)) {
    byTier[key] = {
      n: s.n,
      par: span(s.par),
      edges: span(s.edges),
      verts: span(s.verts),
      forks: span(s.forks),
      dead: span(s.dead),
      badRatio: span(s.badRatio.map((x) => Math.round(x * 1000) / 1000)),
      states: span(s.states),
    };
  }
  const pars = prepared.map((l) => l.par);
  return {
    lots: prepared.length,
    par: { min: Math.min(...pars), max: Math.max(...pars) },
    tiers: Object.keys(byTier).length,
    byTier,
  };
}
