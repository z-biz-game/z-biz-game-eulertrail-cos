// 声音。这个模块存在的唯一理由是"静音必须是真的"：
//
//   · 静音态下 suspend() 真的把 AudioContext 停掉，并且**一个振荡器节点都不许新建**。
//     只把 master gain 设成 0 是假静音 —— 节点还在建、还在排程、还在吃 CPU 与电量，
//     而 Safari 在后台标签里会因为"有活跃音频"拒绝把页面挂起。
//   · 取消静音走 resume()，之前排程的音不会像 gain 那样"攒一下再全部放出来"。
//
// 浏览器不允许在用户手势之前出声，所以 ctx 是懒建的：第一次真实按下（pointerdown /
// keydown / click）才 new AudioContext。在此之前 muted 与 nodes 都是可读的，play()
// 只是安静地不响 —— 那不是 bug，那是规范。
//
// `nodes` 计数器是给验收用的：静音前后各打一次，两次必须相等。

const PREF_KEY = 'eulertrail.sound.v1';
const VOICES = {
  // 每条音用「基频 / 时长 / 波形 / 二阶泛音」描述，音高关系是五度与八度，
  // 所以一局听下来是同一支笔在纸上走，而不是随机哔哔声。
  down: { f: 392, d: 0.055, type: 'triangle', harm: 1.5, gain: 0.16 },
  step: { f: 523.25, d: 0.045, type: 'triangle', harm: 2, gain: 0.13 },
  lift: { f: 349.23, d: 0.07, type: 'sine', harm: 1.5, gain: 0.12 },
  again: { f: 174.61, d: 0.06, type: 'square', harm: 1.06, gain: 0.07 },
  refuse: { f: 130.81, d: 0.05, type: 'square', harm: 1.33, gain: 0.06 },
  hint: { f: 659.25, d: 0.09, type: 'sine', harm: 2.02, gain: 0.1 },
  ui: { f: 293.66, d: 0.035, type: 'sine', harm: 2, gain: 0.07 },
  win: { f: 523.25, d: 0.42, type: 'sine', harm: 1.5, gain: 0.2, arp: [1, 1.26, 1.5, 2] },
  lose: { f: 261.63, d: 0.34, type: 'sawtooth', harm: 0.75, gain: 0.12, arp: [1, 0.84, 0.67] },
};

let ctx = null;
let master = null;
let muted = false;
let nodes = 0;         // 真被创建过的振荡器数量，静音态必须一条不改
let attempts = 0;      // 被静音挡掉的调用次数，用来证明"事件确实来了但没出声"

function readPref() {
  try {
    const ls = globalThis.localStorage;
    return ls && typeof ls.getItem === 'function' ? ls.getItem(PREF_KEY) : null;
  } catch (err) {
    return null;
  }
}

function writePref(v) {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.setItem === 'function') ls.setItem(PREF_KEY, v ? '1' : '0');
  } catch (err) {
    /* 隐私窗口 / 配额：静音态仍然在本次会话里生效，只是下次进来要重按 */
  }
}

function supported() {
  return typeof globalThis.AudioContext !== 'undefined' || typeof globalThis.webkitAudioContext !== 'undefined';
}

function ensure() {
  if (ctx || muted || !supported()) return ctx;
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  } catch (err) {
    ctx = null;
    master = null;
  }
  return ctx;
}

// 静音时这里直接返回：一个 createOscillator 都不执行，`nodes` 因此是硬的证据。
function voice(spec) {
  if (muted) { attempts++; return false; }
  const c = ensure();
  if (!c) return false;
  const t0 = c.currentTime;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(spec.gain, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.d);
  env.connect(master);
  const parts = [[spec.f, 1], [spec.f * spec.harm, 0.34]];
  for (const [freq, amp] of parts) {
    const osc = c.createOscillator();
    nodes++;
    osc.type = spec.type;
    osc.frequency.setValueAtTime(freq, t0);
    const g = c.createGain();
    g.gain.setValueAtTime(amp, t0);
    osc.connect(g);
    g.connect(env);
    osc.start(t0);
    osc.stop(t0 + spec.d + 0.02);
  }
  return true;
}

export const audio = {
  init() {
    const pref = readPref();
    muted = pref === null ? false : pref === '1';
    return { muted, supported: supported() };
  },

  play(name) {
    const spec = VOICES[name];
    if (!spec) return false;
    if (spec.arp) {
      // 琶音：同一支笔的连续几笔，共用一次静音判定，静音时整串都不许出声。
      if (muted) { attempts++; return false; }
      if (!ensure()) return false;
      spec.arp.forEach((mul, i) => {
        const base = spec.f * mul;
        voice({ ...spec, f: base, gain: spec.gain * (1 - i * 0.16), arp: null, d: spec.d / spec.arp.length + 0.03 });
      });
      return true;
    }
    return voice(spec);
  },

  // 用户手势里调一次即可；已静音时不建 ctx，省掉 iOS 上那个"未交互就 resume"的警告。
  unlock() { if (!muted) ensure(); },

  set muted(v) {
    const next = !!v;
    if (next === muted) return muted;
    muted = next;
    writePref(muted);
    if (muted) this.suspend();
    else this.resume();
    return muted;
  },

  get muted() { return muted; },
  get nodes() { return nodes; },
  get suppressed() { return attempts; },
  get ctxState() { return ctx ? ctx.state : 'none'; },

  toggle() { this.muted = !muted; this.play('ui'); return muted; },

  suspend() {
    if (!ctx || !ctx.suspend) return 'none';
    const p = ctx.suspend();
    if (p && p.catch) p.catch(() => {});
    return 'suspended';
  },

  resume() {
    if (muted || !ctx || !ctx.resume) return 'none';
    const p = ctx.resume();
    if (p && p.catch) p.catch(() => {});
    return 'running';
  },

  // 暂停 = 声音也要停：玩家按 P 之后墨水与音效必须一起冻住，否则"暂停"只是个遮罩。
  pause() { return this.suspend(); },
  unpause() { return muted ? 'muted' : this.resume(); },

  state() {
    return { muted, nodes, suppressed: attempts, ctxState: this.ctxState, supported: supported() };
  },
};
