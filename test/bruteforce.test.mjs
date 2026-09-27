// The "and no fewer" half, computed. This file is where the theorem is checked against
// something that does not quote the theorem: an exact DP over (remaining edges, pen
// position) whose answer is the true minimum stroke cover.

import { test, run, ok, eq, fail } from '../tools/harness.mjs';
import { compile, validate, makeSpec } from '../js/core/graph.js';
import { par, oddCount } from '../js/core/theory.js';
import { coverWith } from '../js/core/construct.js';
import { minTrails, firstMoveAudit, exhaustiveAllowed, MAX_EDGES } from '../js/core/bruteforce.js';
import { rngFrom } from '../js/core/rng.js';
import { PATH3, CYCLE4, SINGLE, STAR4, FOUR_ODD, TWO_SQUARES, randomGraph } from './fixture.mjs';

test('the exhaustive cap is a real gate, and it is honest about refusing', () => {
  eq(MAX_EDGES, 14, 'the shipped pool tops out at 14 edges so every level is certifiable');
  const g = compile(makeSpec(6, 6, Array.from({ length: MAX_EDGES + 1 }, (_, i) => [i, i + 1])));
  eq(g.m, MAX_EDGES + 1, 'fifteen edges');
  eq(exhaustiveAllowed(g), false, 'so the gate is closed');
  const res = minTrails(g);
  eq(res.ok, false, 'and minTrails says no rather than guessing');
  eq(res.trails, -1, 'never a fabricated number');
  ok(/past the 14-edge exhaustive cap/.test(res.error), `the reason: ${res.error}`);
});

test('forcing the cap returns a truncation flag, not an answer', () => {
  const g = compile(makeSpec(6, 6, Array.from({ length: MAX_EDGES + 1 }, (_, i) => [i, i + 1])));
  const res = minTrails(g, { force: true, budgetMs: 200, stateCap: 1000 });
  eq(res.ok, false, 'out of budget is a failure, not a smaller number');
  eq(res.trails, -1, 'no answer claimed');
  eq(exhaustiveAllowed(compile(PATH3)), true, 'while a three-edge graph is fine');
});

test('minTrails reproduces par on every hand-built fixture', () => {
  const cases = [[PATH3, 1], [CYCLE4, 1], [SINGLE, 1], [STAR4, 2], [FOUR_ODD, 2]];
  for (const [spec, want] of cases) {
    const g = compile(spec);
    const res = minTrails(g);
    ok(res.ok, `seed: ${res.error}`);
    eq(res.trails, want, `${JSON.stringify(spec.edges)} needs ${want}`);
    eq(par(g), want, 'and the theorem agrees');
    ok(res.states > 0, 'the DP really ran states');
  }
});

test('the DP is the honest one where the theorem loses its premise', () => {
  // Two squares: odd = 0, so par() prints 1 -- but one stroke cannot cross between
  // components. The validator refuses the graph, so no level can ship like this, and the
  // search is what proves the refusal matters.
  const g = compile(TWO_SQUARES);
  eq(oddCount(g), 0, 'no odd pin');
  eq(par(g), 1, 'the formula alone says one stroke');
  eq(minTrails(g).trails, 2, 'the search says two, and the search is right');
  ok(validate(TWO_SQUARES), 'and the gate is what keeps this out of the pool');
});

test('three-way reconciliation: theorem == construction == exhaustive', () => {
  let checked = 0;
  const pars = new Set();
  for (let i = 0; i < 160; i++) {
    const spec = randomGraph(`reconcile-${i}`, { rows: 6, cols: 6, verts: 6 + (i % 6), extra: i % 5 });
    if (validate(spec)) continue;      // connectivity premise asserted by the validator
    const g = compile(spec);
    const th = par(g);
    const cov = coverWith(g, { rng: rngFrom(`reconcile-cov-${i}`) });
    if (!cov.ok) fail(`seed ${i}: construction refused a legal level: ${cov.error}`);
    const dp = minTrails(g);
    if (!dp.ok) fail(`seed ${i}: search refused a ${g.m}-edge level: ${dp.error}`);
    const built = cov.trails.length;
    if (!(th === built && built === dp.trails)) {
      fail(`seed ${i}: theorem ${th}, built ${built}, searched ${dp.trails}`);
    }
    pars.add(th);
    checked++;
  }
  ok(checked >= 130, `${checked} graphs reconciled three ways`);
  ok(pars.size >= 3, `the corpus actually spans several par values: ${[...pars].sort().join(',')}`);
});

