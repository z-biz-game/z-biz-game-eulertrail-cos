// The balance rig. Nothing here is a pass/fail gate — it is the instrument the tier bands
// were read off of, kept in the repo so the published numbers stay checkable:
//
//   node test/balance.mjs                      # 40 seeds per tier
//   SAMPLES=200 node tools/../test/balance.mjs # a real distribution
//   TIERS=four,five node test/balance.mjs
//
// `badRatio` is the column the bands are cut on (see js/core/make.js step 3): the share of
// oriented first moves after which no `par`-stroke cover exists any more. It is printed
// here as a percentile table precisely so the cut in TIERS is a reading and not a vibe.

import { TIERS, makeLot } from '../js/core/make.js';

const N = Number(process.env.SAMPLES || 40);
const want = (process.env.TIERS || '').split(',').filter(Boolean);
const tiers = want.length ? TIERS.filter((t) => want.includes(t.key)) : TIERS;

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function table(sorted) {
  return [0, 0.25, 0.5, 0.75, 1].map((p) => pct(sorted, p)).join(' / ');
}

function decTable(sorted) {
  return [0, 0.25, 0.5, 0.75, 1].map((p) => pct(sorted, p).toFixed(2)).join(' / ');
}

const rows = [];
for (const tier of tiers) {
  const stats = {};
  const found = [];
  const ms = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const lot = makeLot(`balance-${i}`, tier, stats);
    ms.push(Date.now() - t0);
    if (lot) found.push(lot.rating);
  }
  const col = (k) => found.map((f) => f[k]).sort((a, b) => a - b);
  const bad = col('badRatio');
  ms.sort((a, b) => a - b);
  rows.push({
    tier: tier.key,
    par: tier.par[0],
    accept: `${found.length}/${N}`,
    edges: table(col('edges')),
    forks: table(col('forks')),
    dead: table(col('dead')),
    bad: decTable(bad),
    cut: tier.minBadRatio,
    ms: `${pct(ms, 0.5).toFixed(0)} / ${ms[ms.length - 1].toFixed(0)}`,
    states: table(col('dpStates')).replace(/\.\d/g, (m) => m),
    rej: Object.entries(stats).filter(([k, v]) => v && k !== 'found').sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' '),
  });
}

const head = ['tier', 'par', 'accept', 'edges p0/25/50/75/100', 'forks', 'dead', 'badRatio p0..p100', 'cut', 'ms med/max', 'dpStates', 'rejects'];
console.log(head.map((h, i) => h.padEnd(i < 3 ? 8 : 24)).join(' '));
for (const r of rows) {
  console.log([r.tier, r.par, r.accept, r.edges, r.forks, r.dead, r.bad, r.cut, r.ms, r.states, r.rej]
    .map((v, i) => String(v).padEnd(i < 3 ? 8 : 24)).join(' '));
}
console.log(`\nsamples per tier: ${N}   (SAMPLES=…, TIERS=tandem,three to subset)`);
console.log('bands are cut at p25 of the badRatio column above; see DESIGN.md 第 4 节.');
