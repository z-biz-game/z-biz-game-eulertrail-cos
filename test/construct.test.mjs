// The upper bound, built. If these fail, the level on screen has a printed budget nobody
// can actually meet, which is the one failure mode this repo cannot survive.

import { test, run, ok, eq, fail } from '../tools/harness.mjs';
import { compile, edgeBetween } from '../js/core/graph.js';
import { par, oddCount, oddVertices } from '../js/core/theory.js';
import { pairOdd, eulerTour, construct, verify, coverWith } from '../js/core/construct.js';
import { rngFrom } from '../js/core/rng.js';
import { PATH3, CYCLE4, SINGLE, STAR4, FOUR_ODD, SPLIT, randomGraph } from './fixture.mjs';

test('pairOdd matches the odd pins up, each used exactly once', () => {
  const g = compile(STAR4);
  const pairs = pairOdd(g, rngFrom('pair-1'));
  eq(pairs.length, 2, 'four odd pins make two pairs');
  const flat = pairs.flat().sort((a, b) => a - b);
  eq(flat, oddVertices(g), 'and the pairs cover exactly the odd pins');
  for (const [a, b] of pairs) ok(a !== b, 'a pin is not paired with itself');
});

test('pairOdd on an Eulerian graph is empty, so no cut happens', () => {
  eq(pairOdd(compile(CYCLE4)), [], 'zero odd pins');
  eq(pairOdd(compile(PATH3)).length, 1, 'two odd pins, one pair');
});

test('the pairing is arbitrary and the stroke count is not', () => {
  const g = compile(FOUR_ODD);
  const counts = new Set();
  for (let i = 0; i < 40; i++) {
    const cov = coverWith(g, { rng: rngFrom(`pairing-${i}`) });
    if (!cov.ok) fail(`pairing ${i}: ${cov.error}`);
    counts.add(cov.trails.length);
  }
  eq([...counts], [2], 'every pairing still yields par = 2 strokes');
});

test('eulerTour walks every edge of an augmented graph exactly once', () => {
  const g = compile(STAR4);
  const pairs = pairOdd(g, rngFrom('tour-1'));
  const tour = eulerTour(g, pairs, pairs[0][0]);
  ok(tour, 'a tour exists');
  eq(tour.verts[0], tour.verts[tour.verts.length - 1], 'it is closed');
  eq(tour.verts.length, g.m + pairs.length + 1, `${g.m} real + ${pairs.length} virtual edges, so that many steps`);
  const real = tour.edgesIn.filter((e) => e >= 0 && e < g.m).sort((a, b) => a - b);
  eq(real, [0, 1, 2, 3], 'all four real edges used');
  const virt = tour.edgesIn.filter((e) => e >= g.m);
  eq(virt.length, pairs.length, 'and each virtual edge once');
});

test('eulerTour returns null when the graph is disconnected: nothing to tour', () => {
  const g = compile(SPLIT);
  eq(eulerTour(g, pairOdd(g, null), 0), null, 'no Euler circuit exists');
});

test('construct on one edge gives one stroke of one edge', () => {
  const g = compile(SINGLE);
  const { trails } = construct(g, {});
  eq(trails.length, 1, 'one stroke');
  eq(trails[0].edges.length, 1, 'one edge');
  eq(trails[0].verts.length, 2, 'two pins');
  eq(verify(g, trails), null, 'and the cover is sound');
});

test('construct on an Eulerian square gives one closed stroke, not two halves', () => {
  const g = compile(CYCLE4);
  const { trails } = construct(g, {});
  eq(trails.length, 1, 'the max(1, .) branch has to come out of the construction too');
  eq(trails[0].edges.length, 4, 'all four edges');
  eq(trails[0].verts[0], trails[0].verts[trails[0].verts.length - 1], 'back where it started');
  eq(verify(g, trails), null, 'sound');
});

test('construct on K1,4 gives two leaf-to-leaf strokes through the centre', () => {
  const g = compile(STAR4);
  const cov = coverWith(g, { rng: rngFrom('star') });
  ok(cov.ok, cov.error || 'built');
  eq(cov.trails.length, 2, 'par strokes');
  for (const t of cov.trails) {
    eq(t.edges.length, 2, 'each stroke is leaf-centre-leaf');
    eq(t.verts[1], 4, 'through the centre');
    ok(t.verts[0] !== 4 && t.verts[2] !== 4, 'starting and ending on leaves');
  }
  const union = cov.trails.flatMap((t) => t.edges).sort((a, b) => a - b);
  eq(union, [0, 1, 2, 3], 'disjoint and exhaustive');
});

