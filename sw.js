/* 文匠 AI — Service Worker
   目标：装到主屏幕后即使没网也能打开（壳与内置快照都在缓存里），
   热榜这类数据优先取网络，拿不到再用上一次的缓存。
   改版时把 VERSION 加一，旧缓存会在 activate 时清掉。 */

const VERSION = 'wj-v38';
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

  const isData = /\/data\/(hot|topics)\.json$/.test(url.pathname);
  if (isData) {
    /* 兜底数据必须「先网络」。
       以前这里是 cache-first：装到主屏之后，浏览器永远先交上一次存下来的 hot.json，
       后台拉新的存回去，但这一次显示的仍是旧的——用户看到的就是「热榜还是以前的缓存」。
       GitHub 的定时任务本身有节流，快照本来就可能几小时才更新一次，再叠一层本地缓存，
       就变成「明明显示已更新，内容却是两天前的」。现在：网络优先（2.5 秒不回来才用缓存），
       拿到的立刻存一份离线用。 */
    e.respondWith((async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      try {
        const r = await fetch(req, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return r;
      } catch (err) {
        clearTimeout(t);
        const hit = await caches.match(req);
        return hit || Response.error();
      }
    })());
    return;
  }

  /* 页面本身：先网络，离线再用缓存。否则改了代码要等第二次打开才生效 */
  if (req.mode === 'navigate' || /\/index\.html$/.test(url.pathname) || url.pathname === '/') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
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
