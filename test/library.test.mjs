// The shipped pool, re-proved from its serialised form, and the save file.
//
// This is the "the printed number is still true" gate: every row of js/data/lots.js is
// re-compiled from the JSON that actually ships, and odd / par / the constructed cover /
// the exhaustive DP are all recomputed and compared against what the browser will print.
// A hand-edited par, a stale bake, or a generator change that silently shifts the
// distribution fails here, not on screen. `tools/bake.mjs` runs the same three checks when
// it writes the file; this file runs them again on every read of it.

import { test, run, ok, eq, fail } from '../tools/harness.mjs';
import { compile, validate } from '../js/core/graph.js';
import { par, oddCount } from '../js/core/theory.js';
import { verify } from '../js/core/construct.js';
import { minTrails, exhaustiveAllowed } from '../js/core/bruteforce.js';
import { LOTS, TIERS_META } from '../js/data/lots.js';
import { ALL, TIERS, byId, campaign, dailyLot, levelAt, lotsIn, randomLot, stats, tierByKey } from '../js/core/library.js';
import { store, SAVE_KEY } from '../js/core/storage.js';

// Import a second, cache-free copy of the store while no localStorage exists yet, so the
// memory-degrade assertions below are not at the mercy of Node's experimental flag.
Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
const memoryStore = (await import('../js/core/storage.js?no-localstorage')).store;

test('the pool loaded: 48 lots, four bands of twelve, ids in order', () => {
  eq(LOTS.length, 48, '48 rows in js/data/lots.js');
  eq(ALL.length, LOTS.length, 'and library.js exposes every one of them');
  const byTier = {};
  for (const l of LOTS) byTier[l.tier] = (byTier[l.tier] || 0) + 1;
  eq(Object.keys(byTier).sort(), ['five', 'four', 'tandem', 'three'], 'the four bands of make.js');
  eq(Object.values(byTier).sort(), [12, 12, 12, 12], 'twelve lots each');
  const ids = new Set(LOTS.map((l) => l.id));
  eq(ids.size, LOTS.length, 'ids are unique');
  for (const l of LOTS) ok(new RegExp(`^${l.tier}-\\d\\d$`).test(l.id), `id ${l.id} matches its band`);
  eq(TIERS.length, 4, 'library and make agree on the band list');
  eq(tierByKey('nope').key, TIERS[0].key, 'an unknown band falls back to the first');
});

test('序列化复证: every row re-proves odd, par, cover and DP from its serialised spec', () => {
  let worstStates = 0;
  for (const l of LOTS) {
    const raw = JSON.stringify(l.spec);                       // purity witness below
    const g = compile(JSON.parse(raw));                       // from the shipped JSON only
    const why = validate(g && l.spec, { odd: l.odd, par: l.par });
    if (why) fail(`${l.id}: validator rejects a shipped level: ${why}`);
    eq(oddCount(g), l.odd, `${l.id}: the printed odd count still matches the edges`);
    eq(par(g), l.par, `${l.id}: the printed par is still max(1, odd/2)`);
    eq(Math.max(1, l.odd / 2), l.par, `${l.id}: arithmetic restatement`);
    eq(l.trails.length, l.par, `${l.id}: the baked cover still has par strokes`);
    const err = verify(g, l.trails);
    if (err) fail(`${l.id}: the baked cover no longer verifies: ${err}`);
    const edges = l.trails.reduce((n, t) => n + t.edges.length, 0);
    eq(edges, l.edges, `${l.id}: the cover accounts for every printed edge`);
    ok(exhaustiveAllowed(g), `${l.id}: ${g.m} edges is inside the exhaustive cap`);
    const dp = minTrails(g);
    ok(dp.ok, `${l.id}: the DP ran to completion: ${dp.error}`);
    eq(dp.trails, l.par, `${l.id}: exhaustive minimum equals the printed theorem`);
    eq(dp.states, l.states, `${l.id}: the printed state count reproduces exactly`);
    eq(JSON.stringify(l.spec), raw, `${l.id}: compiling and searching left the spec untouched`);
    worstStates = Math.max(worstStates, dp.states);
  }
  ok(worstStates > 100000, `the corpus really includes ~${worstStates}-state certainties`);
});

