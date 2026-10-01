// 自制帧率／静音量具（派工单规范 §3）。官方 cos_frame_probe.js 用 vm.runInContext 载入
// <script src> 正文，本仓是 ESM（`<script type="module">`），它报"无法比对"——比对就在这里做：
// 真 import 被测模块，自己驱动 requestAnimationFrame 时钟（起点 1000ms），LCG 选关，
// 30/60/120Hz 三档跑同一段墙上时间后逐字段比对，并按规范 §6 把 `simAccumulator += elapsed`
// 改坏做阴性对照（必须变红，否则全绿不算数）。
//
//   node tools/fps_probe.mjs frame .       三档帧率逐字段比对 + 暂停推进读数
//   node tools/fps_probe.mjs frame . neg   阴性对照
//   node tools/fps_probe.mjs audio .       真静音：振荡器节点创建计数
//   COS_REDUCE=1 node tools/fps_probe.mjs frame .   reduceMotion 分支同样三档一致
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const [, , MODE, REPO, NEG] = process.argv;
const repo = path.resolve(REPO || '.');

// 确定性 LCG（规范 §3：不许用 Math.random 做样本）
let s = 20261001 >>> 0;
function lcg() { s = (1103515245 * s + 12345) >>> 0; return s / 4294967296; }

// ---- DOM / browser 桩 ------------------------------------------------------
let now = 1000;                       // 沙盒时钟从 1000ms 起（规范 §3）
let rafQueue = [];
let rafId = 1;
const store = new Map();

class CtxStub {
  constructor(canvas) { this.canvas = canvas; this.fillStyle = ''; this.strokeStyle = ''; }
}
const ctxProxy = new Proxy(new CtxStub(null), {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'createPattern') return () => ({ __pattern: true });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    return () => undefined;
  },
  set(t, k, v) { t[k] = v; return true; },
});

let IMG_LOADS = 0;
globalThis.Image = class {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this._cb = []; }
  addEventListener(type, fn) { if (type === 'load') this._cb.push(fn); }
  set src(v) {
    this._src = v;
    this.naturalWidth = 8; this.naturalHeight = 8;
    queueMicrotask(() => { IMG_LOADS++; for (const fn of this._cb) fn({ type: 'load' }); });
  }
};

