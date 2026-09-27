// Geometry, asserted without a browser: the hit tolerance the spec fixes (>= 12px), the
// clamp an off-board drag needs, and the split that keeps @pointer honest -- geometry says
// what is under a finger, js/core/game.js says whether it is legal.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { compile } from '../js/core/graph.js';
import {
  MIN_TOL, PAD, geomFor, vertexLocal, clampRC, distPointSeg, vertexAtLocal, edgeAtLocal,
} from '../js/core/geometry.js';
import { FOUR_ODD, STAR4, SINGLE } from './fixture.mjs';

const g3 = compile(FOUR_ODD);            // rows 3, cols 3
const gm = geomFor(400, 400, 3, 3);      // cell 170, origin (30, 30)

test('the tolerance the spec demands is the tolerance the code ships', () => {
  ok(MIN_TOL >= 12, `MIN_TOL is ${MIN_TOL}, which must be at least 12`);
  eq(PAD, 30, 'board padding in css pixels');
});

test('geomFor lays the lattice inside the box and centres it', () => {
  eq(gm.vw, 400, 'width echoed back');
  eq(gm.cell, 170, 'floor((400 - 2*30) / 2)');
  eq(gm.ox, 30, 'centred horizontally');
  eq(gm.oy, 30, 'centred vertically');
  const wide = geomFor(900, 300, 8, 8);
  ok(wide.cell * 7 + 2 * PAD <= 900, 'eight rows of pins fit the height');
  ok(wide.oy >= PAD - 1, `the board is not flush with the canvas edge (oy ${wide.oy})`);
  const tiny = geomFor(60, 60, 8, 8);
  ok(tiny.cell >= 12, `a 60px box still gets a ${tiny.cell}px pitch rather than 0`);
});

test('vertexLocal is the forward map, and it is exact at the corners', () => {
  eq(vertexLocal(g3, gm, 0, 0), { x: 30, y: 30 }, 'top-left pin');
  eq(vertexLocal(g3, gm, 2, 2), { x: 370, y: 370 }, 'bottom-right pin');
  eq(vertexLocal(g3, gm, 0, 2), { x: 370, y: 30 }, 'top-right pin');
});

test('a pin 12px away is a hit and 13px is not', () => {
  eq(vertexAtLocal(g3, gm, 42, 30, 12), 0, 'exactly at the tolerance, along the axis');
  eq(vertexAtLocal(g3, gm, 30, 42, 12), 0, 'and along the other axis');
  eq(vertexAtLocal(g3, gm, 43, 30, 12), -1, 'one pixel past it');
  eq(vertexAtLocal(g3, gm, 30, 30, 12), 0, 'dead centre');
  eq(vertexAtLocal(g3, gm, 30, 30, 0), 0, 'zero tolerance still hits an exact pin');
});

test('a lattice point with no edges is not a pin and cannot be touched', () => {
  // FOUR_ODD declares 0,1,2,4,5,8 -- so (1,0)=3 and (2,1)=7 are empty field positions.
  eq(g3.used[3], 0, 'pin 3 is not part of the level');
  eq(vertexAtLocal(g3, gm, 30, 200, 12), -1, 'pressing the empty position hits nothing');
  eq(vertexAtLocal(g3, gm, 200, 370, 12), -1, 'nor the other empty position');
  eq(vertexAtLocal(g3, gm, 200, 200, 12), 4, 'while the centre pin is right there');
});

test('pressing outside the board resolves to nothing, not to a wrapped row', () => {
  eq(vertexAtLocal(g3, gm, -500, -500, 12), -1, 'far top-left');
  eq(vertexAtLocal(g3, gm, 900, 900, 12), -1, 'far bottom-right');
  // A row index above the field would wrap into the last row's ids without the range check.
  eq(vertexAtLocal(g3, gm, 30, 30 - 170, 12), -1, 'the pin one row above the board');
  eq(edgeAtLocal(g3, gm, 30, 30 - 170, 12), -1, 'and no edge corridor reaches that far');
});

