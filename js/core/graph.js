// The graph model — the whole game in one plain, JSON-serialisable spec.
//
//   { rows: 8, cols: 8, edges: [[a, b], ...], verts: [a, b, ...] }   vertex id = r*cols + c
//
// Vertices are lattice points; an edge is a *unit* lattice segment between two
// neighbouring points (|dr| + |dc| === 1). `verts` is the declared vertex set: the edges
// already imply it, and that is exactly why it is written down — a baked level states what
// it contains, and `validate` fails loudly when the statement and the edges disagree
// (an isolated declared point, or an edge touching an undeclared point).
//
// Pure module: no DOM, no window, no canvas. `node --test` and the browser drive this same
// object, which is the only reason the theory assertions in test/*.test.mjs and the
// @pointer suite can be aimed at one source of truth.

export const MAX_EDGES = 60;
export const MAX_LAT = 12;

// Two lattice points, smaller id first, so an edge has exactly one canonical form.
export function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function makeSpec(rows, cols, edges, verts) {
  const out = { rows, cols, edges: edges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]) };
  // A pin touched by three edges appears three times in `edges.flat()`; the declared set is
  // a *set* (validate refuses the same pin declared twice), so dedupe here rather than
  // emitting a spec that the gate immediately rejects.
  out.verts = (verts ? verts.slice() : out.edges.flat()).filter((v, i, xs) => xs.indexOf(v) === i).sort((x, y) => x - y);
  return out;
}

// Structural sanity. Used by the generator, by the bake gate and by the negative tests:
// every branch here is one way a hand-edited or corrupt level file could put a picture on
// screen that its printed number does not describe.
//
// `declared` is the bake's claim `{ odd, par }`, checked against what the edges actually
// say. That is what turns "this level was measured" into "this level is still measured".
// Returns null when the graph is fine, otherwise a human-readable reason.
export function validate(spec, declared) {
  if (!spec || typeof spec !== 'object') return 'spec is not an object';
  const { rows, cols, edges } = spec;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return 'rows and cols must be integers';
  if (rows < 2 || cols < 2) return 'the lattice needs at least 2x2 points';
  if (rows > MAX_LAT || cols > MAX_LAT) return `the lattice is bigger than ${MAX_LAT}x${MAX_LAT}`;
  if (!Array.isArray(edges)) return 'edges must be an array';
  if (!edges.length) return 'the graph has no edges';
  if (edges.length > MAX_EDGES) return `more than ${MAX_EDGES} edges`;

  const deg = new Map();
  const seen = new Set();
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2) return 'an edge is not a pair';
    const [a, b] = e;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return 'an edge endpoint is not a vertex id';
    if (a < 0 || b < 0 || a >= rows * cols || b >= rows * cols) return 'an edge endpoint is off the lattice';
    if (a === b) return 'an edge starts and ends at the same vertex';
    const ar = Math.floor(a / cols), ac = a % cols, br = Math.floor(b / cols), bc = b % cols;
    if (Math.abs(ar - br) + Math.abs(ac - bc) !== 1) return 'an edge is not a unit lattice segment';
    const k = edgeKey(a, b);
    if (seen.has(k)) return 'duplicate edge';
    seen.add(k);
    deg.set(a, (deg.get(a) || 0) + 1);
    deg.set(b, (deg.get(b) || 0) + 1);
  }

  if (spec.verts !== undefined) {
    if (!Array.isArray(spec.verts)) return 'verts must be an array';
    const dup = new Set();
    for (const v of spec.verts) {
      if (!Number.isInteger(v) || v < 0 || v >= rows * cols) return `declared vertex ${v} is off the lattice`;
      if (dup.has(v)) return `declared vertex ${v} twice`;
      dup.add(v);
      if (!deg.has(v)) return `declared vertex ${v} is isolated`;
    }
    for (const v of deg.keys()) if (!dup.has(v)) return `vertex ${v} has edges but is not declared`;
  }

  let odd = 0;
  for (const d of deg.values()) if (d % 2 === 1) odd++;
  // The handshake lemma makes an odd `odd` unreachable from a real edge set, so this
  // branch can only fire on a *declared* degree claim — which is precisely the case worth
  // catching: `declared.odd` is the number printed on screen. See test/theory.test.mjs.
  if (odd % 2 === 1) return 'an odd number of odd-degree vertices (handshake lemma violated)';
  if (declared) {
    if (declared.odd !== odd) return `declared odd ${declared.odd}, the edges say ${odd}`;
    if (declared.par !== Math.max(1, odd / 2)) return `declared par ${declared.par}, the theorem says ${Math.max(1, odd / 2)}`;
  }

  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const start = adj.keys().next().value;
  const stack = [start];
  const hit = new Set([start]);
  while (stack.length) {
    const v = stack.pop();
    for (const w of adj.get(v)) if (!hit.has(w)) { hit.add(w); stack.push(w); }
  }
  if (hit.size !== adj.size) return `the graph is not connected (${hit.size} of ${adj.size} vertices reachable)`;
  return null;
}

// Pre-typed arrays plus adjacency, so the constructors and the search never re-read
// objects inside their loops.
export function compile(spec) {
  const { rows, cols, edges } = spec;
  const n = rows * cols;
  const m = edges.length;
  const g = {
    rows, cols, n, m,
    ea: new Int32Array(m),
    eb: new Int32Array(m),
    deg: new Int32Array(n),
    used: new Uint8Array(n),
    verts: [],
    edges: [],
    inc: Array.from({ length: n }, () => []),
  };
  const seen = new Set();
  for (let e = 0; e < m; e++) {
    const a = Math.min(edges[e][0], edges[e][1]);
    const b = Math.max(edges[e][0], edges[e][1]);
    const k = edgeKey(a, b);
    if (seen.has(k)) throw new Error(`compile: duplicate edge ${k}`);
    seen.add(k);
    g.ea[e] = a;
    g.eb[e] = b;
    g.deg[a]++;
    g.deg[b]++;
    g.edges.push([a, b]);
  }
  for (let v = 0; v < n; v++) {
    if (g.deg[v]) { g.used[v] = 1; g.verts.push(v); }
  }
  for (let e = 0; e < m; e++) {
    g.inc[g.ea[e]].push(e);
    g.inc[g.eb[e]].push(e);
  }
  return g;
}

// The round trip the bake gate insists on: compiled -> plain object -> compiled.
export function toSpec(g) {
  return { rows: g.rows, cols: g.cols, edges: g.edges.map(([a, b]) => [a, b]), verts: g.verts.slice() };
}

export function edgeBetween(g, a, b) {
  for (const e of g.inc[a]) if (g.ea[e] === b || g.eb[e] === b) return e;
  return -1;
}

export function otherEnd(g, e, v) {
  return g.ea[e] === v ? g.eb[e] : g.ea[e];
}

export function rc(id, g) {
  return { r: Math.floor(id / g.cols), c: id % g.cols };
}
