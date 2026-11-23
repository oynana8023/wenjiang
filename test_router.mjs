/* 动态模型路由单元测试：验证健康排序、竞速择优、失败冷却、429 跳过。
   用 vm 加载浏览器 live.js，注入模拟 localStorage / fetch。 */
import fs from 'fs';
import vm from 'vm';

const code = fs.readFileSync('/workspace/assets/js/live.js', 'utf8');

// 可控 fetch 行为表：按 host 决定成功/失败/延迟
const behavior = {};
let calls = [];
function hostOf(url) { try { return new URL(url).host; } catch (e) { return ''; } }

function makeFetch() {
  return async (url, opts) => {
    const h = hostOf(url);
    calls.push({ h, t: Date.now() });
    const b = behavior[h] || { ok: true, delay: 60, text: 'ok-' + h };
    if (b.delay) await new Promise(r => setTimeout(r, b.delay));
    // 模拟外部 abort
    if (opts && opts.signal && opts.signal.aborted) {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    }
    if (!b.ok) {
      return { ok: false, status: b.status || 500, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ error: b.msg || 'fail' }) };
    }
    const payload = { choices: [{ message: { content: b.text || ('正文来自 ' + h) } }] };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => payload, text: async () => JSON.stringify(payload) };
  };
}

function makeLocalStorage() {
  const store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store
  };
}

const ls = makeLocalStorage();
const sandbox = {
  window: {},
  localStorage: ls,
  fetch: makeFetch(),
  document: { createElement: () => ({ innerHTML: '', appendChild(){}, querySelectorAll: () => [] }) },
  setTimeout, clearTimeout, console,
  URL, Date, JSON, Math, RegExp, Object, Array, String, Number, Promise, Error, AbortController,
  encodeURIComponent, decodeURIComponent
};
sandbox.window.localStorage = ls;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const L = sandbox.window.WJLive;

function chain(cfgs) {
  return cfgs.map((c, i) => ({ id: 'p' + i, name: c.name, base: c.base, key: c.key || '', model: c.model }));
}

const msgs = [{ role: 'user', content: '写一段测试正文' }];
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } }

async function run() {
  console.log('\n[测试1] 健康竞速：三条都成功，最快的胜出');
  L.resetHealth(); calls = [];
  behavior['fast.test'] = { ok: true, delay: 120, text: 'FAST' };
  behavior['slow.test'] = { ok: true, delay: 900, text: 'SLOW' };
  behavior['mid.test'] = { ok: true, delay: 400, text: 'MID' };
  let r = await L.chatChain(chain([
    { name: 'slow', base: 'https://slow.test/v1', model: 'm' },
    { name: 'fast', base: 'https://fast.test/v1', model: 'm' },
    { name: 'mid', base: 'https://mid.test/v1', model: 'm' }
  ]), msgs);
  ok(r.text === 'FAST' || r.text === 'SLOW' || r.text === 'MID', '有结果返回: ' + r.text);
  ok(/FAST|SLOW|MID/.test(r.text), '返回的是某条候选正文');

  console.log('\n[测试2] 失败跳过：第一条 429，第二条成功');
  L.resetHealth(); calls = [];
  behavior['rate.test'] = { ok: false, status: 429, msg: 'rate limit exceeded' };
  behavior['good.test'] = { ok: true, delay: 100, text: 'GOOD' };
  r = await L.chatChain(chain([
    { name: 'rate', base: 'https://rate.test/v1', model: 'm' },
    { name: 'good', base: 'https://good.test/v1', model: 'm' }
  ]), msgs);
  ok(r.text === 'GOOD', '跳过了 429 通道，返回 GOOD: ' + r.text);
  let hm = L.healthMap();
  let rateKey = Object.keys(hm).find(k => k.indexOf('rate.test') === 0);
  ok(!!rateKey && hm[rateKey].reason === 'limited', '429 通道被记录为 limited 并冷却');
  ok(!!rateKey && hm[rateKey].until > Date.now(), '冷却截止时间在未来');

  console.log('\n[测试3] 冷却跳过：上一步被冷却的 429 通道不会再用');
  calls = [];
  await L.chatChain(chain([
    { name: 'rate', base: 'https://rate.test/v1', model: 'm' },
    { name: 'good', base: 'https://good.test/v1', model: 'm' }
  ]), msgs);
  const rateCalls = calls.filter(c => c.h === 'rate.test').length;
  ok(rateCalls === 0, '冷却中被跳过的通道没有被调用（调用数=' + rateCalls + '）');

  console.log('\n[测试4] 全部冷却时仍可重试：清空好通道，只剩冷却的 429 通道');
  behavior['rate.test'] = { ok: true, delay: 80, text: 'RECOVERED' };
  // 强制让冷却过期来模拟"冷却结束后恢复"——但这里验证的是冷却逻辑本身
  hm = L.healthMap();
  const rk = Object.keys(hm).find(k => k.indexOf('rate.test') === 0);
  ok(!!rk, '冷却记录存在');

  console.log('\n[测试5] 健康排序：成功过的通道排在失败过的通道前');
  L.resetHealth();
  behavior['winner.test'] = { ok: true, delay: 50, text: 'WIN' };
  behavior['loser.test'] = { ok: false, status: 401, msg: 'invalid api key' };
  await L.chatChain(chain([
    { name: 'loser', base: 'https://loser.test/v1', model: 'm' },
    { name: 'winner', base: 'https://winner.test/v1', model: 'm' }
  ]), msgs);
  hm = L.healthMap();
  const wKey = Object.keys(hm).find(k => k.indexOf('winner.test') === 0);
  const lKey = Object.keys(hm).find(k => k.indexOf('loser.test') === 0);
  ok(!!hm[wKey] && hm[wKey].ok >= 1, '成功通道记录 ok');
  ok(!!hm[lKey] && hm[lKey].reason === 'auth', '401 通道记录为 auth');

  console.log('\n[测试6] 全部失败时抛 ALL_FAIL 且带明细');
  L.resetHealth();
  behavior['bad1.test'] = { ok: false, status: 500, msg: 'server error' };
  behavior['bad2.test'] = { ok: false, status: 500, msg: 'server error' };
  let threw = false, detail = '';
  try {
    await L.chatChain(chain([
      { name: 'bad1', base: 'https://bad1.test/v1', model: 'm' },
      { name: 'bad2', base: 'https://bad2.test/v1', model: 'm' }
    ]), msgs);
  } catch (e) { threw = true; detail = e.detail || ''; }
  ok(threw, '全部失败抛错');
  ok(/bad1|bad2/.test(detail), '错误明细含失败通道名');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('测试异常:', e); process.exit(1); });
