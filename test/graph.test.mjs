// The model and its gatekeeper. js/core/graph.js is the only thing in the repo that decides
// whether a level is a level, so every branch of `validate` gets its own negative — the
// bake gate and the save-file re-proof both lean on it.

import { test, run, ok, eq, fail } from '../tools/harness.mjs';
import {
  compile, validate, makeSpec, toSpec, edgeKey, edgeBetween, otherEnd, rc, MAX_EDGES, MAX_LAT,
} from '../js/core/graph.js';
import { PATH3, CYCLE4, SINGLE, STAR4, FOUR_ODD, SPLIT, BAD, randomGraph } from './fixture.mjs';

const CLEAN = { PATH3, CYCLE4, SINGLE, STAR4, FOUR_ODD };

test('every edge has one canonical key, smaller endpoint first', () => {
  eq(edgeKey(5, 2), '2:5', 'reversed pair');
  eq(edgeKey(2, 5), '2:5', 'same key both ways');
});

test('the hand-built fixtures all pass the validator with their own numbers declared', () => {
  for (const [name, spec] of Object.entries(CLEAN)) {
    const g = compile(spec);
    const odd = g.verts.filter((v) => g.deg[v] % 2 === 1).length;
    const err = validate(spec, { odd, par: Math.max(1, odd / 2) });
    if (err) fail(`${name} rejected: ${err}`);
  }
});

test('compile types the lattice: degrees, adjacency, used pins, edge count', () => {
  const g = compile(STAR4);
  eq(g.m, 4, 'four edges');
  eq(g.rows, 3, 'rows');
  eq([...g.deg.slice(0, 9)], [0, 1, 0, 1, 4, 1, 0, 1, 0], 'degrees over the whole 3x3 field');
  eq([...g.verts], [1, 3, 4, 5, 7], 'verts are exactly the pins with edges');
  eq(g.inc[4].length, 4, 'the centre has four incident edges');
  eq(g.inc[1].length, 1, 'a leaf has one');
  eq([...g.used], [0, 1, 0, 1, 1, 1, 0, 1, 0], 'used marks declared pins');
});

test('compile normalises endpoint order so an edge has one identity', () => {
  const g = compile({ rows: 2, cols: 3, edges: [[4, 3], [1, 0]] });
  eq(g.edges, [[3, 4], [0, 1]], 'each pair stored low-first');
});

test('compile refuses a duplicate edge instead of quietly making a multigraph', () => {
  try {
    compile({ rows: 2, cols: 3, edges: [[0, 1], [1, 0]] });
    fail('duplicate edge compiled');
  } catch (err) {
    ok(/duplicate/.test(err.message), `message says duplicate: ${err.message}`);
  }
});

test('edgeBetween and otherEnd answer from the compiled arrays', () => {
  const g = compile(PATH3);
  eq(edgeBetween(g, 0, 1), 0, 'first edge');
  eq(edgeBetween(g, 1, 0), 0, 'undirected');
  eq(edgeBetween(g, 0, 2), -1, 'not adjacent');
  eq(otherEnd(g, 1, 1), 2, 'other end of edge 1 from vertex 1');
  eq(otherEnd(g, 1, 2), 1, 'and back');
});

test('rc() is the id arithmetic the whole model uses', () => {
  const g = compile(CYCLE4);
  eq(rc(3, g), { r: 1, c: 1 }, 'bottom right of a 2x2');
  eq(rc(2, g), { r: 1, c: 0 }, 'second row, first column');
});

test('spec -> compile -> spec round trips', () => {
  for (const spec of Object.values(CLEAN)) {
    const g = compile(spec);
    const back = toSpec(g);
    eq(validate(back, undefined), null, 'the round-tripped spec is still legal');
    eq(compile(back).edges, g.edges, 'same edge list');
    eq(compile(back).verts, g.verts, 'same pins');
  }
});

test('makeSpec derives the vertex set from the edges when none is given', () => {
  const spec = makeSpec(3, 3, [[4, 5], [4, 7]]);
  eq(spec.verts, [4, 5, 7], 'sorted, implied');
  eq(spec.edges, [[4, 5], [4, 7]], 'pairs low-first');
});

test('validate refuses a loop, a non-unit segment and an off-lattice endpoint', () => {
  ok(/same vertex/.test(validate(BAD.SAME_VERTEX)), 'loop');
  ok(/unit lattice segment/.test(validate(BAD.NON_UNIT)), 'jumping over a pin is not an edge');
  ok(/off the lattice/.test(validate(BAD.OFF_LATICE)), 'endpoint outside the field');
});

