// Save file. One localStorage key, plain JSON, and a versioned shape so an old save can be
// recognised rather than mistaken for a new one.
//
// Records are keyed by lot id, plus a daily log and a campaign unlock pointer. Everything
// degrades to a memory object when localStorage is denied, which it is under file://, in a
// private window, and in the node test harness — the tests below assert the fallback rather
// than skipping when it happens.
//
// One field deserves a warning, because it looks like a high score and is not one: `best`
// counts strokes, and a win is only ever recorded at exactly `par` strokes. Covering every
// edge in fewer is impossible (js/core/theory.js, the theorem's lower bound) and using more
// is a loss (js/core/game.js, 口径 in the budget). So `best === par` for every solved lot —
// the number that is worth comparing across lots is `par` itself, which is why the campaign
// screen prints the band instead of a leaderboard.

const KEY = 'eulertrail.save.v1';

function backend() {
  try {
    const ls = globalThis.localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch (err) {
    return null;
  }
}

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { wins: 0, plays: 0, strokes: 0, hints: 0, losses: 0 },
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  const ls = backend();
  const raw = ls ? ls.getItem(KEY) : null;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: Number(p.unlocked) > 0 ? Math.trunc(Number(p.unlocked)) : base.unlocked,
          stats: { ...base.stats, ...(p.stats || {}) },
        };
        for (const k of ['wins', 'plays', 'strokes', 'hints', 'losses']) {
          if (!Number.isFinite(cache.stats[k]) || cache.stats[k] < 0) cache.stats[k] = 0;
        }
        return cache;
      }
    } catch (err) {
      // A corrupt save is not worth keeping; start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  const ls = backend();
  if (!ls) return false;
  try {
    ls.setItem(KEY, JSON.stringify(cache));
    return true;
  } catch (err) {
    return false;   // memory-only session (quota, blocked cookies, no window)
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

  record(id) {
    return load().records[id] || null;
  },

  // Unlocking is monotone: re-solving an early campaign level must never be able to hide a
  // later one.
  unlock(n) {
    const s = load();
    const v = Math.trunc(Number(n));
    if (Number.isFinite(v) && v > s.unlocked) s.unlocked = v;
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id) {
    const s = load();
    s.daily[dateKey] = { id, at: Date.now() };
    persist();
    return s.daily[dateKey];
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // Called once when a lot leaves the playing state, win or loss. `outcome` is the game's,
  // not something the caller gets to assert about.
  finish(id, { strokes, par, hints, outcome }) {
    const s = load();
    const prev = s.records[id] || null;
    const won = outcome === 'won';
    const used = Number.isFinite(strokes) ? strokes : 0;
    const cur = {
      solved: won || !!(prev && prev.solved),
      // See the header: this only ever lands on `par`, and asserting that is a test.
      best: !prev || !Number.isFinite(prev.best) ? used : Math.min(prev.best, used),
      par: Number.isFinite(par) ? par : null,
      stars: won && (!hints || hints === 0) ? 3 : won ? 2 : 0,
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      hints: (prev && prev.hints ? prev.hints : 0) + (hints || 0),
      lostWithoutUndo: !won && outcome === 'lost' ? ((prev && prev.lostWithoutUndo) || 0) + 1 : (prev && prev.lostWithoutUndo) || 0,
      at: Date.now(),
    };
    s.records[id] = cur;
    s.stats.plays += 1;
    s.stats.strokes += used;
    s.stats.hints += hints || 0;
    if (won) s.stats.wins += 1;
    if (outcome === 'lost') s.stats.losses += 1;
    persist();
    return cur;
  },

  reset() {
    cache = blank();
    const ls = backend();
    if (ls) {
      try { ls.removeItem(KEY); } catch (err) { /* nothing was ever persisted */ }
    }
  },

  // The raw string, for the tests that assert a save survives a round trip.
  dump() {
    const ls = backend();
    return ls ? ls.getItem(KEY) : JSON.stringify(cache);
  },
};

export const SAVE_KEY = KEY;