test('the printed side dimensions match a recomputation of the same shapes', () => {
  for (const l of LOTS) {
    const g = compile(l.spec);
    let forks = 0;
    let leaves = 0;
    for (const v of g.verts) {
      if (g.deg[v] >= 3) forks++;
      if (g.deg[v] === 1) leaves++;
    }
    eq(g.m, l.edges, `${l.id}: edge count`);
    eq(g.verts.length, l.verts, `${l.id}: pin count`);
    eq(forks, l.forks, `${l.id}: fork count`);
    ok(l.openings === 2 * l.edges, `${l.id}: every edge, two orientations: ${l.openings}`);
    ok(l.bad < l.openings, `${l.id}: not every opening is wrong, so the level is not a coin flip`);
    ok(Math.abs(l.badRatio * l.openings - l.bad) < 1, `${l.id}: badRatio == bad / openings`);
  }
});

test('the bands do not overlap and stay inside what TIERS_META claims', () => {
  const pars = {};
  for (const l of LOTS) (pars[l.tier] || (pars[l.tier] = new Set())).add(l.par);
  eq([...pars.tandem], [2], 'tandem is par 2 everywhere');
  eq([...pars.three], [3], 'three is par 3');
  eq([...pars.four], [4], 'four is par 4');
  eq([...pars.five], [5], 'five is par 5');
  for (const meta of TIERS_META) {
    const mine = lotsIn(meta.key);
    eq(mine.length, meta.n, `${meta.key}: the meta row describes ${meta.n} lots`);
    eq(Math.min(...mine.map((l) => l.edges)), meta.edges[0], `${meta.key}: lower edge bound`);
    eq(Math.max(...mine.map((l) => l.edges)), meta.edges[1], `${meta.key}: upper edge bound`);
    eq(Math.min(...mine.map((l) => l.forks)), meta.forks[0], `${meta.key}: lower fork bound`);
    eq(Math.round(Math.max(...mine.map((l) => l.badRatio)) * 100) / 100, meta.badRatio[1], `${meta.key}: badRatio bound (meta rounds to 2dp)`);
    ok(meta.edges[1] <= 60, `${meta.key}: inside the 60-edge model cap`);
    for (const l of mine) ok(l.badRatio + 1e-9 >= meta.cut, `${l.id}: above its measured cut ${meta.cut}`);
  }
  const s = stats();
  eq(s.lots, 48, 'stats() sees the whole pool');
  eq(s.par, { min: 2, max: 5 }, 'and the theorem range the panel prints');
  const campaignList = campaign();
  for (const meta of TIERS_META) {
    const slice = campaignList.filter((l) => l.tier === meta.key);
    for (let i = 1; i < slice.length; i++) ok(slice[i].badRatio <= slice[i - 1].badRatio + 1e-9, `${meta.key}: hardest first at slot ${i + 1}`);
  }
});

test('daily and shared-link picks are reproducible functions of their seed', () => {
  const a = dailyLot('2026-09-27');
  const b = dailyLot('2026-09-27');
  ok(a === b, 'the same date string returns the identical object');
  ok(byId(a.id) === a, 'byId finds it by id');
  for (const tier of ['tandem', 'three', 'four', 'five']) {
    const r1 = randomLot('fixedseed', tier);
    const r2 = randomLot('fixedseed', tier);
    ok(r1 === r2 && r1.tier === tier, `#/random/${tier}/fixedseed is stable and in-band`);
  }
  const days = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'].map((d) => dailyLot(d).id);
  ok(new Set(days).size >= 3, `consecutive days walk around the pool: ${days.join(' ')}`);
  eq(levelAt(-1).id, ALL[ALL.length - 1].id, 'levelAt wraps from below');
  eq(levelAt(ALL.length).id, ALL[0].id, 'levelAt wraps from above');
  eq(byId('not-a-lot'), null, 'an unknown id is null, not a crash');
});

