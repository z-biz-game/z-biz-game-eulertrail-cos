// Geometry, with no canvas in sight.
//
// The view owns the device-pixel transform; this file owns the two mappings the game is
// actually tested on:
//
//   geomFor()    -> how a rows x cols lattice of pins is laid into a w x h box
//   vertexLocal / edgeAtLocal -> the inverse, i.e. "what did the finger just touch"
//
// Keeping it pure is what lets test/geometry.test.mjs assert the >= 12px hit tolerance and
// the "a drag that leaves the board cannot teleport the pen to another edge" rule without a
// browser. `js/view.js` adds the pixel transform and calls these.

export const MIN_TOL = 12;
export const PAD = 30;

export function geomFor(w, h, rows, cols) {
  const cell = Math.max(12, Math.floor(Math.min((w - PAD * 2) / (cols - 1), (h - PAD * 2) / (rows - 1))));
  const ox = Math.round((w - cell * (cols - 1)) / 2);
  const oy = Math.round((h - cell * (rows - 1)) / 2);
  return { cell, ox, oy, vw: w, vh: h };
}

// Canvas-local pixel position of lattice point (r, c).
export function vertexLocal(g, gm, r, c) {
  return { x: gm.ox + c * gm.cell, y: gm.oy + r * gm.cell };
}

// Inverse of vertexLocal, and the clamp the rules need: a pointer outside the board is
// snapped to the outermost pin row/column instead of being allowed to wander off to a
// coordinate that means nothing.
export function clampRC(g, r, c) {
  return {
    r: Math.max(0, Math.min(g.rows - 1, r)),
    c: Math.max(0, Math.min(g.cols - 1, c)),
  };
}

export function distPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Nearest pin within `tol` pixels, or -1. Pins are laid out on a grid, so the answer is a
// rounding away rather than a scan — but only a *declared* pin counts: a lattice point with
// no edges is not drawn and must not be touchable, and a rounded coordinate outside the
// lattice would wrap to a row that means something else entirely.
export function vertexAtLocal(g, gm, x, y, tol = MIN_TOL) {
  const c = Math.round((x - gm.ox) / gm.cell);
  const r = Math.round((y - gm.oy) / gm.cell);
  if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) return -1;
  const p = vertexLocal(g, gm, r, c);
  if (Math.hypot(x - p.x, y - p.y) > tol) return -1;
  const v = r * g.cols + c;
  return g.used[v] ? v : -1;
}

// Which edge corridor the pointer is inside, or -1.
//
// Corridors of perpendicular edges overlap near a shared pin, so the caller (js/view.js)
// only ever *offers* the result to the rules, which reject an edge that is not incident to
// where the pen actually is. Geometry answers "what is under the finger", never "what is
// legal" — that split is the reason @pointer can prove a real drag reaches an edge.
export function edgeAtLocal(g, gm, x, y, tol = MIN_TOL) {
  let best = -1;
  let bestD = Infinity;
  for (let e = 0; e < g.m; e++) {
    const a = vertexLocal(g, gm, Math.floor(g.ea[e] / g.cols), g.ea[e] % g.cols);
    const b = vertexLocal(g, gm, Math.floor(g.eb[e] / g.cols), g.eb[e] % g.cols);
    const d = distPointSeg(x, y, a.x, a.y, b.x, b.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return bestD <= tol ? best : -1;
}
