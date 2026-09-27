// The rules, and the three 口径 the whole repo is built on. Everything here drives the same
// js/core/game.js object the canvas drives, so a green suite is a green game.

import { test, run, ok, eq, fail } from '../tools/harness.mjs';
import { compile } from '../js/core/graph.js';
import { par, oddCount } from '../js/core/theory.js';
import { construct } from '../js/core/construct.js';
import { rngFrom } from '../js/core/rng.js';
import {
  createGame, freeMoves, strokesUsed, beginStroke, stepTo, endStroke, undoStroke, reset, hint, grade, snapshot,
} from '../js/core/game.js';
import { PATH3, CYCLE4, SINGLE, STAR4, FOUR_ODD } from './fixture.mjs';

// A "figure eight": two 2x2 squares sharing the centre pin. Eulerian (odd = 0, par = 1), so
// the single stroke has to pass through pin 4 twice -- the model's one-stroke is a *trail*,
// not a path, and this fixture is how the suite says so.
const FIG8 = {
  rows: 3, cols: 3,
  edges: [[0, 1], [0, 3], [1, 4], [3, 4], [4, 5], [4, 7], [5, 8], [7, 8]],
  verts: [0, 1, 3, 4, 5, 7, 8],
};
// The Euler tour of FIG8, written out: 0-1-4-5-8-7-4-3-0. Pin 4 has degree four and the
// tour is closed, so it passes through 4 exactly deg/2 = 2 times: the visits at positions 2
// and 6 of the list below. (An earlier draft of this file claimed three, contradicting the
// list written next to it.)
const FIG8_TOUR = [0, 1, 4, 5, 8, 7, 4, 3, 0];

function mk(spec, id = 'fixture') {
  const g = compile(spec);
  const built = construct(g, { rng: rngFrom(`mk-${id}`) });
  return { id, spec, g, par: par(g), odd: oddCount(g), trails: built.trails };
}

test('createGame reads the theorem off the level and starts clean', () => {
  const game = createGame(mk(FOUR_ODD, 'four'));
  eq(game.par, 2, 'two strokes allowed');
  eq(game.odd, 4, 'four odd pins');
  eq(game.covered, 0, 'nothing drawn');
  eq(game.g.m, 5, 'five edges');
  eq(Array.from(game.drawn), [0, 0, 0, 0, 0], 'no edge marked');
  eq(game.outcome, 'playing', 'playing');
  eq(game.baked.length, 2, 'the baked proof has par strokes');
  eq(snapshot(game), { covered: 0, total: 5, strokes: 0, par: 2, odd: 4, outcome: 'playing' }, 'the panel snapshot');
});

test('the pen may only start where an undrawn edge leaves', () => {
  const game = createGame(mk(SINGLE, 'single'));
  eq(beginStroke(game, 0).ok, true, 'pin 0 has the only edge');
  const lifted = endStroke(game);
  eq(lifted.committed, false, 'a press that never moved drew nothing');
  // ...so pin 0 still has an undrawn edge and the next press is legal. (An earlier draft
  // asserted the opposite here on the false premise "begin + lift draws an edge" — it does
  // not; only stepTo ever puts ink down.)
  eq(beginStroke(game, 0).ok, true, 'the same pin starts again: nothing was spent');
  stepTo(game, 1);                       // now the edge is drawn and the stroke files itself
  const after = beginStroke(game, 0);
  eq(after.ok, false, 'once every edge is drawn nothing may start');
  eq(after.reason, 'complete', 'and the reason is the finished board, not the stranded pin');
  // The "no undrawn edge at that vertex" branch needs a stranded pin on a *live* level:
  // in K1,4 the first leaf-centre-leaf stroke strands both of its leaves while two edges
  // remain elsewhere on the board.
  const star = createGame(mk(STAR4, 'star'));
  beginStroke(star, 1); stepTo(star, 4); stepTo(star, 3);   // auto-ends at leaf 3
  eq(beginStroke(star, 4).ok, true, 'the centre still has two ways out');
  endStroke(star);
  const again = beginStroke(star, 3);
  eq(again.ok, false, 'no stroke from a stranded pin');
  ok(/no undrawn edge/.test(again.reason), `reason: ${again.reason}`);
  eq(beginStroke(star, 99).ok, false, 'a pin that is not even in the level');
});

