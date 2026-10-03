// The shell: hash routes in, canvas out, records in between. Nothing here knows the rules
// of the lot — those live in js/core — and nothing here draws — that is js/view.js.
//
// It is also the only place the three evidence paths meet the screen. The panel prints
// `par`, the odd count and the covered total; `window.eulertrail.theorem()` recomputes
// theorem / construction / exhaustive for the level currently on screen, so a browser test
// can assert that the printed number and the two algorithms agree *in the page*, not only
// in node.

import {
  createGame, beginStroke, stepTo, endStroke, undoStroke, reset, hint, grade, freeMoves, strokesUsed, snapshot,
} from './core/game.js';
import { oddCount, par as theoryPar } from './core/theory.js';
import { coverWith } from './core/construct.js';
import { minTrails, exhaustiveAllowed, MAX_EDGES as BRUTE_CAP } from './core/bruteforce.js';
import { store } from './core/storage.js';
import {
  TIERS, ALL, byId, levelAt, lotsIn, randomLot, dailyLot, tierByKey, stats as poolStats,
} from './core/library.js';
import { todayKey } from './core/rng.js';
import { rc } from './core/graph.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'), stars: $('stars'),
  verdict: $('verdict'), tally: $('tally'), undo: $('undo'), hint: $('hint'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('board'), wipe: $('wipe'),
};

const LEVELS = ALL.length;
const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  hints: 0,
  label: '',
  day: null,
  settled: false,   // finish() runs once per outcome, never once per event
  proof: null,      // { key, theorem, built, exhaustive } for the lot on screen
};

function clampIndex(n) {
  return Math.min(LEVELS, Math.max(1, Number(n) || 1));
}

// #/c/7 · #/daily · #/random/four/4kq2 · #/lot/tandem-03
// The lot id is in the URL, so a shared link resolves to the same theorem on another device
// without the receiver needing the sender's save file.
function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIERS[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  return { mode: 'campaign', index: clampIndex(n) };
}

function linkFor(rt) {
  if (!rt) return '#/c/1';
  if (rt.mode === 'daily') return '#/daily';
  if (rt.mode === 'random') return `#/random/${rt.tier}/${rt.key}`;
  if (rt.mode === 'lot') return `#/lot/${rt.id}`;
  return `#/c/${rt.index}`;
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    return { lot: dailyLot(day), label: `每日一笔 · ${day}`, day };
  }
  if (rt.mode === 'random') {
    const tier = tierByKey(rt.tier);
    return { lot: randomLot(`${tier.key}|${rt.key}`, tier.key), label: `随机 · ${tier.label}` };
  }
  if (rt.mode === 'lot') {
    const lot = byId(rt.id) || ALL[0];
    return { lot, label: `关卡 ${lot.id}` };
  }
  const lot = levelAt(rt.index - 1);
  return { lot, label: `第 ${rt.index} 关` };
}

const view = createView(el.canvas, { onEvent: note });

// The one place a step happens: the drag from the view, `playStroke()` from a test link and
// a following-the-hint tap all arrive at the same rules, so @play and @pointer are not two
// different games with one of them lying.
function note(ev) {
  if (!ev || !app.game) return;
  if (ev.type === 'again') say('<span class="warn">这条边已经画过了 —— 再拖一次不会重复计数，也不算错</span>');
  else if (ev.type === 'refused') say('两点之间没有边 —— 笔只能沿着画得出的边走');
  else if (ev.type === 'miss') say('那里没有图钉');
  else if (ev.type === 'blocked') say(`<span class="warn">${ev.reason === 'complete' ? '这一关已经画完了' : `${ev.reason}，换个起点`}</span>`);
  else if (ev.type === 'step' && ev.autoEnded) {
    const g = app.game;
    say(`第 ${g.strokes.length} 笔走到此处已无可走的边，笔自动抬起 · 还能用 <b>${Math.max(0, g.par - strokesUsed(g))}</b> 笔`);
  } else if (ev.type === 'lift' && ev.committed) {
    const g = app.game;
    say(`抬笔 · 已用 <b>${strokesUsed(g)}</b>/${g.par} 笔 · 覆盖 <b>${g.covered}</b>/${g.g.m} 条边`);
  }
  if (app.game.outcome !== 'playing') finish();
  sync();
}