test('存档 without a localStorage degrades to memory and still behaves', () => {
  const before = memoryStore.dump();
  ok(before === null || typeof before === 'string', 'dump() is a string or nothing in memory mode');
  memoryStore.finish('mem-1', { strokes: 3, par: 3, hints: 0, outcome: 'won' });
  eq(memoryStore.record('mem-1').best, 3, 'the record exists in memory');
  eq(globalThis.localStorage, undefined, 'and nothing was ever written to a backend');
});

// Install a fake localStorage, then exercise the real store against it: the assertions
// below read the key back through SAVE_KEY, which is also what wires that export into
// something the suite proves.
const ls = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });

test('存档: finish writes the documented key, best only goes down, unlock only goes up', () => {
  store.reset();
  eq(ls.getItem(SAVE_KEY), null, 'a wiped save removes the key outright');
  store.finish('lot-a', { strokes: 4, par: 3, hints: 1, outcome: 'lost' });
  const raw = ls.getItem(SAVE_KEY);
  ok(typeof raw === 'string' && raw.length > 0, `the record went through ${SAVE_KEY}, not only memory`);
  eq(JSON.parse(raw).records['lot-a'].best, 4, 'a loss records its strokes');
  store.finish('lot-a', { strokes: 3, par: 3, hints: 0, outcome: 'won' });
  eq(store.record('lot-a').best, 3, 'a later par-stroke win pulls best down');
  eq(store.record('lot-a').solved, true, 'solved is sticky');
  eq(store.record('lot-a').stars, 3, 'the hint-free win earned three stars');
  store.finish('lot-a', { strokes: 5, par: 3, hints: 2, outcome: 'lost' });
  eq(store.record('lot-a').best, 3, 'and a worse run cannot push it back up');
  eq(store.record('lot-a').solved, true, 'solved is sticky across later losses');
  eq(store.record('lot-a').stars, 0, 'the latest attempt decides the star line');
  eq(store.unlocked, 1, 'fresh unlock');
  eq(store.unlock(4), 4, 'unlocking level 4');
  eq(store.unlock(2), 4, 're-solving level 2 cannot lock 4 away again');
  eq(store.stats.wins, 1, 'one win on the books');
  eq(store.stats.losses, 2, 'two losses on the books');
});

// Two more cache-free copies of the module against the same fake backend: this is what a
// page reload does. storage.js only reads the backend when a method is first called, so
// importing them here (before the writes below) is safe, and every test stays synchronous.
const session2 = (await import('../js/core/storage.js?session-2')).store;
const corruptStore = (await import('../js/core/storage.js?corrupt')).store;

test('存档: a second session reads the numbers back from the raw string', () => {
  eq(typeof SAVE_KEY, 'string', 'the key is exported and named');
  ok(SAVE_KEY.startsWith('eulertrail.'), `the key namespaces this game: ${SAVE_KEY}`);
  eq(session2.record('lot-a').best, 3, 'best survived the round trip');
  eq(session2.unlocked, 4, 'unlock survived the round trip');
  eq(session2.dailyDone('2026-09-27'), null, 'nothing was ever marked daily');
  session2.markDaily('2026-09-27', 'lot-b');
  eq(session2.dailyDone('2026-09-27').id, 'lot-b', 'the daily log persists');
  eq(JSON.parse(ls.getItem(SAVE_KEY)).daily['2026-09-27'].id, 'lot-b', 'and lives under the documented key');
  session2.reset();
  eq(ls.getItem(SAVE_KEY), null, '清档 really clears the backend');
  eq(Object.keys(session2.records).length, 0, 'and the view of it');
});

test('存档: a corrupt key is start-clean, not start-crash', () => {
  ls.setItem(SAVE_KEY, '{"records": oops');
  eq(corruptStore.unlocked, 1, 'the blank shape came back');
  corruptStore.finish('lot-c', { strokes: 2, par: 2, hints: 0, outcome: 'won' });
  eq(corruptStore.record('lot-c').best, 2, 'and the store is writable again');
  eq(JSON.parse(ls.getItem(SAVE_KEY)).records['lot-c'].solved, true, 'the repair reached the backend');
  corruptStore.reset();
});

