// Hand-built graphs for the node suites. Everything here is small and *written down*, so a
// failure names a picture rather than a seed. The generated pool is re-proved from its
// serialised form in test/library.test.mjs.
//
// Vertex ids are `r * cols + c` and every edge is a unit lattice segment, because that is
// the model js/core/graph.js accepts.

import { hashSeed, mulberry32 } from '../js/core/rng.js';

// 3 points in a row. odd = 2 (the two ends), par = 1.
export const PATH3 = { rows: 2, cols: 4, edges: [[0, 1], [1, 2], [2, 3]], verts: [0, 1, 2, 3] };

// A 2x2 square: every vertex has degree 2, so odd = 0 and par = max(1, 0/2) = 1.
export const CYCLE4 = { rows: 2, cols: 2, edges: [[0, 1], [0, 2], [1, 3], [2, 3]], verts: [0, 1, 2, 3] };

// One edge. The smallest legal level: odd = 2, par = 1, and the construction has to survive
// a tour where the only real edge is also the only cut point.
export const SINGLE = { rows: 2, cols: 2, edges: [[0, 1]], verts: [0, 1] };

// K1,4: a centre of degree 4 (even) and four leaves (odd). odd = 4, par = 2, and the two
// strokes must be leaf-to-leaf through the centre.
export const STAR4 = { rows: 3, cols: 3, edges: [[1, 4], [3, 4], [4, 5], [4, 7]], verts: [1, 3, 4, 5, 7] };

// The four-odd-degree instance the README calls 同一定理的另一个刻度: a five-edge lattice
// graph (a path of four with two pendant legs) whose odd vertices are 0, 1, 4, 8, so par=2.
//
// It stands in for the Königsberg question and it does NOT reproduce it: the real seven
// bridges have degree sequence [5,3,3,3] over 7 edges, and a lattice point has at most four
// neighbours, so degree 5 cannot be embedded here at all. test/theory.test.mjs asserts both
// halves — the classical numbers computed from the degree vector, and the embedding refused.
export const FOUR_ODD = {
  rows: 3,
  cols: 3,
  edges: [[0, 1], [1, 2], [1, 4], [2, 5], [5, 8]],
  verts: [0, 1, 2, 4, 5, 8],
};

// The classical data, kept as a degree vector because that is all of it that is computable
// in this model: 4 landmasses, 7 bridges, degrees 5,3,3,3.
export const SEVEN_BRIDGES_DEGREES = [5, 3, 3, 3];

// Not connected: validate must refuse it, construct must throw rather than emit a partial
// cover that quietly misses edges.
export const SPLIT = { rows: 2, cols: 3, edges: [[0, 1], [3, 4]], verts: [0, 1, 3, 4] };

// Two separate 2x2 squares. Every vertex has degree 2, so `odd = 0` and the theorem's
// formula says par = 1 — while the true minimum cover is 2, one per component. This is the
// connectivity premise of the theorem made visible: validate refuses the graph, and
// test/bruteforce.test.mjs asserts the DP disagrees with par *because* the premise is gone.
export const TWO_SQUARES = {
  rows: 3,
  cols: 6,
  edges: [[0, 1], [0, 6], [1, 7], [6, 7], [3, 4], [3, 9], [4, 10], [9, 10]],
  verts: [0, 1, 3, 4, 6, 7, 9, 10],
};

// The negatives, one per validator branch.
export const BAD = {
  SAME_VERTEX: { rows: 2, cols: 2, edges: [[0, 0]] },
  NON_UNIT: { rows: 2, cols: 3, edges: [[0, 2]] },
  DUPE: { rows: 2, cols: 3, edges: [[0, 1], [0, 1]] },
  OFF_LATICE: { rows: 2, cols: 2, edges: [[0, 4]] },
  NO_EDGES: { rows: 2, cols: 2, edges: [] },
  ISOLATED_DECLARED: { rows: 2, cols: 3, edges: [[0, 1]], verts: [0, 1, 5] },
  UNDECLARED: { rows: 2, cols: 3, edges: [[0, 1]], verts: [0] },
  TOO_BIG: { rows: 13, cols: 13, edges: [[0, 1]] },
};

// A connected random graph on the lattice: random spanning tree over a grown region plus
// random extra edges from the induced set. Written here as well as in js/core/make.js on
// purpose — the parity assertions should not inherit the generator's own filters.
export function latticeNeighbours(rows, cols, v) {
  const r = Math.floor(v / cols), c = v % cols;
  const out = [];
  if (r > 0) out.push(v - cols);
  if (r < rows - 1) out.push(v + cols);
  if (c > 0) out.push(v - 1);
  if (c < cols - 1) out.push(v + 1);
  return out;
}

export function randomGraph(seed, { rows = 6, cols = 6, verts = 8, extra = 3 } = {}) {
  const rng = mulberry32(hashSeed(String(seed)));
  const all = [];
  for (let v = 0; v < rows * cols; v++) all.push(v);
  const chosen = new Set([all[Math.floor(rng() * all.length)]]);
  const tree = [];
  let guard = 0;
  while (chosen.size < verts && guard++ < 500) {
    const from = [...chosen][Math.floor(rng() * chosen.size)];
    const cand = latticeNeighbours(rows, cols, from).filter((w) => !chosen.has(w));
    if (!cand.length) continue;
    const to = cand[Math.floor(rng() * cand.length)];
    chosen.add(to);
    tree.push([Math.min(from, to), Math.max(from, to)]);
  }
  const induced = [];
  for (const v of chosen) {
    for (const w of latticeNeighbours(rows, cols, v)) {
      if (chosen.has(w)) induced.push([Math.min(v, w), Math.max(v, w)]);
    }
  }
  const uniq = new Map();
  for (const [a, b] of tree) uniq.set(`${a}:${b}`, true);
  const free = [...new Map(induced.map((e) => [`${e[0]}:${e[1]}`, e])).keys()].filter((k) => !uniq.has(k));
  const edges = tree.slice();
  for (let i = 0; i < extra && free.length; i++) {
    const k = Math.floor(rng() * free.length);
    const [a, b] = free[k].split(':').map(Number);
    edges.push([a, b]);
    free.splice(k, 1);
  }
  const vertsList = [...chosen].sort((x, y) => x - y);
  return { rows, cols, edges, verts: vertsList };
}

// Degree-based shape numbers, recomputed here so theory.test.mjs can cross-check
// js/core/make.js's shapeStats rather than trusting it.
export function shapeFromSpec(spec) {
  const deg = new Map();
  for (const [a, b] of spec.edges) {
    deg.set(a, (deg.get(a) || 0) + 1);
    deg.set(b, (deg.get(b) || 0) + 1);
  }
  let forks = 0;
  let leaves = 0;
  let odd = 0;
  for (const d of deg.values()) {
    if (d >= 3) forks++;
    if (d === 1) leaves++;
    if (d % 2 === 1) odd++;
  }
  const v = deg.size;
  const m = spec.edges.length;
  return { odd, forks, leaves, verts: v, edges: m, cycles: m - v + 1, degrees: [...deg.values()].sort((x, y) => x - y) };
}
