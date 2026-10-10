// Save file. One localStorage key, plain JSON, and a versioned shape so an old save can be
// recognised rather than mistaken for a new one.
//
// Records are keyed by lot id, plus a daily log, a campaign unlock pointer and a couple of
// UI preferences. Everything degrades to a memory object when localStorage is denied, which
// it is under file://, in a private window, and in the node test harness — the tests assert
// the fallback rather than skipping when it happens.
//
// 解码是两段的，而且**一条坏记录只丢那一条**。早先这里是 `Object.assign(blank(), JSON.parse(raw))`
// 一把梭：records 里只要有一条是 `null`、或者 stats 是个字符串，整局就在启动那行抛异常冻死，
// 玩家看到的是白屏，而存档里另外几十个正常成绩其实完全可读。现在第一段认类型、第二段逐字段
// 夹到合法域，任何一条失败都只把那一条记进 `dropped` 计数。
//
// One field deserves a warning, because it looks like a high score and is not one: `best`
// counts strokes, and a win is only ever recorded at exactly `par` strokes. Covering every
// edge in fewer is impossible (js/core/theory.js, the theorem's lower bound) and using more
// is a loss (js/core/game.js, 口径 in the budget). So `best === par` for every solved lot —
// the number that is worth comparing across lots is `par` itself, which is why the campaign
// screen prints the band instead of a leaderboard.

const KEY = 'eulertrail.save.v1';
// 存档格式版本号。写档带上、读档校验：将来改形状时旧档宁可整档丢弃，也不能被误读。
export const SAVE_VERSION = 1;

function hasLocalStorage() {
  try {
    return !!globalThis.localStorage && typeof globalThis.localStorage.getItem === 'function'
      && typeof globalThis.localStorage.setItem === 'function';
  } catch (err) {
    return false;   // 某些隐私模式访问 localStorage 本身就会抛
  }
}

function blank() {
  return {
    v: SAVE_VERSION,
    records: {},
    daily: {},
    prefs: {},
    unlocked: 1,
    stats: { wins: 0, plays: 0, strokes: 0, hints: 0, losses: 0 },
  };
}

function whole(v) {
  return Number.isFinite(v) ? Math.trunc(v) : null;
}

function clampWhole(v, min, max) {
  const w = whole(v);
  if (w === null || w < min) return null;
  return Math.min(max, w);
}

// 第一段：认形状。返回 null 表示"这条不是记录"，调用方只丢这一条，绝不牵连整局。
function shapeOfRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

// 第二段：逐字段夹进合法域。缺字段回落默认值，类型错与越界值丢整条（宁可少一段成绩）。
function sanitizeRecord(raw) {
  const r = shapeOfRecord(raw);
  if (!r) return null;
  const plays = clampWhole(r.plays, 0, 1e6) || 0;
  const hints = clampWhole(r.hints, 0, 1e6) || 0;
  const lostWithoutUndo = clampWhole(r.lostWithoutUndo, 0, 1e6) || 0;
  const solved = r.solved === true;
  const best = clampWhole(r.best, 0, 1e4);
  const par = clampWhole(r.par, 0, 1e4);
  if (r.solved !== undefined && typeof r.solved !== 'boolean') return null;
  if (r.stars !== undefined && ![0, 1, 2, 3].includes(whole(r.stars))) return null;
  const stars = [0, 1, 2, 3].includes(whole(r.stars)) ? whole(r.stars) : (solved ? 2 : 0);
  const at = clampWhole(r.at, 0, Number.MAX_SAFE_INTEGER);
  return { solved, best: best === null ? (par === null ? 0 : par) : best, par, stars, plays, hints, lostWithoutUndo, at: at || 0 };
}

function sanitizeDaily(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [day, v] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;          // 键都要认，不然一个 "__proto__" 就能进对象
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (typeof v.id !== 'string' || !v.id) continue;
    const at = clampWhole(v.at, 0, Number.MAX_SAFE_INTEGER);
    out[day] = { id: v.id.slice(0, 64), at: at || 0 };
  }
  return out;
}

// 键名也要认：`out["__proto__"] = v` 不是加一个属性，是换原型。日次日志有日期正则挡着，
// 记录与偏好这两处得显式挡。
const UNSAFE_KEY = new Set(['__proto__', 'prototype', 'constructor']);

