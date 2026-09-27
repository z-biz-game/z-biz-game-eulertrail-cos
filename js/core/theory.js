// The lower bound, and the number printed on screen.
//
//   Euler / Königsberg (1736): a connected graph's edges can be split into
//   k = max(1, odd/2) edge-disjoint trails covering every edge, and no fewer.
//
//   lower bound  a trail has two endpoints, and every odd-degree vertex must be the
//                endpoint of some trail (in and out use edges in pairs, so an odd vertex
//                cannot be a through-vertex) -> 2k >= odd.
//   upper bound  pair the odd vertices, add a virtual edge per pair, the augmented graph
//                is connected and all-even -> Euler circuit (js/core/construct.js) ->
//                cut it back at the virtual edges -> exactly odd/2 trails.
//   odd == 0     an Euler circuit already, so one stroke; hence the max(1, .).
//
// This file is only the *statement*. The upper bound is construct.js and the "no fewer"
// half is bruteforce.js; test/theory.test.mjs reconciles all three on every baked level.
// Keeping the claim in its own module is what lets the tests point at one number.

// Odd-degree vertices, in ascending id.
export function oddVertices(g) {
  const out = [];
  for (const v of g.verts) if (g.deg[v] % 2 === 1) out.push(v);
  return out;
}

export function oddCount(g) {
  let n = 0;
  for (const v of g.verts) if (g.deg[v] % 2 === 1) n++;
  return n;
}

// The theorem's k. `null` on the empty graph: the validator rejects that spec before it
// gets here, and printing "0 strokes" for a level with no edges would be a lie either way.
export function par(g) {
  if (!g || !g.m) return null;
  return Math.max(1, oddCount(g) / 2);
}

// Handshake lemma as a predicate over a raw degree vector, so it can be *falsified*.
// From an edge list an odd count is unreachable (that is the lemma), which is why the
// validator's bite here has to be tested on a degree claim rather than on an edge set:
// `handshakeOk([1, 1, 1])` is the negative case test/theory.test.mjs asserts.
export function handshakeOk(degrees) {
  return oddOfDegrees(degrees) % 2 === 0;
}

// The theorem stated over a degree sequence alone, which is what lets test/theory.test.mjs
// say something about the classical seven bridges — a graph that cannot be compiled into
// this repo's lattice model at all (see `fitsOnLattice`):
//
//   oddOfDegrees([5, 3, 3, 3]) === 4  ->  parFromDegrees(...) === 2
//
// so the historic answer is computed by the same function the game uses, and
//   fitsOnLattice([5, 3, 3, 3]) === false
//
// is the honest reason this repo ships a 4-odd substitute instance instead of Königsberg:
// Kneiphof has degree 5 and a lattice point has four unit neighbours, so no drawing of the
// classic seven bridges into unit lattice segments exists. That is a theorem-sized fact, not
// a shorthand this repo picked for convenience — see DESIGN.md 第 1.4 节.
export function oddOfDegrees(degrees) {
  let n = 0;
  for (const d of degrees) if (d % 2 === 1) n++;
  return n;
}

export function parFromDegrees(degrees) {
  return Math.max(1, oddOfDegrees(degrees) / 2);
}

// A graph embeds in the unit-segment lattice only if every vertex of degree >= 1 can be a
// lattice point, i.e. has at most four neighbours. (The converse is not claimed: degree <= 4
// is necessary, not sufficient — that is why the 4-odd instance below is *built* on the
// lattice and checked by all three evidence paths rather than argued into existence.)
export function fitsOnLattice(degrees) {
  return degrees.every((d) => d >= 1 && d <= 4);
}

// A one-stroke puzzle exists iff odd is 0 or 2. Stated as a predicate so the正反例
// in the test suite and the UI's "一笔" badge read from the same rule as par().
export function oneStrokeExists(g) {
  const o = oddCount(g);
  return o === 0 || o === 2;
}

// Degrees, for the panel's "奇点数" field and for the tier filter.
export function degreeTable(g) {
  const t = {};
  for (const v of g.verts) t[v] = g.deg[v];
  return t;
}
