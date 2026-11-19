/**
 * 抓取公开热榜，生成 data/hot.json
 * 由 GitHub Actions 每 15 分钟执行一次；也可以本地手动跑：node scripts/fetch-hot.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const AGG = 'https://api-hot.imsyy.top';

const SOURCES = [
  { id: 'weibo', name: '微博' },
  { id: 'zhihu', name: '知乎' },
  { id: 'toutiao', name: '头条' },
  { id: 'baidu', name: '百度' },
  { id: 'douyin', name: '抖音' },
  { id: 'bilibili', name: 'B站' },
  { id: '36kr', name: '36氪' },
  { id: 'sspai', name: '少数派' },
  { id: 'ithome', name: 'IT之家' },
  { id: 'geekpark', name: '极客公园' }
];

function timeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function get(url, type = 'json', ms = 15000) {
  const r = await fetch(url, {
    signal: timeout(ms),
    headers: {
      'User-Agent': UA,
      Accept: type === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return type === 'json' ? r.json() : r.text();
}

const BLOCK =
  /(习近平|李强|王毅|政治局|中央委员会|国务院|全国人大|政协|外交部|国防部|解放军|军队|军事|战争|停火|制裁|外交|峰会|会见|会晤|国事访问|特朗普|普京|拜登|泽连斯基|内塔尼亚胡|总统|首相|大选|选举|投票|台湾|台独|香港|新疆|西藏|疫情|核酸|封控|脱贫|党建|纪委|反腐|落马|双开|巡视|两会|党章|国旗|阅兵|主权|领土|总书记|共同体|一带一路|中国贡献|中国机遇|大国担当|APEC|G20|G7|上合|金砖|联合国|中方|我方|美方|外交部|发言人|大使|领馆|使馆|国事|会谈|磋商|白宫|克里姆林宫|欧盟委员会|会见|接见|访华|出访|致辞|贺信|批示|委员长|总理|外长|防长|军委|部队|导弹|演习|反制|政要|领导人|亚太合作|元首|国宴|使节|参赞|国际关系|地缘|制裁|军演|航母|战机|外交部|驻华)/;

function num(v) {
  const n = Number(String(v ?? 0).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function tidy(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const title = String(it?.title ?? it?.Title ?? it?.word ?? '').trim();
    if (!title || title.length < 4) continue;
    if (BLOCK.test(title)) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, hot: num(it?.hot ?? it?.HotValue ?? it?.hotValue), url: it?.url || it?.Url || '' });
  }
  return out.slice(0, 50);
}

/* ---------- 通道 1：聚合接口（CORS 友好，字段统一） ---------- */
async function viaAgg(id) {
  const d = await get(`${AGG}/${id}`, 'json', 12000);
  const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
  if (!arr.length) throw new Error('聚合接口无数据');
  return tidy(arr);
}

/* ---------- 通道 2：官方接口直连 ---------- */
async function viaToutiao() {
  const d = await get('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', 'json');
  return tidy(d.data || []);
}

async function viaBilibili() {
  const d = await get('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', 'json');
  return tidy((d?.data?.list || []).map((x) => ({ title: x.title, hot: x.stat?.view, url: x.short_link_v2 || '' })));
}

async function viaBaidu() {
  const html = await get('https://top.baidu.com/board?tab=realtime', 'text');
  const m = html.match(/<!--s-data:([\s\S]*?)-->/);
  if (!m) throw new Error('页面结构变了');
  const d = JSON.parse(m[1]);
  const cards = d?.data?.cards || [];
  const items = [];
  for (const c of cards) for (const it of c.content || []) items.push({ title: it.word, hot: it.hotScore, url: it.url });
  return tidy(items);
}

/* ---------- 通道 3：RSS（标题+链接，真实、稳定、全球可达） ---------- */
function rssTitles(xml) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<title>([\s\S]*?)<\/title>/);
    if (!m) continue;
    const title = m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '')
      .trim();
    const lm = b.match(/<link>([\s\S]*?)<\/link>/);
    if (title && title.length > 4) items.push({ title, hot: 0, url: (lm ? lm[1].trim() : '') });
  }
  return items;
}

const RSS = {
  ithome: 'https://www.ithome.com/rss/',
  sspai: 'https://sspai.com/feed',
  geekpark: 'https://www.geekpark.net/rss'
};

async function viaRss(url) {
  const xml = await get(url, 'text');
  return tidy(rssTitles(xml));
}

const DIRECT = {
  toutiao: viaToutiao,
  bilibili: viaBilibili,
  baidu: viaBaidu
};

async function one(id) {
  try {
    const items = await viaAgg(id);
    if (items.length) return { ok: true, via: 'aggregate', items };
  } catch (e) {
    /* 继续尝试直连 */
  }
  if (RSS[id]) {
    try {
      const items = await viaRss(RSS[id]);
      if (items.length) return { ok: true, via: 'rss', items };
    } catch (e) {
      /* fallthrough */
    }
  }
  if (DIRECT[id]) {
    try {
      const items = await DIRECT[id]();
      if (items.length) return { ok: true, via: 'direct', items };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  return { ok: false, error: '所有通道失败' };
}

const sources = {};
let ok = 0;

await Promise.all(
  SOURCES.map(async (s) => {
    const r = await one(s.id);
    if (r.ok) ok++;
    sources[s.id] = { name: s.name, ...r };
    console.log(`${r.ok ? 'OK ' : 'ERR'} ${s.id.padEnd(9)} ${r.items ? r.items.length + ' 条 · ' + r.via : r.error}`);
  })
);

if (ok === 0) {
  console.error('所有源都失败了，保留上一次的文件不动。');
  process.exit(0);
}

const payload = {
  updatedAt: new Date().toISOString(),
  okCount: ok,
  sources
};

await mkdir('data', { recursive: true });
await writeFile('data/hot.json', JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`\n写入 data/hot.json，可用源 ${ok}/${SOURCES.length}`);
