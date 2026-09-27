// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch).
// env: CDP_PORT (devtools port, default 9346), BASE_URL (page to attach to, default
//      http://127.0.0.1:5186/)
// usage:
//   node tools/playtest.mjs open  <url>          # reuse-or-create our page and navigate
//   node tools/playtest.mjs nav   <url>
//   node tools/playtest.mjs eval  '<js expression>'   # pass `nonav` to skip the reload
//   node tools/playtest.mjs eval  '@boot'         # | @play | @routes | @save | @pointer
//   node tools/playtest.mjs shot  <path.png>
//   node tools/playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
const PORT = process.env.CDP_PORT || 9346;
// Which page to attach to. Hard-coding the dev-server port silently evaluates
// against a fresh about:blank tab when pointed at any other origin.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. The page is a module graph fetched over the network:
  // a fixed sleep is long enough for a localhost server and too short for GitHub Pages, where
  // it made an innocent deployment look broken (`window.eulertrail` still undefined, canvas
  // still the unstyled 300x150 default). The floor keeps the local case as fast as it was.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.eulertrail && window.eulertrail.state && window.eulertrail.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// The one suite a page-side script cannot run: real input. Everything below goes through
// Chrome's own mouse over CDP, so what gets asserted is the pointer-to-rules wiring in
// js/view.js rather than the rules behind it. Coordinates come from the hook's own
// geometry (pinOf / vertexPoint), never from a re-derivation, so the test presses where a
// player looks, not where the test thinks the board is.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
  }, sessionId);
  const key = (k) => cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: k, key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
  }, sessionId);

  // A real finger: press, then one move per intermediate sample (the view sweeps between
  // samples itself), release. `through` is the list of client points to visit after `from`.
  async function dragThrough(from, through, lift = true) {
    await mouse('mousePressed', Math.round(from.x), Math.round(from.y), 1);
    for (const p of through) {
      // two samples per segment so the corridor is entered, not just the endpoints
      for (let i = 1; i <= 2; i++) {
        await mouse('mouseMoved', Math.round(p.fx + ((p.x - p.fx) * i) / 2), Math.round(p.fy + ((p.y - p.fy) * i) / 2), 1);
      }
      await mouse('mouseMoved', Math.round(p.x), Math.round(p.y), 1);
    }
    if (lift) {
      const last = through.length ? through[through.length - 1] : from;
      await mouse('mouseReleased', Math.round(last.x), Math.round(last.y), 0);
    }
    await sleep(90);
  }

  // One straight pin-to-pin stroke, dragged in real points.
  async function dragStroke(pins) {
    const through = [];
    for (let i = 1; i < pins.length; i++) {
      through.push({ x: pins[i].x, y: pins[i].y, fx: pins[i - 1].x, fy: pins[i - 1].y });
    }
    await dragThrough(pins[0], through);
  }

  const ids = await runJS(`['board','undo','hint','restart','share','curtain','stars','verdict','tally','shelf','wipe','modes','readout','hintline','totals','crumbs','toast','next','again'].map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));

  await runJS(`window.eulertrail.load('#/lot/tandem-01'); 'ok'`);
  await sleep(250);
  const start = await runJS(`(() => { const g = window.eulertrail; return { state: g.state, theorem: g.theorem, baked: g.baked(), drawn: g.drawn() }; })()`);
  rec('a tandem lot loads through the real route', start.state.id === 'tandem-01' && start.state.par === 2 && start.baked.length === 2,
    { id: start.state.id, par: start.state.par, strokes: start.state.strokes });
  rec('the three paths agree inside the page before any touch',
    start.theorem.theorem === start.state.par && start.theorem.built === start.state.par
    && (start.theorem.skipped || start.theorem.exhaustive === start.state.par), start.theorem);

  // ---- the whole certified cover, drawn by a dispatched mouse ----
  const shots = [];
  for (let i = 0; i < start.baked.length; i++) {
    const before = await runJS(`({ strokes: window.eulertrail.state.strokes, covered: window.eulertrail.state.covered })`);
    const path = await runJS(`window.eulertrail.strokePath(${i})`);
    const want = start.baked[i].edges.length;
    await dragStroke(path);
    const after = await runJS(`({ strokes: window.eulertrail.state.strokes, covered: window.eulertrail.state.covered, outcome: window.eulertrail.state.outcome, events: window.eulertrail.events(4) })`);
    shots.push({ stroke: i + 1, want, drew: after.covered - before.covered, ...after });
  }
  const s1 = shots[0];
  rec('stroke 1 by mouse drew exactly its own edges and cost exactly one stroke',
    s1.drew === s1.want && s1.strokes === 1, s1);
  const s2 = shots[1];
  rec('stroke 2 by mouse covered the rest: every edge of the level is ink',
    s2.covered === start.state.total && s2.drew === s2.want, s2);
  const win = await runJS(`(() => { const g = window.eulertrail; return {
    outcome: g.state.outcome, curtain: g.state.curtain,
    stars: document.getElementById('stars').textContent,
    verdict: document.getElementById('verdict').textContent,
    record: g.store.record(g.state.id), strokes: g.state.committed, par: g.state.par }; })()`);
  rec('the win card goes up at exactly par with three stars',
    win.outcome === 'won' && win.curtain && win.stars === '★★★' && win.verdict === '一笔不浪费' && win.strokes === win.par, win);
  rec('the run is on record at par', !!win.record && win.record.best === win.par && win.record.solved === true, win.record);

  // ---- illegal asks: the mouse asks, the rules refuse, nothing moves ----
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(200);
  const home = await runJS(`window.eulertrail.state`);
  const pin = await runJS(`window.eulertrail.pinOf(window.eulertrail.baked()[0].verts[0])`);
  await dragThrough(pin, []);                       // press and release in place
  const pressOnly = await runJS(`(() => { const s = window.eulertrail.state; return {
    covered: s.covered, strokes: s.strokes, committed: s.committed, outcome: s.outcome }; })()`);
  rec('a press that never moves draws nothing and bills nothing',
    pressOnly.covered === home.covered && pressOnly.strokes === 0 && pressOnly.committed === 0
    && pressOnly.outcome === 'playing', { home, pressOnly });

  // A press the view cannot name: nowhere near a pin and not even on the canvas. The rules
  // never get asked, so nothing moves and nothing is billed.
  const away = await runJS(`(() => {
    const g = window.eulertrail;
    const c = document.getElementById('board').getBoundingClientRect();
    const p = document.getElementById('crumbs').getBoundingClientRect();
    const x = Math.round(p.left + p.width / 2), y = Math.round(p.top + p.height / 2);
    return { x, y, probe: g.probe(x, y), onCanvas: x >= c.left && x <= c.right && y >= c.top && y <= c.bottom };
  })()`);
  const preMiss = await runJS(`({ covered: window.eulertrail.state.covered, strokes: window.eulertrail.state.strokes, committed: window.eulertrail.state.committed })`);
  await mouse('mousePressed', away.x, away.y, 1);
  await mouse('mouseMoved', away.x + 24, away.y + 12, 1);
  await mouse('mouseReleased', away.x + 24, away.y + 12, 0);
  await sleep(140);
  const postMiss = await runJS(`({ covered: window.eulertrail.state.covered, strokes: window.eulertrail.state.strokes, committed: window.eulertrail.state.committed, outcome: window.eulertrail.state.outcome })`);
  rec('a press with no pin under it starts nothing and bills nothing',
    !!away.probe && away.probe.v === -1 && away.onCanvas === false
    && postMiss.covered === preMiss.covered && postMiss.strokes === 0 && postMiss.committed === 0
    && postMiss.outcome === 'playing', { away, preMiss, postMiss });

  // 口径 2 with a real finger: drag the whole of stroke 1, then drag straight back over the
  // same wet ink. Coverage must not move, no second stroke may be billed, and every crossing
  // has to be *named* by the rules — otherwise the drag silently did nothing at all.
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(180);
  const t0 = await runJS(`window.eulertrail.baked()[0]`);
  const tpath = await runJS(`window.eulertrail.strokePath(0)`);
  const firstEdges = t0.edges.length;
  await dragStroke(tpath);
  const after1 = await runJS(`({ covered: window.eulertrail.state.covered, committed: window.eulertrail.state.committed, strokes: window.eulertrail.state.strokes })`);
  rec('one mouse drag traces the whole first baked stroke and costs exactly one stroke',
    after1.covered === firstEdges && after1.committed === 1 && after1.strokes === 1, { firstEdges, after1 });
  // Now drag back over one of those wet edges. The end to press at is read off the page's
  // own free-move list, so the stroke genuinely opens and the refusal that follows is 口径 2
  // rather than a blocked press that never asked anything.
  const cross = await runJS(`(() => {
    const g = window.eulertrail;
    const b = g.baked()[0];
    for (let k = 0; k + 1 < b.verts.length; k++) {
      const a = b.verts[k], c = b.verts[k + 1];
      if (g.freeMoves(c).some((m) => m.to !== a)) return { from: c, to: a };
      if (g.freeMoves(a).some((m) => m.to !== c)) return { from: a, to: c };
    }
    return null;
  })()`);
  const fpin = await runJS(`window.eulertrail.pinOf(${cross ? cross.from : -1})`);
  const tpin = await runJS(`window.eulertrail.pinOf(${cross ? cross.to : -1})`);
  const againBefore = await runJS(`window.eulertrail.events(400).filter((e) => e.type === 'again').length`);
  await dragStroke([fpin, tpin]);
  const crossed = await runJS(`({ covered: window.eulertrail.state.covered, committed: window.eulertrail.state.committed,
    strokes: window.eulertrail.state.strokes, outcome: window.eulertrail.state.outcome,
    again: window.eulertrail.events(400).filter((e) => e.type === 'again').length,
    lit: window.eulertrail.drawn().filter((d) => d).length })`);
  rec('a real drag back over finished ink is refused, unbilled and uncounted',
    !!cross && crossed.again > againBefore && crossed.covered === after1.covered
    && crossed.committed === 1 && crossed.lit === after1.covered, { cross, againBefore, after1, crossed });
  rec('the board stays playable and one stroke deep after the refusal',
    crossed.outcome === 'playing' && crossed.strokes === 1, crossed);

  // Over-drag past the boundary: one honest edge, then a hard fling off the board along a
  // diagonal (the lattice has no diagonal edges, so the clamp can stall but never teleport
  // the pen onto ink the pointer did not cross).
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(180);
  const before = await runJS(`({ covered: window.eulertrail.state.covered, strokes: window.eulertrail.state.strokes })`);
  const v0 = await runJS(`window.eulertrail.pinOf(${t0.verts[0]})`);
  const v1 = await runJS(`window.eulertrail.pinOf(${t0.verts[1]})`);
  await mouse('mousePressed', v0.x, v0.y, 1);
  await mouse('mouseMoved', v1.x, v1.y, 1);                       // one honest edge
  const afterEdge = await runJS(`({ covered: window.eulertrail.state.covered, held: window.eulertrail.state.strokes })`);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', v1.x - i * 120, v1.y - i * 120, 1);
  const outside = await runJS(`(() => { const g = window.eulertrail; return g.probe(${v1.x - 720}, ${v1.y - 720}); })()`);
  await mouse('mouseReleased', v1.x - 720, v1.y - 720, 0);
  await sleep(140);
  const fling = await runJS(`({ covered: window.eulertrail.state.covered, strokes: window.eulertrail.state.strokes, committed: window.eulertrail.state.committed, outcome: window.eulertrail.state.outcome })`);
  rec('a drag that leaves the board cannot draw anything it did not cross',
    afterEdge.covered === before.covered + 1 && fling.covered === before.covered + 1
    && fling.committed === 1 && fling.strokes === 1
    && !!outside && outside.v === -1 && outside.clamped === true,
    { before, afterEdge, outside, fling });

  // par+1 with the real mouse: legal asks, a catastrophic budget -> lost, never crashed,
  // and undo still reaches the board.
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(160);
  const over = await runJS(`window.eulertrail.playOver()`);
  await sleep(160);
  rec('over par loses loudly and keeps answering the pen', over.outcome === 'lost' && over.strokes === over.par + 1, over);
  const beforeUndo = await runJS(`({ covered: window.eulertrail.state.covered, committed: window.eulertrail.state.committed, par: window.eulertrail.state.par })`);
  const undoBack = await runJS(`window.eulertrail.clickUndo()`);
  const afterUndo = await runJS(`({ outcome: window.eulertrail.state.outcome, covered: window.eulertrail.state.covered, committed: window.eulertrail.state.committed, curtain: window.eulertrail.state.curtain })`);
  rec('undo from the lost card reopens the board instead of leaving it dead',
    afterUndo.outcome === 'playing' && afterUndo.curtain === false
    && afterUndo.committed === beforeUndo.committed - 1 && afterUndo.covered < beforeUndo.covered
    && undoBack === beforeUndo.committed - 1, { beforeUndo, afterUndo, undoBack });

  // keyboard shortcuts the shell advertises, dispatched for real
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(160);
  await runJS(`window.eulertrail.playStroke(0); 'ok'`);
  await sleep(120);
  const kStrokes = await runJS(`window.eulertrail.state.committed`);
  await key('u');
  await sleep(180);
  rec('the u key undoes', (await runJS(`window.eulertrail.state.committed`)) === kStrokes - 1, { before: kStrokes, after: await runJS(`window.eulertrail.state.committed`) });
  await key('h');
  await sleep(180);
  rec('the h key asks for a hint', (await runJS(`window.eulertrail.state.hints`)) === 1, await runJS(`window.eulertrail.state.hints`));
  await key('r');
  await sleep(180);
  rec('the r key restarts', (await runJS(`window.eulertrail.state.covered`)) === 0, await runJS(`window.eulertrail.state`));

  // where the pen is after all that: the page still computes geometry for a finger
  const geom = await runJS(`(() => {
    const g = window.eulertrail;
    const p = g.pinOf(g.baked()[0].verts[0]);
    const hit = g.probe(p.x + 6, p.y + 6);
    const miss = g.probe(p.x + 30, p.y + 30);
    return { hit: hit.v, miss: miss.v, pin: p.v, cell: p.cell };
  })()`);
  rec('a pin 6px away is still the same pin, 30px away is no pin at all',
    geom.hit === geom.pin && geom.miss === -1, geom);

  return { rows };
}

// In-page suites. Each returns { rows: [{ test, pass, detail }] }.
const SCENARIOS = {
  boot: `(async () => {
    const g = window.eulertrail;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    rec('the shell boots straight into a campaign lot', g && g.version === 1 && g.state && g.state.mode === 'campaign', g && g.state);
    const c = document.getElementById('board');
    rec('the canvas has real pixels (not the 300x150 default)', c.width > 320 && c.height > 240 && !!c.getContext('2d'), { w: c.width, h: c.height });
    const lit = (() => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    })();
    rec('the lattice was actually painted', lit > 50, { litSamples: lit });
    const pool = g.pool;
    rec('the shipped pool loaded', pool && pool.lots === 48, pool && pool.lots);
    rec('every band reports a measured range', Object.values(pool.byTier).every((t) => t.n === 12 && t.par.min <= t.par.max && t.badRatio.min > 0), pool.byTier);
    const t = g.theorem;
    rec('theorem == construction == exhaustive for the lot on screen',
      t.theorem === t.par && t.built === t.par && (t.skipped || t.exhaustive === t.par), t);
    rec('the printed odd count is even and yields par by the theorem', t.odd % 2 === 0 && Math.max(1, t.odd / 2) === t.par, { odd: t.odd, par: t.par });
    const readout = document.getElementById('readout').textContent;
    rec('the panel prints par, strokes, coverage and the odd count',
      /笔数上限/.test(readout) && /已用笔数/.test(readout) && /覆盖边数/.test(readout) && /奇点数/.test(readout), readout.slice(0, 120));
    rec('the panel shows the three-path proof line', /三条路/.test(readout) && /穷举/.test(readout), readout.slice(100, 260));
    return { rows };
  })()`,

  play: `(async () => {
    const g = window.eulertrail;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);

    g.store.reset();
    g.load('#/c/1'); await sleep(150);
    const par = g.state.par;
    const total = g.state.total;
    rec('the baked cover exists and has exactly par strokes', g.baked().length === par, { par, baked: g.baked().length });

    const first = g.playStroke(0);
    rec('playing baked stroke 1 commits one stroke', first.ok && first.committed && g.state.committed === 1 && g.state.covered > 0, { ...first, covered: g.state.covered });
    const coveredBy1 = g.state.covered;

    // 口径 2 through the real rules: redraw an edge stroke 1 already drew.
    const spent = g.baked()[0].edges[0];
    const re = g.redrawEdge(spent);
    rec('dragging over drawn ink: coverage and budget do not move', re.ok && re.after.covered === coveredBy1, re);
    rec('and the rules name it, so the view can flash it', re.step && re.step.reason === 'drawn', re.step);

    const over = g.playOver();
    rec('a sloppy player loses at par+1 without the page throwing', over.outcome === 'lost' && over.strokes === par + 1, over);
    rec('the loss card explains the theorem instead of hiding it', !D('curtain').hidden && /奇点/.test(D('tally').textContent), D('tally').textContent);
    const lost = { covered: g.state.covered, strokes: g.state.strokes, outcome: g.state.outcome };
    g.clickUndo(); await sleep(90);
    rec('undo from the loss card reopens the board and pays one edge back',
      g.state.outcome === 'playing' && g.state.committed === par && g.state.covered === lost.covered - 1, { lost, now: g.state });
    const oneEdgeBack = g.state.covered;
    g.clickUndo(); await sleep(90);
    rec('undo is not a discount on the budget: it retires one stroke at a time',
      g.state.committed === par - 1 && g.state.covered === oneEdgeBack - 1 && g.state.outcome === 'playing', g.state);

    D('restart').click(); await sleep(150);
    rec('restart returns the level to the theorem', g.state.covered === 0 && g.state.committed === 0 && g.state.par === par, g.state);
    const all = g.playAll();
    rec('playing the whole baked cover wins at exactly par', all.outcome === 'won' && all.strokes === par && all.covered === total, all);
    rec('the grade is perfect: three stars, one curtain', g.grade().key === 'perfect' && g.state.curtain, { grade: g.grade(), curtain: g.state.curtain });
    const h = g.hintOnce();
    rec('the hint button is off once the level is won, and asks for nothing',
      h.hints === 0 && D('hint').disabled && g.state.outcome === 'won', { hints: h.hints, disabled: D('hint').disabled });
    return { rows };
  })()`,

  routes: `(async () => {
    const g = window.eulertrail;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    g.load('#/c/7'); await sleep(150);
    rec('#/c/7 is campaign slot seven', g.state.index === 7 && g.state.mode === 'campaign', g.state);
    g.load('#/c/99999'); await sleep(150);
    rec('a huge index clamps to the last level', g.state.index === g.pool.lots, { index: g.state.index, lots: g.pool.lots });
    g.load('#/c/0'); await sleep(150);
    rec('index zero clamps up to one', g.state.index === 1, g.state.index);

    g.load('#/daily'); await sleep(150);
    const daily = g.state.id;
    g.load('#/c/1'); await sleep(150);
    g.load('#/daily'); await sleep(150);
    rec('the daily route is the same puzzle twice', g.state.mode === 'daily' && g.state.id === daily, { first: daily, again: g.state.id });
    rec('the daily label carries the date', /^每日一笔 · \\d{4}-\\d{2}-\\d{2}$/.test(g.state.label), g.state.label);

    for (const tier of Object.keys(g.pool.byTier)) {
      g.load('#/random/' + tier + '/fixedseed'); await sleep(140);
      const first = g.state.id;
      const band = g.pool.byTier[tier].par;
      const inBand = g.state.par >= band.min && g.state.par <= band.max;
      g.load('#/c/1'); await sleep(140);
      g.load('#/random/' + tier + '/fixedseed'); await sleep(140);
      rec('#/random/' + tier + ' repeats itself and stays in band',
        g.state.tier === tier && g.state.id === first && inBand, { tier: g.state.tier, id: g.state.id, first, par: g.state.par, band });
    }
    const seen = {};
    for (const s of ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8']) {
      g.load('#/random/tandem/' + s); await sleep(120);
      seen[s] = g.state.id;
    }
    g.load('#/random/tandem/c3'); await sleep(120);
    const distinct = new Set(Object.values(seen)).size;
    rec('a seed only picks an index: one token replays one lot, and tokens spread inside the band',
      g.state.id === seen.c3 && distinct >= 2 && Object.values(seen).every((id) => /^tandem-/.test(id)),
      { seen, replay: g.state.id, distinct });
    g.load('#/random'); await sleep(260);
    rec('a bare #/random mints a token into the URL', /^#\\/random\\/[a-z]+\\/[a-z0-9]+$/.test(location.hash), location.hash);

    g.load('#/c/5'); await sleep(140);
    const sample = g.state.id;
    const sampleProof = { par: g.state.par, odd: g.state.odd, total: g.state.total };
    g.load('#/c/1'); await sleep(140);
    g.load('#/lot/' + sample); await sleep(140);
    rec('#/lot/<id> opens that lot', g.state.id === sample && g.state.mode === 'lot', { want: sample, got: g.state.id });
    rec('the shared link carries the same theorem as the campaign slot did',
      g.state.par === sampleProof.par && g.state.odd === sampleProof.odd && g.state.total === sampleProof.total,
      { fromCampaign: sampleProof, fromLink: { par: g.state.par, odd: g.state.odd, total: g.state.total } });
    rec('the state reports the shareable route form for the lot on screen',
      g.state.route === '#/lot/' + sample && g.state.hash === '#/lot/' + sample, { route: g.state.route, hash: g.state.hash });
    g.load('#/c/1'); await sleep(160);
    const firstCampaign = g.state.id;
    g.load('#/lot/not-a-real-lot'); await sleep(160);
    rec('an unknown lot id falls back to a real board instead of blanking',
      g.state.mode === 'lot' && g.state.id === firstCampaign && g.state.total > 0 && g.state.par >= 1,
      { got: g.state.id, want: firstCampaign });
    return { rows };
  })()`,

  save: `(async () => {
    const g = window.eulertrail;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const KEY = 'eulertrail.save.v1';

    g.store.reset();
    g.load('#/c/1'); await sleep(160);
    rec('a wiped save is empty', Object.keys(g.store.records).length === 0 && g.store.unlocked === 1, { unlocked: g.store.unlocked });

    g.playAll();
    const id = g.state.id;
    await sleep(160);
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('the solve reaches localStorage under the documented key', !!(raw && raw.records[id] && raw.records[id].best === g.state.par), raw && Object.keys(raw.records || {}));
    rec('clearing the first level unlocks the second', g.store.unlocked === 2 && raw.unlocked === 2, { unlocked: g.store.unlocked });
    const shelf2 = document.querySelector("#shelf button[data-index='2']");
    rec('the shelf lets level two be clicked, and takes it there', shelf2 && !shelf2.disabled, shelf2 && shelf2.outerHTML);

    g.load('#/daily'); await sleep(160);
    const day = g.state.label.split(' · ')[1];
    g.playAll();
    await sleep(160);
    const mark = g.store.dailyDone(day);
    rec('today is logged once solved', !!mark && mark.id === g.state.id, { day, mark });
    rec('the shelf says today is done', /已通过/.test(document.getElementById('shelf').textContent), document.getElementById('shelf').textContent);

    g.load('#/c/2'); await sleep(140);
    const before = g.store.unlocked;
    g.playAll(); await sleep(140);
    g.load('#/c/1'); await sleep(140);
    g.playAll(); await sleep(140);
    rec('re-solving level 1 cannot lock level 3 away again', g.store.unlocked >= before, { before, after: g.store.unlocked });
    const rec1 = g.store.record(g.state.id);
    rec('best never regresses across repeat plays', rec1.best === g.state.par && rec1.plays >= 2, rec1);

    // The wipe is the only destructive control, so it arms on the first click.
    D('wipe').click(); await sleep(80);
    const armed = Object.keys(g.store.records).length;
    rec('the first click only arms it', armed > 0, { armed });
    D('wipe').click(); await sleep(200);
    rec('清空存档 takes two clicks and clears everything',
      Object.keys(g.store.records).length === 0 && g.store.unlocked === 1 && localStorage.getItem(KEY) === null,
      { records: Object.keys(g.store.records), unlocked: g.store.unlocked, key: localStorage.getItem(KEY) });
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
