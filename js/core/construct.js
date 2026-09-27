// The upper bound, built rather than asserted: here is a cover with exactly `par` strokes.
//
//   1. pair up the odd-degree vertices (any matching will do),
//   2. add one *virtual* edge per pair -> every vertex is now even and the graph is still
//      connected, so an Euler circuit exists,
//   3. run Hierholzer to get that circuit,
//   4. cut the circuit at the virtual edges -> odd/2 strokes of real edges.
//
// Step 4 yields exactly odd/2 pieces, not "at most": each odd vertex is in precisely one
// virtual edge, so two virtual edges can never be adjacent in the circuit, so no cut can
// produce an empty piece. `verify()` re-checks the whole promise against the edge set
// instead of trusting that argument, and bake.mjs refuses a level whose piece count
// disagrees with theory.

import { edgeBetween, otherEnd } from './graph.js';
import { oddVertices, oddCount, par } from './theory.js';

// A plain matching over the odd vertices. The pairing is not unique and no level claims a
// difficulty that depends on it — only the *count* is printed, and the count is forced by
// the theorem.
export function pairOdd(g, rng) {
  const odd = oddVertices(g);
  const pool = rng ? rng.shuffle(odd.slice()) : odd.slice();
  const pairs = [];
  for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]]);
  return pairs;
}

// Hierholzer over the augmented multigraph. Edge ids >= g.m are virtual (pair index
// `id - g.m`). Returns the closed tour as vertices plus, for each vertex, the id of the
// edge used to arrive there (-1 for the start).
export function eulerTour(g, pairs, start) {
  const total = g.m + pairs.length;
  const adj = Array.from({ length: g.n }, () => []);
  for (let e = 0; e < g.m; e++) {
    adj[g.ea[e]].push({ to: g.eb[e], e });
    adj[g.eb[e]].push({ to: g.ea[e], e });
  }
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    const e = g.m + i;
    adj[a].push({ to: b, e });
    adj[b].push({ to: a, e });
  }
  const used = new Uint8Array(total);
  const ptr = new Int32Array(g.n);
  const v0 = start === undefined ? g.verts[0] : start;
  const stack = [{ v: v0, e: -1 }];
  const popV = [];
  const popE = [];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const list = adj[top.v];
    let i = ptr[top.v];
    while (i < list.length && used[list[i].e]) i++;
    if (i === list.length) {
      popV.push(top.v);
      popE.push(top.e);
      stack.pop();
    } else {
      ptr[top.v] = i + 1;
      const step = list[i];
      used[step.e] = 1;
      stack.push({ v: step.to, e: step.e });
    }
  }
  for (let e = 0; e < total; e++) if (!used[e]) return null; // disconnected augmentation: impossible for a legal spec
  const verts = popV.reverse();
  const edgesIn = popE.reverse();
  return { verts, edgesIn };
}

// Rotate a closed tour so it begins right after the first virtual edge. Without this the
// linear cut below would split one stroke into two partial pieces at the wrap-around and
// report odd/2 + 1 strokes — a real bug this file had, caught by `verify` rather than by
// reading.
//
// The tour is verts[0..k] with verts[0] === verts[k], and edgesIn[i] is the edge that
// entered verts[i]. Starting at verts[j] therefore means
//   verts:  j .. k-1, then 0 .. j      (k + 1 entries, first === last)
//   edges:  -1, then j+1 .. k, then 1 .. j
function rotateAfterVirtual(g, tour) {
  const { verts, edgesIn } = tour;
  const k = verts.length - 1;
  let j = -1;
  for (let i = 1; i <= k; i++) if (edgesIn[i] >= g.m) { j = i; break; }
  if (j < 0) return tour;
  return {
    verts: verts.slice(j, k).concat(verts.slice(0, j + 1)),
    edgesIn: [-1].concat(edgesIn.slice(j + 1, k + 1), edgesIn.slice(1, j + 1)),
  };
}

function edgeRun(g, verts) {
  const edges = [];
  for (let i = 0; i + 1 < verts.length; i++) {
    const e = edgeBetween(g, verts[i], verts[i + 1]);
    if (e < 0) throw new Error(`construct: ${verts[i]}->${verts[i + 1]} is not an edge`);
    edges.push(e);
  }
  return edges;
}

// The constructed cover: `par` strokes, each an edge-simple vertex path.
export function construct(g, opts = {}) {
  const rng = opts.rng;
  const pairs = opts.pairs || pairOdd(g, rng);
  const raw = eulerTour(g, pairs, opts.start);
  if (!raw) throw new Error('construct: the augmented graph has no Euler circuit, so the level is not connected');
  const tour = rotateAfterVirtual(g, raw);
  const trails = [];
  let cur = [tour.verts[0]];
  for (let i = 1; i < tour.verts.length; i++) {
    const e = tour.edgesIn[i];
    if (e >= g.m) {
      if (cur.length > 1) trails.push(cur);
      cur = [tour.verts[i]];
    } else {
      cur.push(tour.verts[i]);
    }
  }
  if (cur.length > 1) trails.push(cur);
  const out = trails.map((verts) => ({ verts, edges: edgeRun(g, verts) }));
  return { trails: out, pairs };
}

// Independent check of what `construct` promises, written against the edge set rather than
// against the algorithm: disjoint, exhaustive, and every stroke is a genuine trail.
// Returns null when the cover is sound, otherwise the reason.
export function verify(g, trails) {
  if (!Array.isArray(trails)) return 'trails is not an array';
  const seen = new Uint8Array(g.m);
  for (let i = 0; i < trails.length; i++) {
    const t = trails[i];
    if (!t.verts || t.verts.length < 2) return `stroke ${i} is empty`;
    if (t.verts.length !== t.edges.length + 1) return `stroke ${i} has ${t.edges.length} edges for ${t.verts.length} vertices`;
    for (let k = 0; k < t.edges.length; k++) {
      const e = t.edges[k];
      if (e < 0 || e >= g.m) return `stroke ${i} references edge ${e} that does not exist`;
      const a = t.verts[k], b = t.verts[k + 1];
      if (g.ea[e] !== b && g.eb[e] !== b) return `stroke ${i} leaves ${a} for ${b}, which is not edge ${e}`;
      if (otherEnd(g, e, a) !== b) return `stroke ${i} steps ${a}->${b} along an edge that does not join them`;
      if (seen[e]) return `stroke ${i} reuses edge ${e}, which an earlier stroke already drew`;
      seen[e] = 1;
    }
  }
  for (let e = 0; e < g.m; e++) if (!seen[e]) return `edge ${e} is covered by no stroke`;
  return null;
}

// The single entry point bake and the tests use: build, count, and fail loudly if the
// construction and the theorem disagree. `trails.length === par(g)` is the whole claim.
export function coverWith(g, opts = {}) {
  const want = par(g);
  let built;
  try {
    built = construct(g, opts);
  } catch (err) {
    return { ok: false, error: err.message, trails: [], pairs: [], par: want, odd: oddCount(g) };
  }
  const { trails, pairs } = built;
  const err = verify(g, trails);
  if (err) return { ok: false, error: err, trails, pairs, par: want };
  if (trails.length !== want) {
    return { ok: false, error: `constructed ${trails.length} strokes, theorem says ${want}`, trails, pairs, par: want };
  }
  return { ok: true, trails, pairs, par: want, odd: oddCount(g) };
}
