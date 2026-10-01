// 离线壳。两条口径写死在这里，因为它们各自毁过一版：
//
// 1. cache 名带 VERSION。不带版本号的 cache 会在发新版后继续喂旧 js，玩家永远等不到
//    那一关的修复，而且现场无法复现（"我这边是好的"）。
// 2. 同源子资源**网络优先、失败退缓存**。手工 VERSION + cache-first 的组合会把 js/css
//    钉死在旧版，出新 HTML 配旧 JS 的鬼状态 —— 本仓的 js/ 是 ES module，HTML 与 module
//    不同版就会 import 到不存在的导出，白屏且没有可读报错。
//
// 导航请求（index.html）反过来：缓存优先、网络回填。断网时玩家仍然打得开游戏，
// 而 js/css 永远走网络优先，所以"打得开"不等于"停在旧逻辑"。

const VERSION = 'eulertrail-v1';
const NAV_CACHE = `${VERSION}-nav`;
const ASSET_CACHE = `${VERSION}-asset`;
const SHELL = ['./', './index.html', './css/game.css', './manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(NAV_CACHE);
    await Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (!key.startsWith(VERSION)) await caches.delete(key);   // 只留当前版本，旧壳不占配额
    }
    await self.clients.claim();
  })());
});

function isSameOrigin(url, self0) {
  return url.protocol === self0.protocol && url.host === self0.host;
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isSameOrigin(url, self.location)) return;             // 第三方一律不代理
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) {
        // 命中旧壳也要把它刷成新页，否则第二次断网又退回上一版。
        ev.waitUntil(fetch(req).then((r) => r && r.ok && caches.open(NAV_CACHE).then((c) => c.put(req, r))).catch(() => {}));
        return hit;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const clone = res.clone();
          ev.waitUntil(caches.open(NAV_CACHE).then((c) => c.put(req, clone)));
        }
        return res;
      } catch (err) {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
        throw err;
      }
    })());
    return;
  }

  // 子资源：网络优先。只有断网/5xx 才退到上一次成功抓到的副本。
  ev.respondWith((async () => {
    let netError = null;
    let res = null;
    try {
      res = await fetch(req);
    } catch (err) {
      netError = err;
    }
    if (res && res.ok) {
      const clone = res.clone();
      ev.waitUntil(caches.open(ASSET_CACHE).then((c) => c.put(req, clone)));
      return res;
    }
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (netError) throw netError;
    return res || Response.error();
  })());
});