function field(label, value, sub, cls = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><dt><small>${sub}</small></dt></div>`;
}

// The theorem, the construction and the search, side by side under the level on screen.
// The DP is the expensive one (up to ~150k states), so it runs once per lot and is cached.
function theoremFor(g) {
  const cov = coverWith(g, {});
  const allowed = exhaustiveAllowed(g);
  const dp = allowed ? minTrails(g) : null;
  return {
    odd: oddCount(g),
    theorem: theoryPar(g),
    built: cov.ok ? cov.trails.length : '失败',
    exhaustive: dp ? (dp.ok ? dp.trails : '截断') : null,
    states: dp ? dp.states : 0,
    skipped: !allowed,
  };
}

function renderCrumbs() {
  const tier = tierByKey(app.lot.tier);
  el.crumbs.innerHTML = `${app.label}<b>${tier.label}<span class="band"> ${tier.blurb}</span></b>`;
  const g = app.game;
  const snap = snapshot(g);
  const rec = store.record(g.id);
  if (!app.proof || app.proof.key !== g.id) app.proof = { key: g.id, t: theoremFor(g.g) };
  const t = app.proof.t;
  el.readout.innerHTML = [
    field('笔数上限', snap.par, '定理由奇点算出', 'par'),
    field('已用笔数', strokesUsed(g), rec && rec.solved ? `本机最好 ${rec.best} 笔` : '抬笔即结算'),
    field('覆盖边数', `${snap.covered}/${snap.total}`, '画不完不算赢', 'cover'),
    field('奇点数', snap.odd, '握手引理：必为偶数', 'odd'),
    `<div class="proof"><dt>三条路</dt><dd>定理 <b>${t.theorem}</b> · 构造 <b>${t.built}</b> · 穷举 <b>${t.exhaustive === null ? '未跑' : t.exhaustive}</b>`
      + `<br><small>${t.skipped ? `边数超过穷举上限 ${BRUTE_CAP}` : `穷举 ${t.states} 个状态`} · 错首手 ${(app.lot.badRatio * 100).toFixed(0)}%（${app.lot.bad}/${app.lot.openings} 种起手）</small></dd></div>`,
    `<div class="proof"><dt>这一关</dt><dd><code>#/lot/${g.id}</code><br><small>${snap.total} 条边 · ${g.g.verts.length} 个图钉 · ${app.lot.forks} 个岔口</small></dd></div>`,
  ].join('');
  el.undo.disabled = !g.strokes.length;
  el.hint.disabled = g.outcome !== 'playing';
}

function sync() {
  const g = app.game;
  const snap = snapshot(g);
  const cells = el.readout.querySelectorAll('dd');
  if (cells.length >= 4) {
    cells[1].textContent = String(strokesUsed(g));
    cells[2].textContent = `${snap.covered}/${snap.total}`;
  }
  el.undo.disabled = !g.strokes.length;
  el.hint.disabled = g.outcome !== 'playing';
  // The rAF loop only repaints while a drag, a hint pulse or a flash is live, so the state
  // that changed *without* a pointer — `playStroke()` from a test hook, a hint following a
  // recommended edge — would otherwise move numbers while the ink stayed where it was.
  view.redraw();
}

function renderTotals() {
  const s = store.stats;
  const solved = Object.values(store.records).filter((r) => r.solved).length;
  el.totals.innerHTML = `已通 <b>${solved}</b>/${LEVELS} · 提示 <b>${s.hints}</b> · 落笔 <b>${s.plays}</b> 次`;
}

function renderShelf() {
  if (app.mode === 'campaign') {
    const unlocked = store.unlocked;
    let html = '';
    for (const tier of TIERS) {
      html += `<p class="tier">${tier.label} · ${tier.blurb}</p>`;
      for (const lot of lotsIn(tier.key)) {
        const n = ALL.indexOf(lot) + 1;
        const rec = store.record(lot.id);
        const cls = [
          n === app.index ? 'here' : '',
          rec && rec.solved ? (rec.stars === 3 ? 'perfect' : 'done') : '',
        ].filter(Boolean).join(' ');
        html += `<button type="button" data-index="${n}" class="${cls}" ${n > unlocked ? 'disabled' : ''} title="${lot.id}">${n}</button>`;
      }
    }
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-index]').forEach((b) => {
      b.addEventListener('click', () => go(`#/c/${b.dataset.index}`));
    });
    return;
  }
  if (app.mode === 'random') {
    let html = '<p class="tier">选一段笔数</p>';
    for (const tier of TIERS) {
      const on = tier.key === app.route.tier ? 'here' : '';
      html += `<button type="button" class="${on}" data-tier="${tier.key}">${tier.label}<br><small>${tier.blurb}</small></button>`;
    }
    html += '<button type="button" class="wide" data-reroll="1">换一张图</button>';
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-tier]').forEach((b) => {
      b.addEventListener('click', () => go(`#/random/${b.dataset.tier}/${token()}`));
    });
    el.shelf.querySelector('[data-reroll]').addEventListener('click', () => go(`#/random/${app.route.tier}/${token()}`));
    return;
  }
  if (app.mode === 'daily') {
    const done = app.day && store.dailyDone(app.day);
    el.shelf.innerHTML = `<p class="tier">今天这张图对所有人相同${done ? ' · 已通过' : ''}</p>`
      + `<button type="button" class="wide" data-back="1">回到战役 第 ${store.unlocked} 关</button>`;
  } else {
    el.shelf.innerHTML = '<p class="tier">分享的关卡</p>'
      + `<button type="button" class="wide" data-back="1">回到战役 第 ${store.unlocked} 关</button>`;
  }
  const back = el.shelf.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => go(`#/c/${store.unlocked}`));
}