test('clampRC is the drag clamp: off-board coordinates snap to the outer ring', () => {
  eq(clampRC(g3, -5, 99), { r: 0, c: 2 }, 'both axes out of range, in opposite directions');
  eq(clampRC(g3, -1, -1), { r: 0, c: 0 }, 'top-left');
  eq(clampRC(g3, 1, 1), { r: 1, c: 1 }, 'in range, untouched');
  const big = compile(STAR4);
  eq(clampRC(big, 999, 999), { r: 2, c: 2 }, 'a 3x3 field still ends at (2,2)');
});

test('edgeAtLocal answers the corridor under the point, within tolerance', () => {
  // Edge 0 of FOUR_ODD joins pin 0 (30,30) and pin 1 (200,30).
  eq(g3.ea[0], 0, 'edge 0 from pin 0');
  eq(g3.eb[0], 1, 'to pin 1');
  eq(edgeAtLocal(g3, gm, 115, 30, 12), 0, 'its midpoint');
  eq(edgeAtLocal(g3, gm, 115, 40, 12), 0, '10px off the line is still inside the corridor');
  eq(edgeAtLocal(g3, gm, 115, 60, 12), -1, '30px off is nothing');
  eq(edgeAtLocal(g3, gm, 30, 30, 12), 0, 'a pin is also on its edge; the nearest wins');
});

test('edgeAtLocal is geometry only: it answers for edges the pen may not legally cross', () => {
  // The vertical edge 2 (pin 1 -> pin 4) is at x = 200. A point next to pin 0 is on edge 0,
  // never on edge 2 -- and it is up to js/core/game.js to refuse a step that is not
  // incident to the pen. Geometry has no idea where the pen is.
  eq(edgeAtLocal(g3, gm, 190, 30, 12), 0, 'closer to the horizontal edge');
  eq(edgeAtLocal(g3, gm, 200, 115, 12), 2, 'and the vertical one answers on its own corridor');
  eq(edgeAtLocal(g3, gm, 200, 115, 3), 2, 'a tighter tolerance does not change which edge');
});

test('a single-edge level has exactly one corridor and one pair of pins', () => {
  const one = compile(SINGLE);
  const small = geomFor(200, 200, 2, 2);
  eq(edgeAtLocal(one, small, 100, 30, 12), 0, 'the middle of the only edge (y = 30)');
  eq(vertexAtLocal(one, small, small.ox, small.oy, 12), 0, 'its first pin');
  eq(vertexAtLocal(one, small, small.ox + small.cell, small.oy + small.cell, 12), -1, 'the diagonal pin does not exist here');
  eq(edgeAtLocal(one, small, small.ox + small.cell, small.oy + small.cell, 12), -1, 'and no corridor passes it');
});

test('distPointSeg is the primitive underneath, including its degenerate case', () => {
  eq(distPointSeg(3, 4, 0, 0, 0, 0), 5, 'a zero-length segment falls back to point distance');
  eq(distPointSeg(5, 5, 0, 0, 10, 0), 5, 'perpendicular distance to a horizontal segment');
  eq(distPointSeg(-4, 0, 0, 0, 10, 0), 4, 'past an endpoint the clamp to the end applies');
  eq(distPointSeg(14, 3, 10, 0, 10, 8), 4, 'perpendicular to a vertical segment, inside its span');
  eq(distPointSeg(14, 12, 10, 0, 10, 8), Math.hypot(4, 4), 'past the far end it clamps to that endpoint');
});

test('vertexAtLocal and vertexLocal round trip over every declared pin', () => {
  for (const v of g3.verts) {
    const r = Math.floor(v / g3.cols), c = v % g3.cols;
    const p = vertexLocal(g3, gm, r, c);
    eq(vertexAtLocal(g3, gm, p.x, p.y, 1), v, `pin ${v} found at its own coordinates`);
    eq(edgeAtLocal(g3, gm, p.x, p.y, 1) >= 0, true, `pin ${v} lies on at least one corridor`);
  }
});

run();