test('freeMoves lists only undrawn incident edges, and otherEnd gives their far pin', () => {
  const game = createGame(mk(STAR4, 'star'));
  eq(freeMoves(game, 4).length, 4, 'the centre of K1,4 has four ways out');
  eq(freeMoves(game, 1).length, 1, 'a leaf has one');
  eq(freeMoves(game, 0).length, 0, 'an undeclared pin has none');
  beginStroke(game, 4);
  stepTo(game, 1);
  eq(freeMoves(game, 4).length, 3, 'one edge is spent');
  eq(freeMoves(game, 1).length, 0, 'and the leaf behind it is now stranded');
});

test('a step needs an edge, and cannot stay put', () => {
  const game = createGame(mk(FOUR_ODD, 'four'));
  eq(stepTo(game, 1).reason, 'no stroke in progress', 'a step before any press is refused');
  beginStroke(game, 0);
  eq(stepTo(game, 0).reason, 'same vertex', 'zero-length step');
  eq(stepTo(game, 8).reason, 'no edge between those pins', '0 and 8 are not neighbours');
  eq(stepTo(game, 4).reason, 'no edge between those pins', 'nor 0 and 4');
  eq(stepTo(game, 99).reason, 'no edge between those pins', 'and a pin off the field is not an edge either');
  const r = stepTo(game, 1);
  eq(r.ok, true, '0-1 is edge 0');
  eq(r.edge, 0, 'reported edge');
  eq(game.covered, 1, 'coverage moved');
});

test('口径 1: a stroke is a trail -- vertices may repeat, edges may not', () => {
  const game = createGame(mk(FIG8, 'fig8'));
  eq(game.par, 1, 'Eulerian: one stroke is enough');
  eq(game.odd, 0, 'no odd pin');
  beginStroke(game, FIG8_TOUR[0]);
  for (let i = 1; i < FIG8_TOUR.length; i++) {
    const r = stepTo(game, FIG8_TOUR[i]);
    if (!r.ok) fail(`step ${FIG8_TOUR[i - 1]}->${FIG8_TOUR[i]} refused: ${r.reason}`);
  }
  eq(game.covered, 8, 'all eight edges in one stroke');
  eq(game.outcome, 'won', 'and it is a win');
  const visits = game.strokes[0].verts.filter((v) => v === 4).length;
  // Closed tour, pin 4 has degree 4: every pass-through consumes two of its edges, so it
  // is crossed deg/2 = 2 times. The tour list above visibly contains two 4s; the earlier
  // "three" contradicted its own fixture.
  eq(visits, 2, 'the pen passed pin 4 twice in a single stroke');
  eq(new Set(game.strokes[0].edges).size, 8, 'while no edge appears twice');
});

test('口径 2: stepping back over a spent edge is refused as "drawn", and nothing breaks', () => {
  const game = createGame(mk(CYCLE4, 'cycle'));
  beginStroke(game, 0);
  stepTo(game, 1);
  const back = stepTo(game, 0);
  eq(back.ok, false, 'the way back is the same edge');
  eq(back.reason, 'drawn', 'and it is named as already drawn, not as an error');
  eq(game.covered, 1, 'no double count');
  eq(game.outcome, 'playing', 'no error state, no penalty');
  // The ring is still finishable from here, in the same stroke.
  stepTo(game, 3);
  stepTo(game, 2);
  const closed = stepTo(game, 0);
  eq(closed.ok, true, 'the closing step is a different, undrawn edge');
  eq(closed.autoEnded, true, 'and it strands the pen, so the stroke files itself');
  eq(game.outcome, 'won', 'one stroke, all four edges');
  eq(game.strokes.length, 1, 'one stroke');
});

test('口径 2: dragging over an already drawn edge does nothing at all', () => {
  const game = createGame(mk(STAR4, 'star'));
  beginStroke(game, 1);
  stepTo(game, 4);
  stepTo(game, 3);              // leaf-centre-leaf, stroke ends naturally at 3
  eq(game.outcome, 'playing', 'two edges of four');
  eq(game.strokes.length, 1, 'one stroke committed');
  beginStroke(game, 5);
  stepTo(game, 4);              // 5-4 is a fresh edge: coverage legitimately moves to 3
  eq(game.covered, 3, 'the second stroke drew its own edge first');
  // The baseline for "does nothing at all" is the state *before the refused drag*, not the
  // state before the stroke that contained it. (The first draft snapshotted before 5-4 and
  // then blamed the refused 4-3 step for the coverage the legal 5-4 step had caused.)
  const before = { covered: game.covered, strokes: game.strokes.length, drawn: Array.from(game.drawn) };
  const over = stepTo(game, 3);  // pin 4-3 was drawn by stroke 1
  eq(over.ok, false, 'refused');
  eq(over.reason, 'drawn', 'and named as already drawn');
  eq(game.covered, before.covered, 'coverage did not move');
  eq(Array.from(game.drawn), before.drawn, 'no edge changed state');
  eq(game.outcome, 'playing', 'no error, no loss, no penalty');
  eq(game.events.filter((e) => e.type === 'again').length, 1, 'the view got one "again" to flash');
});

