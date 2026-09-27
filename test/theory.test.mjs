// The theorem itself: what `par` means, where its premise bites, and the two classical
// numbers this repo refuses to fake.

import { test, run, ok, eq, fail } from '../tools/harness.mjs';
import { compile, validate } from '../js/core/graph.js';
import {
  oddVertices, oddCount, par, handshakeOk, oddOfDegrees, parFromDegrees, fitsOnLattice,
  oneStrokeExists, degreeTable,
} from '../js/core/theory.js';
import { PATH3, CYCLE4, SINGLE, STAR4, FOUR_ODD, SEVEN_BRIDGES_DEGREES, TWO_SQUARES, randomGraph, shapeFromSpec } from './fixture.mjs';

test('oddVertices lists the odd pins in ascending id', () => {
  eq(oddVertices(compile(STAR4)), [1, 3, 5, 7], 'the four leaves, centre excluded (degree 4)');
  eq(oddVertices(compile(PATH3)), [0, 3], 'a path has its two ends');
  eq(oddVertices(compile(CYCLE4)), [], 'a square has none');
});

test('par is max(1, odd/2), including the odd == 0 case', () => {
  eq(par(compile(CYCLE4)), 1, 'zero odd pins is one closed stroke, not zero');
  eq(par(compile(PATH3)), 1, 'two odd pins is one stroke');
  eq(par(compile(SINGLE)), 1, 'one edge is one stroke');
  eq(par(compile(STAR4)), 2, 'four odd pins is two strokes');
  eq(par(compile(FOUR_ODD)), 2, 'the 4-odd instance: two strokes');
});

test('par of an empty or missing graph is null, never 0', () => {
  eq(par(null), null, 'null graph');
  eq(par(compile({ rows: 2, cols: 2, edges: [[0, 1]], verts: [0, 1] })), 1, 'one edge is not empty');
  eq(par({ rows: 2, cols: 2, m: 0, verts: [] }), null, 'a compiled graph with no edges');
});

test('oneStrokeExists is exactly odd in {0, 2}: the positive cases', () => {
  for (const [name, spec] of Object.entries({ PATH3, CYCLE4, SINGLE })) {
    const g = compile(spec);
    ok(oneStrokeExists(g), `${name} should be one-stroke`);
    eq(oddCount(g) <= 2, true, `${name} has at most two odd pins`);
  }
});

test('oneStrokeExists is exactly odd in {0, 2}: the negative cases', () => {
  eq(oddCount(compile(STAR4)), 4, 'four odd pins');
  eq(oneStrokeExists(compile(STAR4)), false, 'so no single stroke covers K1,4');
  eq(oneStrokeExists(compile(FOUR_ODD)), false, 'nor the 4-odd instance');
  // A hand-built 6-odd graph: a top-row path with two pendant legs and a tail down the
  // right side. Odd pins are 0, 1, 2, 5, 6, 11 -> par 3.
  const six = {
    rows: 3, cols: 4,
    edges: [[0, 1], [1, 2], [2, 3], [1, 5], [2, 6], [3, 7], [7, 11]],
    verts: [0, 1, 2, 3, 5, 6, 7, 11],
  };
  eq(validate(six), null, 'the six-odd fixture is legal');
  eq(oddCount(compile(six)), 6, 'six odd pins');
  eq(par(compile(six)), 3, 'so three strokes');
  eq(oneStrokeExists(compile(six)), false, 'and certainly not one');
});

test('handshake is a predicate that can be falsified', () => {
  eq(handshakeOk([1, 1]), true, 'two odd degrees: fine');
  eq(handshakeOk([1, 1, 1]), false, 'three odd degrees: no graph has that');
  eq(handshakeOk([5, 3, 3, 3]), true, 'the seven bridges: four odd, which is legal');
  eq(handshakeOk([2, 2, 2]), true, 'a triangle');
  eq(handshakeOk([1, 2, 3]), true, 'two of these degrees are odd, which is legal');
  eq(handshakeOk([1, 2, 2]), false, 'one odd degree: no graph has that');
});

test('the classical seven bridges, computed from its degree vector alone', () => {
  eq(SEVEN_BRIDGES_DEGREES, [5, 3, 3, 3], 'Kneiphof 5, the other three banks 3 each');
  eq(oddOfDegrees(SEVEN_BRIDGES_DEGREES), 4, 'four odd vertices');
  eq(parFromDegrees(SEVEN_BRIDGES_DEGREES), 2, 'so the historic answer: two strokes, never one');
  eq(SEVEN_BRIDGES_DEGREES.reduce((a, b) => a + b, 0) / 2, 7, 'and seven bridges, which is the whole point');
});

