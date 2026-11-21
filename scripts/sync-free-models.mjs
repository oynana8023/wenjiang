/**
 * 同步「免费模型清单」。
 *
 *   node scripts/sync-free-models.mjs
 *
 * 做三件事：
 * 1. 把资料库里每一条免费模型真调一次（中文短句），写不出成句中文的剔除；
 * 2. 顺手探一下上游开源项目 Ebony-Vinyl/dsh-our-free-model 的清单，
 *    它的免费车道（opencode / kilo 网关）需要服务端代发、且按地区与额度限流，
 *    浏览器直连会被预检拦下，所以只记录为「需服务端」，不并入默认清单；
 * 3. 结果写回 data/free-models.json，App 里点「检查更新」就能拉到。
 *
 * 由 .github/workflows/free-models.yml 每周跑一次，也可以本地手动跑。
 */
import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'data/free-models.json';
const ASK = '用一句通顺的中文介绍杭州，20 字以内。';

async function tryModel(m) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(m.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(m.key ? { Authorization: 'Bearer ' + m.key } : {})
      },
      body: JSON.stringify({
        model: m.id,
        messages: [{ role: 'user', content: ASK }],
        max_tokens: 120,
        temperature: 0.3,
        stream: false
      })
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status + ' ' + ((d && d.error && d.error.message) || '') };
    const ch = (d && d.choices && d.choices[0]) || {};
    const msg = ch.message || {};
    const txt = String(msg.content || msg.reasoning_content || msg.reasoning || ch.text || '').trim();
    const cn = (txt.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (!txt || cn < 5) return { ok: false, why: '没写出成句中文（' + txt.slice(0, 20) + '）' };
    return { ok: true, ms: Date.now() - t0, said: txt.slice(0, 40) };
  } catch (e) {
    return { ok: false, why: e.name === 'AbortError' ? '超时 30 秒' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeUpstream() {
  /* 上游项目：免费车道来自 opencode / kilo 网关。仅记录状态，不并入清单。 */
  const out = [];
  const targets = [
    { name: 'OpenCode Zen', url: 'https://opencode.ai/inference/v1/chat/completions', model: 'big-pickle' },
    { name: 'Kilo 免费池', url: 'https://api.kilo.ai/api/gateway/chat/completions', model: 'kilo-auto/free' }
  ];
  for (const t of targets) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(t.url, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Origin: 'https://oynana8023.github.io' },
        body: JSON.stringify({ model: t.model, messages: [{ role: 'user', content: ASK }], max_tokens: 80, stream: false })
      });
      const body = await r.text();
      const acao = r.headers.get('access-control-allow-origin') || '';
      out.push({
        name: t.name,
        status: r.status,
        cors: acao || '无',
        browser: !!acao && r.status === 200,
        sample: body.slice(0, 160)
      });
    } catch (e) {
      out.push({ name: t.name, status: 0, cors: '无', browser: false, sample: String(e.message || e) });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

const doc = JSON.parse(await readFile(FILE, 'utf8'));
const kept = [];
const dropped = [];

for (const m of doc.models || []) {
  const r = await tryModel(m);
  if (r.ok) {
    kept.push({ ...m, checked: new Date().toISOString().slice(0, 10), ms: r.ms, said: r.said });
    console.log('✓', m.name, m.id, r.ms + 'ms', r.said.slice(0, 24));
  } else {
    dropped.push({ name: m.name, id: m.id, why: r.why });
    console.log('✗', m.name, m.id, r.why);
  }
}

const upstream = await probeUpstream();
upstream.forEach(u => console.log('·上游', u.name, 'HTTP', u.status, 'CORS:', u.cors, '→ 浏览器可直连:', u.browser));

const next = {
  ...doc,
  updatedAt: new Date().toISOString(),
  models: kept,
  droppedThisRun: dropped,
  upstream
};
await writeFile(FILE, JSON.stringify(next, null, 2) + '\n');
console.log('写入', FILE, '保留', kept.length, '剔除', dropped.length);