test('a second pass over a drawn edge mid-stroke does not double-cover', () => {
  const game = createGame(mk(FOUR_ODD, 'four'));
  beginStroke(game, 0);
  stepTo(game, 1);
  const e = game.cur.edges[0];
  const covered = game.covered;
  const wobble = stepTo(game, 0);            // straight back over the same edge
  eq(wobble.reason, 'drawn', `back over edge ${e}`);
  eq(game.covered, covered, 'no double coverage');
  eq(game.cur.verts[game.cur.verts.length - 1], 1, 'the pen did not move');
});

test('口径 1: the stroke ends by itself at a stranded pin, and the next one may start at once', () => {
  const game = createGame(mk(STAR4, 'star'));
  beginStroke(game, 1);
  const toCentre = stepTo(game, 4);
  eq(toCentre.autoEnded, false, 'the centre still has three ways out');
  const toLeaf = stepTo(game, 3);
  eq(toLeaf.autoEnded, true, 'leaf 3 is stranded, so the pen lifts itself');
  eq(game.strokes.length, 1, 'committed without any lift');
  eq(game.cur, null, 'nothing in progress');
  const next = beginStroke(game, 5);
  eq(next.ok, true, 'a new stroke can start immediately');
  eq(strokesUsed(game), 2, 'and it is the second one');
});

test('口径 3: lifting early commits what was drawn and costs nothing extra', () => {
  const game = createGame(mk(FIG8, 'fig8'));
  beginStroke(game, 0);
  stepTo(game, 1);
  stepTo(game, 4);
  const lift = endStroke(game);
  eq(lift.committed, true, 'a two-edge stroke is still a stroke');
  eq(game.strokes.length, 1, 'billed');
  eq(game.outcome, 'playing', 'no penalty for the early release');
  const again = beginStroke(game, 5);
  eq(again.ok, true, 'the next stroke starts right away');
  eq(game.strokes.length, 1, 'the unfinished one did not get counted twice');
});

test('a press that never moved is not billed as a stroke', () => {
  const game = createGame(mk(FOUR_ODD, 'four'));
  beginStroke(game, 0);
  const r = endStroke(game);
  eq(r.committed, false, 'no edges, no stroke');
  eq(game.strokes.length, 0, 'the budget did not move');
  eq(strokesUsed(game), 0, 'nor the on-screen count');
});

test('winning needs every edge: stopping one short at par is not a win', () => {
  const game = createGame(mk(FOUR_ODD, 'four'));
  // Two strokes, both committed, but the last edge is left: legal moves, no win.
  beginStroke(game, 0); stepTo(game, 1); stepTo(game, 2); endStroke(game);
  beginStroke(game, 4);
  const lifted = endStroke(game);
  eq(lifted.committed, false, 'pin 4 is a leaf, so a press there drew nothing');
  eq(game.strokes.length, 1, 'one stroke');
  beginStroke(game, 5); stepTo(game, 8); endStroke(game);
  eq(game.strokes.length, 2, 'two strokes, at par');
  eq(game.covered, 3, 'of five edges');
  eq(game.outcome, 'playing', 'so: not won');
  eq(grade(game), { key: 'open', label: '还没画完', stars: 0 }, 'graded as unfinished, not failed');
});