test('the seven bridges cannot be embedded in this model, and that is proved not asserted', () => {
  // A lattice point has four unit neighbours, so degree 5 has no drawing here. The repo's
  // answer is honest: ship a 4-odd instance of the same theorem instead of pretending.
  eq(fitsOnLattice(SEVEN_BRIDGES_DEGREES), false, 'degree 5 does not fit');
  eq(fitsOnLattice([1, 1, 1, 1, 2, 2, 2, 3]), true, 'degrees within 1..4 fit the necessary condition');
  eq(fitsOnLattice([4, 4, 4, 4]), true, 'a 4-regular patch is at least not excluded');
  eq(fitsOnLattice([0, 2]), false, 'an isolated vertex is not a graph here');
  eq(oddCount(compile(FOUR_ODD)), 4, 'the shipped substitute has the same odd count');
  eq(par(compile(FOUR_ODD)), 2, 'and the same par');
  ok(FOUR_ODD.edges.length < 7, 'but fewer edges: it is a cousin, not a reproduction');
});

test('over 1000 random connected graphs, odd is even and par == max(1, odd/2)', () => {
  let checked = 0;
  const seenPar = new Set();
  for (let i = 0; i < 1000; i++) {
    const spec = randomGraph(`theory-${i}`, { rows: 6, cols: 6, verts: 6 + (i % 8), extra: i % 6 });
    if (validate(spec)) continue;
    const g = compile(spec);
    const o = oddCount(g);
    const p = par(g);
    if (o % 2 !== 0) fail(`seed ${i}: handshake broken (odd = ${o})`);
    if (p !== Math.max(1, o / 2)) fail(`seed ${i}: par ${p} != max(1, ${o}/2)`);
    if (oneStrokeExists(g) !== (o === 0 || o === 2)) fail(`seed ${i}: oneStrokeExists disagrees with odd = ${o}`);
    seenPar.add(p);
    checked++;
  }
  ok(checked >= 900, `${checked} graphs checked`);
  ok(seenPar.has(1) && seenPar.has(2), `par values seen: ${[...seenPar].join(',')}`);
});

test('par == 1 if and only if odd is 0 or 2, in both directions, over the same corpus', () => {
  let ones = 0;
  for (let i = 0; i < 400; i++) {
    const spec = randomGraph(`iff-${i}`, { rows: 5, cols: 5, verts: 6, extra: i % 5 });
    if (validate(spec)) continue;
    const g = compile(spec);
    const o = oddCount(g);
    if (par(g) === 1) {
      if (o !== 0 && o !== 2) fail(`par 1 with odd = ${o}`);
      ones++;
    } else if (o === 0 || o === 2) {
      fail(`odd = ${o} but par = ${par(g)}`);
    }
  }
  ok(ones > 0, `the par == 1 branch is actually exercised (${ones} times)`);
});

test('the lattice identity odd = 2 * (1 + forks - cycles) holds on every random graph', () => {
  // Derived in js/core/make.js's header and used there to justify minForks = par + 1.
  // degrees 1..4 only: sum(deg - 2) = 2m - 2v = 2(cycles - 1), and the left side is
  // -leaves + forks_in + 2*deg4, which rearranges to odd = 2(1 + forks - cycles).
  let checked = 0;
  for (let i = 0; i < 1000; i++) {
    const spec = randomGraph(`ident-${i}`, { rows: 6, cols: 6, verts: 7, extra: i % 7 });
    if (validate(spec)) continue;
    const s = shapeFromSpec(spec);
    if (s.degrees.some((d) => d > 4)) fail(`seed ${i}: degree above 4 in a lattice graph`);
    if (s.odd !== 2 * (1 + s.forks - s.cycles)) {
      fail(`seed ${i}: odd ${s.odd} != 2*(1 + ${s.forks} - ${s.cycles})`);
    }
    if (s.odd >= 2 && s.forks !== s.odd / 2 - 1 + s.cycles) fail(`seed ${i}: forks form of the identity`);
    checked++;
  }
  ok(checked >= 900, `${checked} graphs satisfied the identity`);
});

test('the identity on the hand-built fixtures, spelled out', () => {
  eq(shapeFromSpec(FOUR_ODD), { odd: 4, forks: 1, leaves: 3, verts: 6, edges: 5, cycles: 0, degrees: [1, 1, 1, 2, 2, 3] }, '4 = 2*(1+1-0)');
  eq(shapeFromSpec(CYCLE4).cycles, 1, 'a square is one cycle');
  eq(shapeFromSpec(CYCLE4).odd, 0, 'and 2*(1+0-1)');
  eq(shapeFromSpec(PATH3).odd, 2, 'a path: 2*(1+0-0)');
});

test('the theorem needs its connectivity premise: two squares', () => {
  // odd = 0 would print "one stroke", and one stroke cannot cover two components. The
  // validator is what keeps this out of the pool; the number alone is not enough.
  eq(oddCount(compile(TWO_SQUARES)), 0, 'every pin has degree 2');
  eq(par(compile(TWO_SQUARES)), 1, 'so the formula says one');
  ok(validate(TWO_SQUARES), 'and validate refuses the graph for being disconnected');
  ok(/not connected/.test(validate(TWO_SQUARES)), 'for exactly that reason');
});

test('degreeTable reports per-pin degrees for the panel', () => {
  eq(degreeTable(compile(STAR4)), { 1: 1, 3: 1, 4: 4, 5: 1, 7: 1 }, 'centre 4, leaves 1');
  eq(degreeTable(compile(PATH3)), { 0: 1, 1: 2, 2: 2, 3: 1 }, 'path interior is even');
});

run();
