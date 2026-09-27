// The content pipeline. This is where the game's levels come from — the browser never
// generates a graph, it only picks one.
//
// Why offline: `node test/balance.mjs` measures the generator at 18-112 ms median and
// 235 ms worst case per level, because the filter runs an exhaustive stroke-cover DP over
// 2^m * |V| states. That is a perfectly good build step and an unacceptable thing to do
// after a tap. So the generator runs here once, three independent paths certify every
// level it emits, and what ships is the measured set.
//
//   node tools/bake.mjs                    # js/data/lots.js, 12 levels per band
//   PER_TIER=24 node tools/bake.mjs
//
// A level enters the file only if, re-reading the **serialised** spec:
//   * `validate` accepts it with the declared { odd, par} attached,
//   * `odd` is even (handshake) and `par === max(1, odd/2)`,
//   * `construct` produces exactly `par` edge-disjoint strokes covering every edge,
//   * and — since every shipped level has at most 14 edges — the exhaustive DP agrees that
//     `par` strokes is the true minimum, so fewer is provably not enough.
// Anything that fails is a thrown error, not a dropped level: a silent filter here would
// let a stale band definition ship.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, makeLot, shapeStats } from '../js/core/make.js';
import { compile, validate, toSpec } from '../js/core/graph.js';
import { par, oddCount } from '../js/core/theory.js';
import { coverWith, verify } from '../js/core/construct.js';
import { minTrails, exhaustiveAllowed } from '../js/core/bruteforce.js';
import { rngFrom } from '../js/core/rng.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_TIER = Number(process.env.PER_TIER || 12);

function signature(spec) {
  return `${spec.rows}x${spec.cols}:` + spec.edges.map(([a, b]) => `${a}-${b}`).sort().join('|');
}

const out = [];
for (const tier of TIERS) {
  const seen = new Set();
  const picked = [];
  const t0 = Date.now();
  for (let s = 0; picked.length < PER_TIER && s < PER_TIER * 40; s++) {
    const lot = makeLot(`bake-${tier.key}-${s}`, tier);
    if (!lot) continue;
    const spec = lot.spec;
    const err = validate(spec, { odd: lot.rating.odd, par: lot.rating.par });
    if (err) throw new Error(`${tier.key}: generator emitted an illegal level: ${err}`);
    const sig = signature(spec);
    if (seen.has(sig)) continue;

    // Re-read from the serialised form: nothing below may use the generator's in-memory graph.
    const back = JSON.parse(JSON.stringify(spec));
    const g = compile(back);
    const o = oddCount(g);
    const p = par(g);
    if (o !== lot.rating.odd || p !== lot.rating.par) {
      throw new Error(`${tier.key}: serialised level says odd ${o}/par ${p}, generator said ${lot.rating.odd}/${lot.rating.par}`);
    }
    const cov = coverWith(g, { rng: rngFrom(`bake-cert-${tier.key}-${s}`) });
    if (!cov.ok) throw new Error(`${tier.key}: construction failed on a shipped level: ${cov.error}`);
    if (cov.trails.length !== p) throw new Error(`${tier.key}: ${cov.trails.length} strokes built, theorem says ${p}`);
    if (verify(g, cov.trails)) throw new Error(`${tier.key}: verify rejected its own cover`);
    let brute = { ok: true, trails: p, states: 0, skipped: true };
    if (exhaustiveAllowed(g)) {
      brute = minTrails(g);
      if (!brute.ok) throw new Error(`${tier.key}: exhaustive cover DP failed: ${brute.error}`);
      if (brute.trails !== p) throw new Error(`${tier.key}: DP says ${brute.trails} strokes, theorem says ${p}`);
    } else {
      throw new Error(`${tier.key}: ${g.m} edges is past the exhaustive cap, so this level cannot ship`);
    }
    const sh = shapeStats(g);
    seen.add(sig);
    picked.push({
      id: `${tier.key}-${String(picked.length + 1).padStart(2, '0')}`,
      tier: tier.key,
      par: p,
      odd: o,
      edges: g.m,
      verts: g.verts.length,
      forks: sh.forks,
      dead: sh.dead,
      badRatio: Number(lot.rating.badRatio.toFixed(3)),
      bad: lot.rating.bad,
      openings: lot.rating.openings,
      states: brute.states,
      spec: back,
      trails: cov.trails.map((t) => ({ verts: t.verts, edges: t.edges })),
    });
    process.stdout.write(`\r${tier.key}: ${picked.length}/${PER_TIER}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  }
  process.stdout.write(`\n`);
  if (picked.length < PER_TIER) console.error(`warn: ${tier.key} only reached ${picked.length} levels`);
  // Within a band the curve is the measured wrong-first-move share, hardest first.
  picked.sort((a, b) => b.badRatio - a.badRatio || a.edges - b.edges);
  picked.forEach((l, i) => { l.id = `${tier.key}-${String(i + 1).padStart(2, '0')}`; });
  out.push(...picked);
}

// The bands the UI prints are measured off the levels that actually shipped.
const span = (xs) => [Math.min(...xs), Math.max(...xs)];
const meta = TIERS.map((t) => {
  const mine = out.filter((l) => l.tier === t.key);
  const pars = span(mine.map((l) => l.par));
  const [eLo, eHi] = span(mine.map((l) => l.edges));
  const [fLo, fHi] = span(mine.map((l) => l.forks));
  const [dLo, dHi] = span(mine.map((l) => l.dead));
  const [bLo, bHi] = span(mine.map((l) => l.badRatio));
  return {
    key: t.key,
    label: t.label,
    par: t.par[0],
    min: pars[0],
    max: pars[1],
    edges: [eLo, eHi],
    verts: span(mine.map((l) => l.verts)),
    forks: [fLo, fHi],
    dead: [dLo, dHi],
    badRatio: [Number(bLo.toFixed(2)), Number(bHi.toFixed(2))],
    cut: t.minBadRatio,
    n: mine.length,
    blurb: `${t.par[0]} 笔 · ${eLo}-${eHi} 条边 · 错首手 ${(bLo * 100).toFixed(0)}-${(bHi * 100).toFixed(0)}%`,
  };
});

const lines = [
  '// Generated by tools/bake.mjs — the levels in this game are theorems checked three ways,',
  '// not opinions. On every row: `odd` is the odd-degree count of `spec`, `par` is',
  '// max(1, odd/2), and `trails` is a constructed cover of every edge by exactly `par`',
  '// edge-disjoint strokes. `node test/library.test.mjs` recomputes all of it from the',
  '// serialised spec and fails if a row and its numbers ever disagree — so re-run',
  '// `node tools/bake.mjs` instead of hand-editing.',
  `export const TIERS_META = ${JSON.stringify(meta)};`,
  'export const LOTS = [',
  ...out.map((l) => `  ${JSON.stringify(l)},`),
  '];',
  '',
];
const path = join(root, 'js', 'data', 'lots.js');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, lines.join('\n'));

const byTier = {};
for (const l of out) byTier[l.tier] = (byTier[l.tier] || 0) + 1;
console.log(`wrote ${out.length} levels (${Object.entries(byTier).map(([k, n]) => `${k}:${n}`).join(' ')}) -> js/data/lots.js`);