test('playing the baked cover wins at exactly par and grades perfect', () => {
  for (const [name, spec] of Object.entries({ PATH3, CYCLE4, STAR4, FOUR_ODD, FIG8 })) {
    const lot = mk(spec, name);
    const game = createGame(lot);
    for (let i = 0; i < lot.trails.length; i++) {
      const t = lot.trails[i];
      beginStroke(game, t.verts[0]);
      for (let k = 1; k < t.verts.length; k++) {
        const r = stepTo(game, t.verts[k]);
        if (!r.ok && r.reason !== 'drawn') fail(`${name}: baked step refused: ${r.reason}`);
      }
      endStroke(game);
    }
    eq(game.outcome, 'won', `${name} won`);
    eq(game.strokes.length, lot.par, `${name} used exactly par`);
    eq(game.covered, game.g.m, `${name} covered every edge`);
    eq(grade(game).key, 'perfect', `${name} graded perfect`);
    eq(grade(game).stars, 3, `${name} three stars`);
  }
});

test('口径 budget: par+1 strokes loses, and the board stays playable', () => {
  const game = createGame(mk(STAR4, 'star'));
  eq(game.par, 2, 'two strokes allowed');
  // Four one-edge strokes: legal moves, catastrophic budget.
  for (const leaf of [1, 3, 5, 7]) {
    beginStroke(game, leaf);
    stepTo(game, 4);
    endStroke(game);
    if (game.outcome === 'lost') break;
  }
  eq(game.outcome, 'lost', 'the third stroke is one too many');
  eq(game.strokes.length, 3, 'three committed');
  ok(game.covered < game.g.m, 'and it did not even finish');
  eq(grade(game), { key: 'over', label: '超过笔数上限', stars: 0 }, 'graded as over budget');
  // Not crashed: the player can still draw, and undo still works.
  const live = game.g.verts.find((v) => freeMoves(game, v).length);
  ok(live !== undefined, 'edges remain, so the board is not finished');
  const before = game.covered;
  beginStroke(game, live);
  const mv = freeMoves(game, live)[0];
  const r = stepTo(game, mv.to);
  eq(r.ok, true, 'a lost game still answers the pen');
  eq(game.covered, before + 1, 'and coverage still moves');
  endStroke(game);
  eq(game.outcome, 'lost', 'drawing more does not resurrect a spent budget');
  eq(undoStroke(game), true, 'undo is available');
  eq(game.outcome, 'lost', 'and one undo is not enough: still over par');
  eq(undoStroke(game), true, 'undo again');
  eq(game.outcome, 'playing', 'now the budget is back inside par, so play resumes');
  eq(game.strokes.length, game.par, 'exactly at budget');
});

test('undo takes the last stroke off the board, coverage and all', () => {
  const game = createGame(mk(FOUR_ODD, 'four'));
  beginStroke(game, 0); stepTo(game, 1); stepTo(game, 2); endStroke(game);
  const covered = game.covered;
  eq(undoStroke(game), true, 'one stroke back');
  eq(game.covered, 0, 'its edges undrawn');
  eq(Array.from(game.drawn), [0, 0, 0, 0, 0], 'the ink is gone');
  eq(game.strokes.length, 0, 'and the budget is refunded');
  eq(undoStroke(game), false, 'undoing an empty history says no');
  ok(covered > 0, 'the fixture had something to undo');
});

test('hint walks the baked proof, names a legal edge, and degrades honestly', () => {
  const game = createGame(mk(FOUR_ODD, 'four'));
  const h = hint(game);
  eq(h.kind, 'fresh', 'a clean board gets the first baked stroke');
  eq(h.stroke, 1, 'stroke one');
  eq(game.drawn[h.edge], 0, 'the suggested edge is undrawn');
  eq(h.left, 2, 'and the budget still needs it');
  const step = freeMoves(game, h.vertex).find((m) => m.to === h.to);
  ok(step, 'the hinted move is a real free move from the hinted pin');
  // Honesty goes both ways. The mk('four') proof is [[1,4],[0,1,2,5,8]]: drawing the tail
  // of stroke 2 (8-5-2) while stroke 1 sits untouched does NOT invalidate stroke 1 — the
  // 'fresh' advice is still a legal, playable move, and an earlier draft of this test
  // demanded 'diverged' here for a divergence that never touched the stroke being offered.
  beginStroke(game, 8); stepTo(game, 5); stepTo(game, 2); endStroke(game);
  const h15 = hint(game);
  eq(h15.kind, 'fresh', 'stroke 1 is still wholly undrawn, so it is still a fresh offer');
  eq(h15.stroke, 1, 'and it names stroke 1, not a half-drawn one');
  eq(game.drawn[h15.edge], 0, 'the edge it highlights is undrawn');
  // The real diverged case: complete baked stroke 1 (the single edge 1-4), then enter baked
  // stroke 2 with its first edge (0-1). Its remaining edges 1-2 and beyond are open while
  // its prefix is spent -- the only state the 'diverged' branch exists for.
  beginStroke(game, 1); stepTo(game, 4);                 // stroke 1, auto-ends at the leaf
  beginStroke(game, 0); stepTo(game, 1);                 // stroke 2, one edge deep, pen down
  const h2 = hint(game);
  ok(h2, 'there is still a hint');
  eq(h2.kind, 'diverged', `honest about the divergence: ${h2.kind}`);
  eq(h2.stroke, 2, 'and it names the half-drawn stroke');
  ok(/第 \d+ 笔/.test(h2.note), `the note names the stroke: ${h2.note}`);
  eq(game.baked[1].edges[1], h2.edge, 'it points at the first undrawn edge of that stroke');
  eq(game.drawn[h2.edge], 0, 'which really is undrawn');
  // Play it out: no hint left on a solved board.
  const done = createGame(mk(PATH3, 'path'));
  beginStroke(done, 0); stepTo(done, 1); stepTo(done, 2); stepTo(done, 3);
  eq(done.outcome, 'won', 'won');
  eq(hint(done), null, 'nothing to hint');
});