function token() {
  return Math.random().toString(36).slice(2, 8);
}

function render() {
  el.modes.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  });
  renderCrumbs();
  renderTotals();
  renderShelf();
}

function say(html) {
  el.hintline.innerHTML = html;
}

function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function finish() {
  if (app.settled) return;
  app.settled = true;
  const lot = app.lot;
  const g = app.game;
  const won = g.outcome === 'won';
  store.finish(lot.id, { strokes: g.strokes.length, par: g.par, hints: app.hints, outcome: g.outcome });
  if (app.day && won) store.markDaily(app.day, lot.id);
  let nextIndex = 0;
  if (app.mode === 'campaign') {
    if (won) store.unlock(Math.min(LEVELS, app.index + 1));
    nextIndex = won && app.index < LEVELS ? app.index + 1 : 0;
  }
  const gr = grade(g);
  el.stars.textContent = stars(gr.stars);
  el.verdict.textContent = gr.label;
  el.tally.innerHTML = won
    ? `用满 <b>${g.par}</b> 笔 · 覆盖全部 <b>${g.g.m}</b> 条边 · 提示 <b>${app.hints}</b>`
      + `<br><small>${g.odd} 个奇点 ⇒ 定理说至少要 ${g.par} 笔，构造给得出 ${g.baked.length} 笔的解</small>`
    : `已经用了 <b>${g.strokes.length}</b> 笔，上限是 <b>${g.par}</b> 笔<br>`
      + `<small>少一笔不可能：${g.odd} 个奇点，每笔只有两个端点。撤销一笔或重开，棋盘不会锁死。</small>`;
  el.next.hidden = !nextIndex;
  el.curtain.hidden = false;
  render();
  view.redraw();   // the stroke that ended the level arrives through finish(), not sync()
}

function go(hash) {
  if (location.hash === hash) apply();
  else location.hash = hash;
}

function setGame(lot, label) {
  app.lot = lot;
  app.label = label || app.label;
  app.game = createGame(lot);
  app.hints = 0;
  app.settled = false;
  view.attach(app.game);
  el.curtain.hidden = true;
  say('');
}

function apply() {
  const rt = parseHash();
  app.route = rt;
  app.mode = rt.mode;
  if (rt.mode === 'random' && !rt.key) {
    // A bare #/random/four would mean a different graph on every visit and an
    // unreproducible link, so the token is minted once and written back into the URL.
    location.replace(`${location.pathname}${location.search}#/random/${rt.tier}/${token()}`);
    return;
  }
  const r = resolve(rt);
  if (!r.lot) {
    say('这一档还没有烤好的关卡');
    return;
  }
  app.day = r.day || null;
  app.index = rt.mode === 'campaign' ? rt.index : ALL.indexOf(r.lot) + 1;
  setGame(r.lot, r.label);
  render();
  say(`${r.lot.par} 笔 · ${r.lot.edges} 条边 · 按住图钉拖过一条边就画下它`);
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/lot/${app.lot.id}`;
  const done = () => toast('链接已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => toast(url));
  } else {
    toast(url);
  }
}

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  if (b.dataset.mode === 'campaign') go(`#/c/${clampIndex(store.unlocked)}`);
  else if (b.dataset.mode === 'daily') go('#/daily');
  else go(`#/random/${TIERS[0].key}/${token()}`);
});