// Imported now, read later: the module only touches the backend on its first method call,
// so the junk payload written inside the test is the first thing this copy ever decodes.
const junkStore = (await import('../js/core/storage.js?junk')).store;

test('存档 两段式解码: one bad record drops only that record', () => {
  // 手写 JSON 字符串：对象字面量里的 `__proto__` 是换原型，不是加键，用它当样本正好。
  ls.setItem(SAVE_KEY, [
    '{',
    '"version":1,',
    '"unlocked":99999,',
    '"records":{',
    '"good":{"solved":true,"best":3,"par":3,"stars":2,"plays":4,"hints":1,"at":1700000000000},',
    '"nullish":null,',
    '"wrongtype":{"solved":"yes","best":3,"par":3,"stars":3},',
    '"starstruck":{"solved":true,"best":3,"par":3,"stars":9},',
    '"clampable":{"solved":true,"best":3,"par":3,"stars":1,"plays":"x","hints":-5,"at":7},',
    '"__proto__":{"solved":true,"best":1,"par":1,"stars":3}',
    '},',
    '"daily":{"__proto__":{"id":"ghost"},"2026-09-28":{"id":"lot-d","at":1}},',
    '"prefs":{"tutorialSeen":true,"sound":"no","volume":1.9,"__proto__":true},',
    '"stats":{"wins":"many","plays":7,"losses":7000000000000}',
    '}',
  ].join(''));
  eq(junkStore.record('good').best, 3, 'the readable record came through untouched');
  eq(junkStore.record('good').solved, true, 'including its flags');
  eq(junkStore.record('nullish'), null, 'a null record is dropped, not fatal');
  eq(junkStore.record('wrongtype'), null, 'a non-boolean solved drops only that record');
  eq(junkStore.record('starstruck'), null, 'and a stars outside {0..3} the same');
  eq(junkStore.record('__proto__'), null, 'a __proto__ record key never enters the object');
  eq(junkStore.record('clampable').plays, 0, 'an unparseable field falls back to its default');
  eq(junkStore.record('clampable').hints, 0, 'including a negative count');
  eq(junkStore.record('clampable').stars, 1, 'while the rest of that record survives');
  eq(junkStore.dropped.records, 4, `four records were named: ${JSON.stringify(junkStore.dropped)}`);
  eq(junkStore.dropped.stats, 1, 'the bad stats field is counted, not swallowed');
  eq(junkStore.dropped.whole, 0, 'and the file as a whole was not thrown away');
  eq(junkStore.stats.plays, 7, 'a good stats field still lands');
  eq(junkStore.stats.losses, 1e9, 'an out-of-range one clamps to the ceiling');
  eq(junkStore.stats.wins, 0, 'a string count falls back to zero');
  eq(junkStore.dailyDone('2026-09-28').id, 'lot-d', 'the valid daily log survives');
  eq(junkStore.dailyDone('constructor'), null, 'and an inherited member is not a finished daily');
  eq(junkStore.prefs.tutorialSeen, true, 'a boolean pref survives');
  eq(junkStore.prefs.volume, 1, 'a number pref truncates');
  eq('sound' in junkStore.prefs, false, 'a string pref is dropped');
  eq(Object.keys(junkStore.prefs).sort().join(','), 'tutorialSeen,volume', 'no unsafe pref key landed');
  eq(junkStore.unlocked, 10000, 'unlocked clamps to the cap rather than resetting');
  junkStore.finish('lot-e', { strokes: 2, par: 2, hints: 0, outcome: 'won' });
  const rearmed = JSON.parse(ls.getItem(SAVE_KEY));
  eq(rearmed.records['lot-e'].solved, true, 'the store is writable again, into the backend');
  eq(rearmed.records.good.best, 3, 'and it did not lose the good record on the way out');
  junkStore.reset();
});

run();