let OSC = 0;               // 被创建的振荡器节点数
let CTXS = 0;
class FakeParam { constructor(v) { this.value = v; } setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class FakeAudioCtx {
  constructor() { CTXS++; this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = { __dest: 1 }; }
  createOscillator() { OSC++; return { type: 'sine', frequency: new FakeParam(440), detune: new FakeParam(0), connect() {}, disconnect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: new FakeParam(1), connect() {}, disconnect() {} }; }
  createBiquadFilter() { return { type: 'lowpass', frequency: new FakeParam(1000), Q: new FakeParam(1), connect() {}, disconnect() {} }; }
  createBufferSource() { return { buffer: null, playbackRate: new FakeParam(1), connect() {}, start() {}, stop() {} }; }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
globalThis.AudioContext = FakeAudioCtx;
globalThis.webkitAudioContext = FakeAudioCtx;

globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let REDUCE = process.env.COS_REDUCE === '1';
globalThis.matchMedia = () => ({ matches: REDUCE, addEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafId++; };
globalThis.cancelAnimationFrame = () => { rafQueue = []; };
globalThis.performance = { now: () => now };
globalThis.devicePixelRatio = 2;
globalThis.PointerEvent = function () {};
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-harness', maxTouchPoints: 0 }, configurable: true, writable: true });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

async function pump(intervalMs, frames) {
  for (let i = 0; i < frames; i++) {
    now += intervalMs;
    const q = rafQueue; rafQueue = [];
    for (const fn of q) fn(now);
    await Promise.resolve();   // 让 Image 桩的 microtask 回调跑到（精灵必须真就绪）
  }
}

function makeCanvas() {
  const handlers = {};
  const c = {
    width: 0, height: 0, style: {}, nodeType: 1, handlers,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 }),
    getContext: () => ctxProxy,
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener: () => {},
    setPointerCapture: () => {}, releasePointerCapture: () => {}, focus: () => {},
    get rootStyle() { return { setProperty() {} }; },
  };
  return c;
}

// ---- frame 模式 ------------------------------------------------------------
async function frameMode() {
  const viewPath = path.join(target, 'js/view.js');
  let src = fs.readFileSync(viewPath, 'utf8');
  if (NEG) {
    const before = src;
    src = src.replace('simAccumulator += elapsed;', 'simAccumulator += SIM_STEP;');
    if (src === before) throw new Error('阴性对照没能改坏目标行');
    console.log('阴性对照：simAccumulator += elapsed  →  += SIM_STEP（改成吃掉帧数的写法）');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosfrm-'));
  fs.cpSync(target, tmp, { recursive: true, filter: (s) => !path.basename(s).startsWith('.git') });
  fs.writeFileSync(path.join(tmp, 'js/view.js'), src);

  const { createView } = await import(pathToFileURL(path.join(tmp, 'js/view.js')).href);
  const { createGame } = await import(pathToFileURL(path.join(tmp, 'js/core/game.js')).href);
  const { rc } = await import(pathToFileURL(path.join(tmp, 'js/core/graph.js')).href);
  const { LOTS } = await import(pathToFileURL(path.join(tmp, 'js/data/lots.js')).href);

  const lot = LOTS[Math.floor(lcg() * LOTS.length)];
  const SIM = 1 / 60;                       // 与 view.js 的 SIM_STEP 同值，判定用
  const SETUP = 0.4, DRAG = 0.2, RUN = 2;   // 每段都是三档帧周期的整数倍：三档墙上时长必须相等
  const RUN_SECONDS = RUN;
  const frames = (hz, sec) => Math.round(hz * sec);
  const results = {};
  for (const hz of [30, 60, 120]) {
    const interval = 1000 / hz;
    const canvas = makeCanvas();
    const game = createGame(lot);
    const view = createView(canvas, { onEvent: () => {} });
    view.attach(game);
    view.measure();
    view.start();
    now = 1000;
    await pump(interval, frames(hz, SETUP));

    // 1) 真拖一笔（沿关卡的第 0 条边），再拖一次同一条边 → 触发 flash（"这条已经画过"）
    const pt = (id) => { const { r, c } = rc(id, game.g); return view.vertexPoint(r, c); };
    const va = pt(game.g.ea[0]);
    const vb = pt(game.g.eb[0]);
    if (!va || !vb) throw new Error('vertexPoint 不可用：先 attach 一个真关卡');
    for (let pass = 0; pass < 2; pass++) {
      const h = (t) => canvas.handlers[t] && canvas.handlers[t][0];
      h('pointerdown')({ clientX: va.x, clientY: va.y, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} });
      h('pointermove')({ clientX: vb.x, clientY: vb.y, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} });
      await pump(interval, frames(hz, DRAG));
      h('pointermove')({ clientX: va.x, clientY: va.y, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} });
      h('pointerup')({ clientX: va.x, clientY: va.y, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} });
    }
    // 2) 一次提示，它的寿命也必须走仿真钟
    view.showHint({ edge: 0, vertex: -1 });
    const before = view.simState().simSteps;
    await pump(interval, frames(hz, RUN));   // 同一段墙上时间
    const s = view.simState();
    results[hz] = Object.assign({}, s, { stepsRun: s.simSteps - before, wallMs: RUN_SECONDS * 1000 });
    view.stop();
  }

  // 3) 暂停：pump 60 帧，仿真一步都不许推进，指针事件只报告不改变棋局
  const pauseEvents = [];
  {
    const canvas = makeCanvas();
    const game = createGame(lot);
    const view = createView(canvas, { onEvent: (e) => pauseEvents.push(e) });
    view.attach(game);
    view.measure();
    view.start();
    now = 1000;
    await pump(1000 / 60, 5);
    view.setPaused(true);
    const b = view.simState();
    await pump(1000 / 60, 60);
    const a = view.simState();
    const coveredBefore = game.covered;
    canvas.handlers.pointerdown[0]({ clientX: 120, clientY: 120, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} });
    canvas.handlers.pointerup[0]({ clientX: 130, clientY: 120, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} });
    const coveredAfter = game.covered;
    view.setPaused(false);
    await pump(1000 / 60, 10);
    const r = view.simState();
    console.log(`暂停：pump 60 帧 → simSteps Δ=${a.simSteps - b.simSteps} animClock Δ=${(a.animClock - b.animClock).toFixed(4)} covered Δ=${coveredAfter - coveredBefore} 上报=${pauseEvents.filter((e) => e.type === 'paused').length} 条 paused 事件`);
    console.log(`恢复：再 pump 10 帧 → simSteps Δ=${r.simSteps - a.simSteps}（应 >0）`);
  }

  const TIME_FIELDS = new Set(['animClock', 'hintLeft', 'flash', 'simAccumulator']);
  const COUNT_FIELDS = new Set(['simSteps', 'stepsRun', 'flashSteps']);
  // 容差 = 一档最粗帧长（30Hz = 2 个仿真步）：阶段边界取样本身带这个相位差，不是帧率相关。
  const TOL_TIME = 2 * SIM, TOL_COUNT = 2;
  const keys = [...new Set(Object.keys(results[60]))].sort();
  let red = 0;
  console.log(`lot=${lot.id} 每档墙上时长=${RUN_SECONDS}s  spriteLoads=${IMG_LOADS}  容差=30Hz 一帧（${TOL_TIME.toFixed(5)}s / ${TOL_COUNT} 步）`);
  for (const k of keys) {
    const v = [30, 60, 120].map((hz) => results[hz][k]);
    const f = (x) => (typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(5)) : String(x));
    let verdict;
    if (v.every((x) => typeof x === 'number')) {
      const mx = Math.max(...v), mn = Math.min(...v);
      const spread = mx - mn;
      const tol = TIME_FIELDS.has(k) ? TOL_TIME : COUNT_FIELDS.has(k) ? TOL_COUNT : 0;
      const ratio = mn === 0 ? (mx === 0 ? 1 : Infinity) : mx / mn;
      verdict = spread <= tol + 1e-9 ? 'OK' : (ratio > 3.6 || spread > 0.05 * (TIME_FIELDS.has(k) ? 20 : 1)) ? 'RED' : 'NEAR';
      if (verdict === 'RED') red++;
      console.log(`  ${verdict.padEnd(4)} ${k}: 30Hz=${f(v[0])} 60Hz=${f(v[1])} 120Hz=${f(v[2])}  极差=${f(spread)} 容差=${f(tol)} 比值=${Number.isFinite(ratio) ? ratio.toFixed(3) : 'Inf'}`);
    } else {
      verdict = v.every((x) => String(x) === String(v[0])) ? 'OK' : 'RED';
      if (verdict === 'RED') red++;
      console.log(`  ${verdict.padEnd(4)} ${k}: 30Hz=${f(v[0])} 60Hz=${f(v[1])} 120Hz=${f(v[2])}`);
    }
  }
  const ratio = results[30].animClock / results[120].animClock;
  console.log(`animClock 30Hz/120Hz = ${ratio.toFixed(4)}  （>3.6 判帧率相关）`);
  console.log(`红字字段：${red}`);
  console.log(NEG ? (red > 0 ? '阴性对照结论：改坏目标行后确实变红 —— 靶子有效，上面的绿才算数' : '阴性对照结论：改坏目标行后仍然全绿 —— 靶子无效，比对不算数')
                 : (red === 0 ? '结论：三档帧率逐字段落在容差内，仿真与帧率无关' : '结论：存在帧率相关字段，未通过'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- audio 模式 ------------------------------------------------------------
async function audioMode() {
  const { audio } = await import(pathToFileURL(path.join(target, 'js/core/audio.js')).href);
  audio.init();
  const events = ['down', 'step', 'lift', 'again', 'refuse', 'hint', 'ui', 'win', 'lose'];
  const playAll = (n) => { for (let i = 0; i < n; i++) for (const e of events) audio.play(e); };

  audio.muted = false;
  const n0 = audio.nodes;
  playAll(4);
  const n1 = audio.nodes;
  const s0 = audio.state();

  audio.muted = true;
  const ctxStateAfterMute = audio.ctxState;
  const n2 = audio.nodes;
  playAll(4);
  const n3 = audio.nodes;
  const s1 = audio.state();

  audio.muted = false;
  const n4 = audio.nodes;
  playAll(1);
  const n5 = audio.nodes;

  console.log('== 真静音读数 ==');
  console.log(`不静音 4 轮 × ${events.length} 声：振荡器节点 ${n0} → ${n1}（新增 ${n1 - n0}），suppressed=${s0.suppressed}`);
  console.log(`静音后 4 轮 × ${events.length} 声：振荡器节点 ${n2} → ${n3}（新增 ${n3 - n2}），suppressed=${s1.suppressed}，ctx.state=${ctxStateAfterMute}`);
  console.log(`解静音 1 轮：节点 ${n4} → ${n5}（新增 ${n5 - n4}），ctx.state=${audio.ctxState}`);
  const gateOk = (n3 - n2) === 0 && (n1 - n0) > 0 && (n5 - n4) > 0 && s1.suppressed > s0.suppressed;
  const suspendOk = ctxStateAfterMute === 'suspended';
  console.log(`静音门：静音态新建节点 = ${n3 - n2}（要求 0），被抑制请求 = ${s1.suppressed}（要求 >0）→ ${gateOk ? 'PASS' : 'FAIL'}`);
  console.log(`AudioContext 真停：suspend 后 state = ${ctxStateAfterMute} → ${suspendOk ? 'PASS' : 'FAIL'}`);
  console.log(`音源持久化：${store.get('eulertrail.sound.v1') === null ? '无（内存态）' : store.get('eulertrail.sound.v1')}`);
  console.log(`结论：${gateOk && suspendOk ? '静音是真停，不是把音量调成 0' : '静音不成立'}`);
}

const target = repo;
if (MODE === 'frame') await frameMode();
else if (MODE === 'audio') await audioMode();
else console.log('用法: node cos_probe.mjs <frame|audio> <repoDir> [neg]');
