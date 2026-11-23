/* 验证：静态站（GitHub Pages）头条热榜优先走内置节点，拿实时数据 */
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync('assets/js/live.js', 'utf8');
const calls = [];
const store = {};

function fakeFetch(url, opts) {
  calls.push(String(url));
  const u = String(url);
  // 内置节点 /api/hot：返回实时头条（带新鲜 updatedAt）
  if (u.includes('app.workbuddy.host') && u.includes('/api/hot')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        updatedAt: new Date(Date.now() - 30*3600*1000).toISOString(),
        items: [
          { title: '实时头条测试一', hot: 100, url: 'https://a' },
          { title: '实时头条测试二', hot: 90, url: 'https://b' },
          { title: '实时头条测试三', hot: 80, url: 'https://c' }
        ]
      })
    });
  }
  // 其它（60s/codelife/imsyy/health）都失败
  return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('blocked') });
}

const ctx = {
  window: {},
  location: { protocol: 'https:', hostname: 'oynana2023.github.io', search: '' },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  fetch: fakeFetch,
  URLSearchParams,
  URL,
  Date,
  Math,
  JSON,
  setTimeout,
  clearTimeout,
  console,
  DOMParser: function () {},
  AbortController
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

const out = await ctx.window.WJLive.hot('toutiao');
const r = out.toutiao;
console.log('=== 防误标：内置节点旧快照不得当成实时===');
console.log('ok:', r.ok);
console.log('via:', r.via);
console.log('条目:', r.items && r.items.length);
console.log('首条:', r.items && r.items[0] && r.items[0].title);
const cloudCalled = calls.some((c) => c.includes('app.workbuddy.host') && c.includes('/api/hot'));
const directCalled = calls.some((c) => c.includes('60s.viki') || c.includes('codelife') || c.includes('imsyy'));
console.log('调了内置节点:', cloudCalled);
console.log('调了失效直连:', directCalled);
const pass = r.via !== 'live' && cloudCalled;
console.log(pass ? '\n✓ PASS：旧快照未被误标为实时（新鲜度保护生效）' : '\n✗ FAIL');
process.exit(pass ? 0 : 1);