test('construct throws on a disconnected level instead of emitting a partial cover', () => {
  const g = compile(SPLIT);
  try {
    construct(g, {});
    fail('construct built a cover for a disconnected graph');
  } catch (err) {
    ok(/not connected/.test(err.message), `reason is the premise: ${err.message}`);
  }
  const cov = coverWith(g, {});
  eq(cov.ok, false, 'coverWith turns that into a refusal');
  ok(/not connected/.test(cov.error), 'with the same reason');
});

test('verify catches a reused edge, a missed edge and a step that is not an edge', () => {
  const g = compile(FOUR_ODD);
  const good = construct(g, { rng: rngFrom('verify') }).trails;
  eq(verify(g, good), null, 'the honest cover passes');
  const reused = [good[0], good[0]];
  ok(/reuses edge/.test(verify(g, reused)), `a double-covered edge is caught: ${verify(g, reused)}`);
  ok(/covered by no stroke/.test(verify(g, good.slice(1))), 'a dropped stroke is caught');
  const brokenStep = [{ verts: [0, 2, 5], edges: [0, 3] }];
  ok(/steps .* along an edge that does not join them|is not edge/.test(verify(g, brokenStep)), 'a phantom step is caught');
  const miscounted = [{ verts: [0, 1, 2], edges: [0] }];
  ok(/vertices$/.test(verify(g, miscounted) || ''), `verts/edges length mismatch: ${verify(g, miscounted)}`);
  ok(/empty/.test(verify(g, [{ verts: [0], edges: [] }])), 'an empty stroke is refused');
  ok(/not an array/.test(verify(g, null)), 'and so is a missing cover');
});

test('over 300 random graphs: constructed strokes == theorem par, disjoint and exhaustive', () => {
  let checked = 0;
  for (let i = 0; i < 300; i++) {
    const spec = randomGraph(`construct-${i}`, { rows: 6, cols: 6, verts: 7, extra: i % 6 });
    const g = compile(spec);
    const cov = coverWith(g, { rng: rngFrom(`construct-rng-${i}`) });
    if (!cov.ok) {
      // Only legitimate reason: the local generator produced an illegal graph, which the
      // validator names. Anything else is a construction bug.
      ok(/not connected/.test(cov.error), `seed ${i}: ${cov.error}`);
      continue;
    }
    const want = par(g);
    if (cov.trails.length !== want) fail(`seed ${i}: built ${cov.trails.length}, theorem says ${want}`);
    const err = verify(g, cov.trails);
    if (err) fail(`seed ${i}: verify rejected the cover: ${err}`);
    const union = cov.trails.flatMap((t) => t.edges);
    if (union.length !== g.m) fail(`seed ${i}: ${union.length} strokes edges for ${g.m} graph edges`);
    if (new Set(union).size !== union.length) fail(`seed ${i}: an edge was covered twice`);
    checked++;
  }
  ok(checked >= 250, `${checked} graphs constructed and verified`);
});

test('each constructed trail is a real trail: consecutive pins joined, no edge twice', () => {
  for (const [name, spec] of Object.entries({ PATH3, CYCLE4, STAR4, FOUR_ODD })) {
    const g = compile(spec);
    for (const t of construct(g, { rng: rngFrom(`trail-${name}`) }).trails) {
      const seen = new Set();
      for (let k = 0; k + 1 < t.verts.length; k++) {
        const e = edgeBetween(g, t.verts[k], t.verts[k + 1]);
        if (e < 0) fail(`${name}: ${t.verts[k]}->${t.verts[k + 1]} is not an edge`);
        if (seen.has(e)) fail(`${name}: edge ${e} used twice inside one stroke`);
        seen.add(e);
      }
      ok(seen.size === t.edges.length, `${name}: ${seen.size} distinct steps`);
    }
  }
});

test('coverWith reports the theorem numbers alongside the build', () => {
  const cov = coverWith(compile(FOUR_ODD), {});
  eq(cov.par, 2, 'par');
  eq(cov.odd, 4, 'odd count');
  eq(oddCount(compile(FOUR_ODD)), cov.odd, 'and they agree with theory.js');
});

run();