test('a won level refuses further strokes', () => {
  const game = createGame(mk(SINGLE, 'single'));
  beginStroke(game, 0); stepTo(game, 1);
  eq(game.outcome, 'won', 'one edge, one stroke, won');
  const r = beginStroke(game, 1);
  eq(r.ok, false, 'no drawing after the win');
  eq(r.reason, 'complete', 'and it is named');
  eq(stepTo(game, 0).reason, 'no stroke in progress', 'a step without a stroke cannot cheat either');
});

test('reset returns the level to the theorem, and the event log is capped', () => {
  const game = createGame(mk(STAR4, 'star'));
  beginStroke(game, 1); stepTo(game, 4); stepTo(game, 3); endStroke(game);
  reset(game);
  eq(game.covered, 0, 'coverage cleared');
  eq(game.strokes.length, 0, 'budget cleared');
  eq(game.cur, null, 'no stroke in the air');
  eq(game.outcome, 'playing', 'back to playing');
  eq(game.events.length, 0, 'reset cleared the audit trail');
  eq(game.baked.length, 2, 'the baked proof is not consumed');
  for (let i = 0; i < 500; i++) beginStroke(game, 0);   // an undeclared pin: refused, logged
  ok(game.events.length <= 400, `events capped at 400, got ${game.events.length}`);
});

test('strokesUsed counts the stroke in the air, snapshot does not lie', () => {
  const game = createGame(mk(FIG8, 'fig8'));
  beginStroke(game, 0);
  eq(strokesUsed(game), 1, 'the press put a stroke on the paper: the budget reserves it');
  stepTo(game, 1);
  eq(strokesUsed(game), 1, 'and it is still one stroke, now with an edge in it');
  const snap = snapshot(game);
  eq(snap.strokes, 0, 'snapshot reports committed strokes');
  eq(snap.covered, 1, 'and coverage');
  eq(snap.par, game.par, 'and the budget');
});

test('grade never claims a win below par, because the theorem says there is none', () => {
  const game = createGame(mk(FIG8, 'fig8'));
  beginStroke(game, 0);
  for (let i = 1; i < FIG8_TOUR.length; i++) stepTo(game, FIG8_TOUR[i]);
  eq(game.strokes.length, 1, 'one stroke');
  eq(game.par, 1, 'at par');
  eq(grade(game).key, 'perfect', 'perfect');
  // A two-stroke cover of the same level is a loss, not a silver medal: the budget is the
  // theorem, so "won with more strokes than possible" cannot be a thing.
  const g2 = createGame(mk(FIG8, 'fig8b'));
  beginStroke(g2, 0); stepTo(g2, 1); stepTo(g2, 4); endStroke(g2);
  eq(g2.outcome, 'playing', 'one of two strokes used, still short');
  beginStroke(g2, 5); stepTo(g2, 8); stepTo(g2, 7); stepTo(g2, 4); endStroke(g2);
  eq(g2.strokes.length, 2, 'two strokes');
  eq(g2.outcome, 'lost', 'over a budget of one: lost, not "won but worse"');
});

run();