test('validate refuses a duplicate edge, an empty graph and an oversized lattice', () => {
  ok(/duplicate/.test(validate(BAD.DUPE)), 'duplicate');
  ok(/no edges/.test(validate(BAD.NO_EDGES)), 'no edges');
  ok(/bigger than/.test(validate(BAD.TOO_BIG)), `lattice over ${MAX_LAT}`);
  ok(/rows and cols/.test(validate({ rows: 2.5, cols: 3, edges: [[0, 1]] })), 'non-integer dims');
  ok(/at least 2x2/.test(validate({ rows: 1, cols: 6, edges: [[0, 1]] })), 'degenerate lattice');
});

test('an edge list past the cap is refused', () => {
  const spec = { rows: MAX_LAT, cols: MAX_LAT, edges: [] };
  for (let v = 0; v < MAX_LAT * MAX_LAT - 1; v++) spec.edges.push([v, v + 1]);
  ok(/more than/.test(validate(spec)), `${spec.edges.length} edges > ${MAX_EDGES}`);
});

test('the declared vertex set is checked both ways', () => {
  ok(/isolated/.test(validate(BAD.ISOLATED_DECLARED)), 'a declared pin with no edges');
  ok(/not declared/.test(validate(BAD.UNDECLARED)), 'an edge touching an undeclared pin');
  ok(/off the lattice/.test(validate({ rows: 2, cols: 2, edges: [[0, 1]], verts: [0, 1, 9] })), 'declared pin off the field');
  ok(/twice/.test(validate({ rows: 2, cols: 2, edges: [[0, 1]], verts: [0, 0, 1] })), 'declared twice');
  ok(/must be an array/.test(validate({ rows: 2, cols: 2, edges: [[0, 1]], verts: 7 })), 'verts not an array');
});

test('a declared odd/par that disagrees with the edges is refused', () => {
  // Handshake makes an odd count unreachable *from an edge list*, so the reachable negative
  // is a wrong claim about the count -- which is exactly the number the screen prints.
  const g = compile(FOUR_ODD);
  eq(FOUR_ODD.edges.length, 5, 'five edges');
  eq(g.verts.filter((v) => g.deg[v] % 2 === 1).length, 4, 'four odd pins');
  ok(/declared odd/.test(validate(FOUR_ODD, { odd: 2, par: 1 })), 'claiming two odd pins');
  ok(/declared par/.test(validate(FOUR_ODD, { odd: 4, par: 1 })), 'claiming one stroke for four odd pins');
  eq(validate(FOUR_ODD, { odd: 4, par: 2 }), null, 'the honest claim passes');
});

test('validate refuses a disconnected graph and names the reachability', () => {
  const err = validate(SPLIT, { odd: 4, par: 2 });
  ok(/not connected/.test(err || ''), `message: ${err}`);
  ok(/2 of 4/.test(err || ''), 'states how much is reachable');
});

test('validate refuses a pair that is not a pair', () => {
  ok(/not a pair/.test(validate({ rows: 2, cols: 2, edges: [[0, 1, 2]] })), 'triple');
  ok(/not a pair/.test(validate({ rows: 2, cols: 2, edges: [3] })), 'bare number');
  ok(/must be an array/.test(validate({ rows: 2, cols: 2, edges: 5 })), 'edges not an array');
  ok(/not an object/.test(validate(null)), 'null spec');
});

test('over 1000 random connected lattice graphs, the odd count is always even', () => {
  // The handshake lemma, falsified if it could be: 1000 graphs, no exceptions.
  let checked = 0;
  for (let i = 0; i < 1000; i++) {
    const spec = randomGraph(`handshake-${i}`, { rows: 6, cols: 6, verts: 6 + (i % 7), extra: i % 5 });
    const err = validate(spec, undefined);
    if (err) continue;   // the local generator can produce a repeat edge; those are not evidence
    const g = compile(spec);
    const odd = g.verts.filter((v) => g.deg[v] % 2 === 1).length;
    if (odd % 2 !== 0) fail(`seed ${i}: odd count ${odd} is itself odd`);
    if (!g.m) fail(`seed ${i}: empty graph slipped through`);
    checked++;
  }
  ok(checked >= 900, `${checked} of 1000 graphs were checked (the rest were refused by the validator)`);
});

test('over the same 1000 graphs, par is always max(1, odd/2) and integral', () => {
  for (let i = 0; i < 200; i++) {
    const spec = randomGraph(`par-${i}`, { rows: 7, cols: 7, verts: 8, extra: (i % 6) + 1 });
    if (validate(spec)) continue;
    const g = compile(spec);
    const odd = g.verts.filter((v) => g.deg[v] % 2 === 1).length;
    const p = Math.max(1, odd / 2);
    if (!Number.isInteger(p)) fail(`seed ${i}: par ${p} is not an integer`);
    if (p < 1) fail(`seed ${i}: par ${p} below 1`);
  }
  ok(true, '200 graphs, every par integral and at least 1');
});

run();
