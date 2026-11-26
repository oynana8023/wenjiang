/* 验证：AI 生图 API 已从实时数据层移除；原帖图与识图能力保留 */
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync('assets/js/live.js', 'utf8');
const store = {};
const ctx = {
  window: {},
  location: { protocol: 'https:', hostname: 'oynana2023.github.io', search: '' },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  fetch: () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }),
  URLSearchParams, URL, Date, Math, JSON, setTimeout, clearTimeout, console,
  DOMParser: function () {}, AbortController
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

const L = ctx.window.WJLive;
const removed = ['genImage', 'genImageChain', 'probeImage'];
const kept = ['visionAsk', 'imgUrl', 'parseLink', 'hot', 'chatChain'];
let ok = true;
console.log('=== 已移除（AI 生图）===');
for (const k of removed) {
  const gone = !(k in L);
  console.log((gone ? '✓' : '✗') + ' ' + k + (gone ? ' 已移除' : ' 仍存在'));
  if (!gone) ok = false;
}
console.log('=== 应保留 ===');
for (const k of kept) {
  const has = typeof L[k] === 'function';
  console.log((has ? '✓' : '✗') + ' ' + k + (has ? ' 在' : ' 丢失'));
  if (!has) ok = false;
}
console.log(ok ? '\n✓ PASS：生图 API 已清除，原帖图/识图能力保留' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
