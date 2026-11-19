/* 文匠 AI — Service Worker
   目标：装到主屏幕后即使没网也能打开（壳与内置快照都在缓存里），
   热榜这类数据优先取网络，拿不到再用上一次的缓存。
   改版时把 VERSION 加一，旧缓存会在 activate 时清掉。 */

const VERSION = 'wj-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;      // 模型接口、外站代理一律直连
  if (url.pathname.indexOf('/api/') === 0) return; // 后端接口不缓存

  const isData = /\/data\/hot\.json$/.test(url.pathname);
  if (isData) {
    /* 热榜：先网络，失败用缓存 */
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match(req).then((m) => m || Response.error()))
    );
    return;
  }

  /* 其它同源资源：先缓存，后台更新 */
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return r;
        })
        .catch(() => hit || caches.match('./index.html'));
      return hit || net;
    })
  );
});