function safeKey(k) {
  const s = String(k);
  return s && !UNSAFE_KEY.has(s) && s.length <= 64 ? s : null;
}

// 偏好只收布尔与有限整数：教学幕是否看过、以后可能有的难度。收到别的一律丢。
function sanitizePrefs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = safeKey(k);
    if (!key) continue;
    if (typeof v === 'boolean') out[key] = v;
    else if (Number.isFinite(v)) out[key] = Math.trunc(v);
  }
  return out;
}

let cache = null;

// 数字字段的归一自带一份，不依赖仓里有没有 count() —— 少一层隐式耦合。
function recordNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 存档两段式解码的第一段：整档 JSON 落到这里之后，**逐字段**归一。
// 一条记录不是"能用/不能用"二选一 —— 类型错的字段自己退成默认值，整条照样留下。
// 第二段（sanitizeRecords）在下面：它只丢掉归一后彻底没意义的记录，别的记录不受牵连。
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  out.solved = !!r.solved;
  out.best = recordNum(r.best);
  out.par = r.par === null || r.par === undefined ? null : recordNum(r.par);
  out.stars = recordNum(r.stars);
  out.plays = recordNum(r.plays);
  out.hints = recordNum(r.hints);
  out.lostWithoutUndo = recordNum(r.lostWithoutUndo);
  out.at = recordNum(r.at);
  return out;
}

// 逐条隔离：坏的那条丢掉，好的那些原样留下，绝不因为一条把整份存档作废。
function sanitizeRecords(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const [id, rec] of Object.entries(p)) {
    const clean = sanitizeRecord(rec);
    if (clean) out[id] = clean;
  }
  return out;
}

function load() {
  if (cache) return cache;
  const ls = backend();
  const raw = ls ? globalThis.localStorage.getItem(KEY) : null;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      // 版本门：只认本仓写出去的版本。将来升 v2 时，旧档宁可整档丢弃也不能被误读成新档。
      if (p && typeof p === 'object' && !Array.isArray(p)
          && (p.v === undefined || p.v === SAVE_VERSION)) {
        const base = blank();
        cache = {
          records: sanitizeRecords(p.records),
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
      raw = null;
    }
    if (raw) {
      const { save, dropped: d } = decode(raw);
      dropped = d;
      cache = save;
      return cache;
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  if (!hasLocalStorage()) return false;
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(cache));
    return true;
  } catch (err) {
    return false;   // memory-only session (quota, blocked cookies, no window)
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get prefs() { return load().prefs; },
  get unlocked() { return load().unlocked; },
  // 上一次解码丢掉了多少条坏数据。验收垃圾档时读的就是这个，不是"没抛异常"。
  get dropped() { return { ...dropped }; },

  setPref(key, value) {
    const s = load();
    const k = safeKey(key);
    if (!k) return undefined;
    if (typeof value === 'boolean' || Number.isFinite(value)) s.prefs[k] = value;
    else delete s.prefs[k];
    persist();
    return s.prefs[k];
  },

  record(id) {
    const rs = load().records;
    return Object.prototype.hasOwnProperty.call(rs, id) ? rs[id] : null;
  },

  // Unlocking is monotone: re-solving an early campaign level must never be able to hide a
  // later one.
  unlock(n) {
    const s = load();
    const v = clampWhole(n, 1, MAX_UNLOCK);
    if (v !== null && v > s.unlocked) s.unlocked = v;
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
    const d = load().daily;
    return Object.prototype.hasOwnProperty.call(d, dateKey) ? d[dateKey] : null;
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
    dropped = zeroDropped();
    if (hasLocalStorage()) {
      try { localStorage.removeItem(KEY); } catch (err) { /* nothing was ever persisted */ }
    }
  },

  // The raw string, for the tests that assert a save survives a round trip.
  dump() {
    const ls = backend();
    return ls ? globalThis.localStorage.getItem(KEY) : JSON.stringify(cache);
  },

  // 只给验收用：把一份原始 JSON 灌进解码器，看它丢掉几条、留下几条，不碰真存档。
  _decodeForTest(rawJson) { return decode(rawJson); },
};

export const SAVE_KEY = KEY;