el.undo.addEventListener('click', () => {
  if (undoStroke(app.game)) {
    app.settled = false;
    el.curtain.hidden = true;
    view.redraw();
    renderCrumbs();
    say('退掉最后一笔 · 覆盖与笔数都已回退');
  } else {
    say('还没有落下过完整的一笔');
  }
});

el.hint.addEventListener('click', () => {
  const h = hint(app.game);
  if (!h) {
    say('已经没有可指的路了 —— 撤销一笔或重开');
    return;
  }
  app.hints++;
  view.showHint(h);
  if (h.kind === 'fresh') say(`提示：第 <b>${h.stroke}</b> 笔从标出的点起笔，沿高亮边画 —— 还差 <b>${h.left}</b> 笔`);
  else if (h.kind === 'diverged') say(`提示：${h.note} —— 这一笔剩下的边仍然要连着画完`);
  else say('提示：补上高亮的那条边（你已经走了构造里不存在的路）');
  renderTotals();
  sync();
});

function restart() {
  reset(app.game);
  app.hints = 0;
  app.settled = false;
  el.curtain.hidden = true;
  view.attach(app.game);   // also drops the in-progress drag and the hint pulse
  render();
  say('回到起点');
}

el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(LEVELS, app.index + 1)}`));

// Wiping the save is the one destructive thing this game can do, so it asks twice instead
// of firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && !el.curtain.hidden) el.curtain.hidden = true;
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') el.restart.click();
});

view.start();
// Deliberately not paused on visibilitychange: the hint pulse is driven from the same loop,
// and a tab that reports itself hidden (headless Chrome does) must still be able to draw.
apply();

const hook = {
  version: 1,
  get state() {
    const g = app.game;
    return {
      mode: app.mode,
      label: app.label,
      id: g && g.id,
      tier: g && g.tier,
      index: app.index,
      strokes: g ? strokesUsed(g) : 0,
      committed: g ? g.strokes.length : 0,
      par: g && g.par,
      odd: g && g.odd,
      covered: g ? g.covered : 0,
      total: g ? g.g.m : 0,
      outcome: g && g.outcome,
      hints: app.hints,
      unlocked: store.unlocked,
      solved: Object.values(store.records).filter((r) => r.solved).length,
      curtain: !el.curtain.hidden,
      rows: g ? g.g.rows : 0,
      cols: g ? g.g.cols : 0,
      hash: location.hash,
      route: linkFor(app.route),
    };
  },
  get pool() { return poolStats(); },
  get theorem() {
    const g = app.game;
    if (!g) return null;
    if (!app.proof || app.proof.key !== g.id) app.proof = { key: g.id, t: theoremFor(g.g) };
    return { ...app.proof.t, par: g.par, odd: g.odd, strokes: strokesUsed(g) };
  },
  load(hash) { go(hash); return app.lot && app.lot.id; },

  // Geometry, in client pixels — what an automated finger needs to press a pin rather than
  // a formula. `edgeAt` answers in edge ids, `probe` also says whether the point was off
  // the board and had to be clamped.
  vertexPoint(r, c) { return view.vertexPoint(r, c); },
  edgeAt(x, y) { return view.edgeAt(x, y); },
  probe(x, y) { return view.vertexAt(x, y); },
  pinOf(v) {
    if (!app.game) return null;
    const { r, c } = rc(v, app.game.g);
    return { ...view.vertexPoint(r, c), r, c, v };
  },
  measure() { view.measure(); return { cell: view.vertexPoint(0, 0).cell }; },

  lot() { return app.lot ? JSON.parse(JSON.stringify(app.lot.spec)) : null; },
  drawn() { return app.game ? Array.from(app.game.drawn) : null; },
  strokes() {
    if (!app.game) return [];
    return app.game.strokes.map((s) => ({ verts: s.verts.slice(), edges: s.edges.slice() }));
  },
  freeMoves(v) { return app.game ? freeMoves(app.game, v) : []; },
  events(n) { return app.game ? app.game.events.slice(-(n || 20)) : []; },

  // The baked proof for this exact level, as vertex id lists.
  baked() {
    if (!app.game) return [];
    return app.game.baked.map((t) => ({ verts: t.verts.slice(), edges: t.edges.slice() }));
  },
  strokePath(i) {
    const b = hook.baked();
    if (!b[i] || !app.game) return null;
    return b[i].verts.map((v) => {
      const { r, c } = rc(v, app.game.g);
      return { ...view.vertexPoint(r, c), r, c, v };
    });
  },

  // Play one baked stroke through the rules — the same beginStroke/stepTo/endStroke the
  // pointer path calls, so @play and @pointer exercise one code path, not two.
  playStroke(i) {
    const g = app.game;
    const b = g.baked[i];
    if (!b) return { ok: false, reason: 'no such baked stroke' };
    const before = g.strokes.length;
    const log = [];
    const start = beginStroke(g, b.verts[0]);
    log.push({ begin: start });
    if (!start.ok) { sync(); return { ok: false, reason: start.reason, log }; }
    for (let k = 1; k < b.verts.length; k++) {
      const r = stepTo(g, b.verts[k]);
      log.push(r);
      if (!r.ok && r.reason !== 'drawn') { sync(); return { ok: false, reason: r.reason, log }; }
    }
    const lifted = endStroke(g);
    log.push({ lift: lifted });
    if (g.outcome !== 'playing') finish();
    else sync();
    // `committed` answers "did this call put a stroke on the paper", which the lift alone
    // cannot: a trail whose last pin is stranded is closed inside stepTo (口径 1), so the
    // following endStroke has nothing left to commit and would report false.
    return { ok: true, committed: g.strokes.length > before, lift: lifted.committed,
      outcome: g.outcome, strokes: g.strokes.length, log };
  },
  playAll() {
    const n = app.game ? app.game.baked.length : 0;
    for (let i = 0; i < n; i++) {
      if (app.game.outcome !== 'playing') break;
      hook.playStroke(i);
    }
    return { outcome: app.game.outcome, strokes: app.game.strokes.length, covered: app.game.covered, total: app.game.g.m };
  },
  // Deliberately past the budget: par+1 committed strokes must lose, and lose without
  // throwing or locking the board.
  playOver() {
    const g = app.game;
    const out = [];
    let guard = 0;
    while (g.outcome === 'playing' && guard++ < 40) {
      const v = g.g.verts.find((x) => freeMoves(g, x).length);
      if (v === undefined) break;
      beginStroke(g, v);
      const mv = freeMoves(g, v)[0];
      if (mv) stepTo(g, mv.to);
      endStroke(g);
      out.push({ strokes: g.strokes.length, covered: g.covered, outcome: g.outcome });
      if (g.outcome !== 'playing') { finish(); sync(); break; }
    }
    return { outcome: g.outcome, strokes: g.strokes.length, par: g.par, steps: out };
  },
  // A drag that goes back over finished ink: 口径 2 says coverage must not move. The call
  // goes through the same rules a pointer does, so it tests the rule and not a shortcut.
  redrawEdge(e) {
    const g = app.game;
    if (!Number.isInteger(e) || e < 0 || e >= g.g.m) return { ok: false, reason: 'no such edge' };
    const before = { covered: g.covered, strokes: strokesUsed(g) };
    const ends = [g.g.ea[e], g.g.eb[e]];
    const from = ends.find((v) => freeMoves(g, v).length);
    if (from === undefined) return { ok: false, reason: 'no free edge at either end', before, after: before };
    const b = beginStroke(g, from);
    if (!b.ok) return { ok: false, reason: b.reason, before, after: before };
    const to = from === ends[0] ? ends[1] : ends[0];
    const step = stepTo(g, to);
    const after = { covered: g.covered, strokes: strokesUsed(g), drawn: Array.from(g.drawn)[e] };
    endStroke(g);
    sync();
    return { ok: true, step, before, after };
  },
  hintOnce() { el.hint.click(); return { hints: app.hints, line: el.hintline.textContent }; },
  clickUndo() { el.undo.click(); return strokesUsed(app.game); },
  clickRestart() { el.restart.click(); return strokesUsed(app.game); },
  resetLevel() { restart(); return hook.state; },
  grade() { return grade(app.game); },
  store,
};

window.eulertrail = hook;

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 减弱动效（prefers-reduced-motion）----
//
// 跟住系统设置，而且**运行中改设置要立刻生效**：只读一次 matchMedia 是不够的，玩家在系统里
// 把开关拨回来，页面还停在上一次读到的答案上。addEventListener 是标准接口，老 Safari 只有
// addListener —— 特性探测，不做 UA 判断。
const motionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReduceMotion(on) { view.setReduceMotion(on); }
if (motionQuery) {
  applyReduceMotion(motionQuery.matches);
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (e) => applyReduceMotion(e.matches));
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener((e) => applyReduceMotion(e.matches));
  }
}
hook.setReduceMotion = applyReduceMotion;
hook.isReducedMotion = () => view.isReducedMotion();