test('firstMoveAudit: a star is winnable but easy to open wrong', () => {
  const g = compile(STAR4);
  const a = firstMoveAudit(g);
  ok(a.ok, 'fully computed');
  eq(a.par, 2, 'the theorem');
  eq(a.min, 2, 'and the search agree');
  eq(a.total, 8, 'four edges, two orientations each');
  eq(a.dead, 0, 'no opening makes the level unsolvable');
  eq(a.bad, 4, 'starting at the centre throws a stroke away: 4 of 8');
  eq(a.badRatio, 0.5, 'the measured wrong-first-move share');
  const fromCentre = a.openings.filter((o) => o.from === 4);
  eq(fromCentre.length, 4, 'the centre has four ways to leave it');
  ok(fromCentre.every((o) => o.strokes === 3), 'and each needs three strokes instead of two');
  ok(a.openings.filter((o) => o.from !== 4).every((o) => o.strokes === 2), 'leaf openings stay at par');
});

test('firstMoveAudit: a cycle cannot be opened wrong', () => {
  const g = compile(CYCLE4);
  const a = firstMoveAudit(g);
  eq(a.par, 1, 'one stroke');
  eq(a.total, 8, 'four edges, two orientations');
  eq(a.bad, 0, 'every opening still closes the ring');
  eq(a.dead, 0, 'none is fatal');
  eq(a.badRatio, 0, 'so badRatio 0 means "you cannot get this wrong"');
});

test('firstMoveAudit: bad + good == total whenever dead is 0', () => {
  let checked = 0;
  for (let i = 0; i < 120; i++) {
    const spec = randomGraph(`audit-${i}`, { rows: 5, cols: 5, verts: 6, extra: i % 5 });
    if (validate(spec)) continue;
    const g = compile(spec);
    const a = firstMoveAudit(g);
    if (!a.ok) fail(`seed ${i}: ${a.error || 'truncated'}`);
    if (a.dead !== 0) fail(`seed ${i}: ${a.dead} dead openings on a connected graph`);
    if (a.bad + a.good !== a.total) fail(`seed ${i}: ${a.bad}+${a.good} != ${a.total}`);
    if (a.min !== a.par) fail(`seed ${i}: search ${a.min} disagrees with theorem ${a.par}`);
    if (Math.abs(a.badRatio - a.bad / a.total) > 1e-12) fail(`seed ${i}: badRatio arithmetic`);
    checked++;
  }
  ok(checked >= 100, `${checked} graphs audited`);
});

test('a level with a high badRatio is a level you can lose', () => {
  // Not a feeling: the DP's per-opening numbers are what the tier filter in js/core/make.js
  // thresholds on, so the arithmetic here is the same arithmetic bake.mjs shipped with.
  const g = compile(FOUR_ODD);
  const a = firstMoveAudit(g);
  eq(a.par, 2, 'par');
  ok(a.bad > 0, `${a.bad} of ${a.total} openings are wrong`);
  ok(a.openings.every((o) => o.strokes >= a.par), 'no opening beats the theorem, as expected');
  ok(a.deadRatio === 0, 'and none is a dead end');
});

test('states are reported so a slow level is visible in the data file', () => {
  const cheap = minTrails(compile(PATH3)).states;
  const busy = minTrails(compile(FOUR_ODD)).states;
  ok(cheap > 0 && busy > 0, 'both counted states');
  ok(busy > cheap, `${busy} states for five edges vs ${cheap} for three`);
});

run();
