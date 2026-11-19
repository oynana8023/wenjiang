/**
 * 本地/自建服务器（可选）
 * - 托管静态文件
 * - /api/health   给前端探测「有后端」
 * - /api/hot      复用 scripts/fetch-hot.mjs 的结果，10 分钟内缓存
 * - /api/parse    服务端抓正文，绕过浏览器跨域
 *
 * 用法：node server.js     默认 http://localhost:3000
 * GitHub Pages 不需要它；没有它时前端会自动走公共接口与快照。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8'
};

/* ---------------- 热榜 ---------------- */

const HOT_FILE = path.join(ROOT, 'data', 'hot.json');
let hotCache = null;
let hotBusy = null;

function readHot() {
  try {
    return JSON.parse(fs.readFileSync(HOT_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function refreshHot() {
  if (hotBusy) return hotBusy;
  hotBusy = new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'fetch-hot.mjs')], { timeout: 90000 }, (err, stdout, stderr) => {
      if (stdout) console.log(stdout.trim());
      if (err) console.error('[hot] 抓取失败', err.message);
      hotBusy = null;
      hotCache = readHot();
      resolve(hotCache);
    });
  });
  return hotBusy;
}

async function getHot(src) {
  if (!hotCache) hotCache = readHot();
  if (!hotCache) {
    /* 冷启动、连快照文件都没有：只能等一次抓取 */
    await refreshHot();
    hotCache = readHot();
  } else if (Date.now() - new Date(hotCache.updatedAt).getTime() > 10 * 60 * 1000) {
    /* 过期就后台刷新，本次先把手上的快照发出去——热榜抓一轮要十几秒，
       让前端干等会把 /api/hot 拖成超时，前端就误判「后端挂了」。 */
    refreshHot()
      .then(() => { hotCache = readHot(); })
      .catch(() => { /* 下一轮再试 */ });
  }
  const snap = hotCache || { sources: {} };
  if (src && src !== 'all') {
    const s = snap.sources && snap.sources[src];
    if (!s || !s.ok) return { ok: false, error: (s && s.error) || '这个源暂时抓不到' };
    return { ok: true, id: src, name: s.name, items: s.items, updatedAt: snap.updatedAt };
  }
  return { ok: true, sources: snap.sources, updatedAt: snap.updatedAt };
}

/* ---------------- 正文抽取 ---------------- */

const NOISE = /^(登录|注册|下载客户端|扫码|打开APP|广告|版权所有|免责声明|责任编辑|点击查看|上一篇|下一篇|相关阅读|热门推荐)/;

function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|h\d|li|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

function tidyText(t) {
  return String(t)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l.slice(0, 24)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCK_MARKERS = [
  /<div[^>]*id=["']js_content["'][^>]*>/i,
  /<(?:div|section)[^>]*id=["']paragraph["'][^>]*>/i,
  /<(?:div|section|article)[^>]*class=["'][^"']*(?:rich_media_content|post_content|article-content|artical-content|article_content|entry-content|content-detail|article-body|post-body)[^"']*["'][^>]*>/i,
  /<article[^>]*>/i,
  /<(?:div|section)[^>]*class=["'][^"']*(?:content|article|post)[^"']*["'][^>]*>/i
];

/* 正文结束的常见标记，切掉评论、推荐、版权等尾巴 */
const CUT_TAIL = /(?:class|id)=["'][^"']*(?:comment|footer|related|recommend|sidebar|share-bar)[^"']*["']|相关阅读|免责声明|责任编辑|转载请注明|本文来自|举报/;

function pickBlock(h) {
  for (const re of BLOCK_MARKERS) {
    const m = h.match(re);
    if (!m || m.index === undefined) continue;
    let seg = h.slice(m.index, m.index + 160000);
    const tail = seg.slice(600).search(CUT_TAIL);
    if (tail > 0) seg = seg.slice(0, 600 + tail);
    const text = tidyText(stripTags(seg));
    if (text.length >= 120) return { text, marker: String(re).slice(0, 40) };
  }
  return null;
}

function extract(html) {
  let h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  const title =
    (h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
    '';

  let text = '';
  const picked = pickBlock(h);
  if (picked) text = picked.text;
  if (text.length < 120) {
    const ps = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    const alt = tidyText(stripTags(ps.join('\n')));
    if (alt.length > text.length) text = alt;
  }

  return {
    title: tidyText(stripTags(title)).slice(0, 120),
    text
  };
}

/* ---------------- 元信息（分类 / 发布时间 / 头图 / 原图） ---------------- */

/* 分类词典：标题与描述里出现哪个领域的词多，就归到哪一类。
   时政类在热榜阶段已经被过滤，这里不设对应分类。 */
const CATS = [
  ['科技数码', /(手机|芯片|处理器|半导体|AI|人工智能|大模型|模型|苹果|iPhone|华为|小米|OPPO|vivo|荣耀|三星|特斯拉|SpaceX|机器人|算法|开源|软件|系统|鸿蒙|安卓|iOS|笔记本|显卡|GPU|算力|数据中心|卫星|火箭|量子|发布会|新品)/g],
  ['财经商业', /(股价|市值|营收|财报|融资|上市|IPO|收购|并购|裁员|降薪|涨价|降价|消费|电商|零售|品牌|市场|经济|投资|基金|利率|关税|供应链|工厂|产能)/g],
  ['汽车出行', /(汽车|车型|续航|试驾|新能源|电车|充电|智驾|自动驾驶|车企|比亚迪|理想|蔚来|小鹏|问界|油车|上市新车)/g],
  ['娱乐影视', /(电影|剧集|电视剧|综艺|明星|演员|导演|票房|演唱会|音乐|专辑|番剧|动漫|二次元|红毯|官宣|恋情)/g],
  ['游戏电竞', /(游戏|电竞|主机|Steam|手游|版本更新|玩家|开服|联动|抽卡|赛事|战队)/g],
  ['体育竞技', /(比赛|球队|赛季|冠军|奥运|球员|联赛|进球|夺冠|决赛|NBA|中超|世界杯|全运会)/g],
  ['健康医疗', /(健康|医生|医院|疾病|药品|疫苗|睡眠|减肥|体检|心理|抑郁|养生)/g],
  ['教育学习', /(学生|考试|高考|中考|考研|大学|课程|教师|留学|作业|招生)/g],
  ['生活方式', /(美食|餐厅|旅行|旅游|城市|天气|家居|穿搭|咖啡|露营|宠物|摄影|探店)/g],
  ['社会民生', /(交通|地铁|高铁|房价|租房|社区|物业|外卖|快递|就业|工资|社保|养老|诈骗|消防)/g]
];

const SOURCE_CAT = {
  ithome: '科技数码', geekpark: '科技数码', sspai: '数字生活',
  '36kr': '财经商业', zhihu: '话题讨论', bilibili: '视频热门',
  douyin: '短视频', weibo: '社交热搜', baidu: '搜索热榜', toutiao: '资讯热点'
};

function metaTags(h) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(h))) {
    const tag = m[0];
    const k = (tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const v = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (k && v != null) out[k.toLowerCase()] = decode(v).trim();
  }
  return out;
}

/* 标题里的词权重加倍：正文描述常常顺带提到别的行业，会带偏分类 */
function classify(title, extra, fallback) {
  let best = '', bestScore = 0;
  for (const [name, re] of CATS) {
    const n = (String(title).match(re) || []).length * 2 + (String(extra).match(re) || []).length;
    if (n > bestScore) { bestScore = n; best = name; }
  }
  if (bestScore >= 2) return best;
  return fallback || '';
}

function absUrl(u, base) {
  if (!u) return '';
  let s = String(u).trim().replace(/^["']|["']$/g, '');
  if (!s || /^data:/i.test(s) || /^javascript:/i.test(s)) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  if (/^https?:\/\//i.test(s)) return s;
  if (!base) return '';
  try { return new URL(s, base).href; } catch (e) { return ''; }
}

function normTime(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  const d = new Date(s.replace(/\./g, '-').replace(/\s+/g, ' '));
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return d.toISOString();
  return '';
}

function metaOf(html, target, sourceId) {
  const h = String(html);
  const m = metaTags(h);
  const base = target.origin + '/';

  const ld = {};
  const ldBlocks = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of ldBlocks) {
    try {
      const j = JSON.parse(b[1].trim());
      const arr = Array.isArray(j) ? j : [j];
      for (const one of arr) {
        if (!one || typeof one !== 'object') continue;
        if (one['@graph']) {
          for (const g of one['@graph']) Object.assign(ld, g);
        } else {
          Object.assign(ld, one);
        }
      }
    } catch (e) { /* 站点写坏的 JSON-LD 很常见，忽略 */ }
  }

  const title =
    m['og:title'] || m['twitter:title'] || ld.headline || ld.name ||
    (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = m['og:description'] || m['description'] || m['twitter:description'] || ld.description || '';

  const wxCt = (h.match(/var\s+ct\s*=\s*["'](\d{9,13})["']/) || [])[1];
  const wxName = (h.match(/var\s+nickname\s*=\s*["']([^"']+)["']/) || [])[1];
  const published = normTime(
    m['article:published_time'] || m['og:release_date'] || m['pubdate'] || m['publishdate'] ||
    ld.datePublished || ld.dateCreated || wxCt ||
    (h.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1]
  );

  const site = m['og:site_name'] || wxName || ld.publisher && ld.publisher.name ||
    target.hostname.replace(/^www\./, '');
  const author = m['article:author'] || m['author'] || wxName ||
    (ld.author && (ld.author.name || (Array.isArray(ld.author) ? ld.author[0].name : ''))) || '';
  const section = m['article:section'] || (Array.isArray(ld.articleSection) ? ld.articleSection[0] : ld.articleSection) || '';
  const keywords = (m['keywords'] || ld.keywords || '')
    .split(/[,，;；|]/).map((x) => x.trim()).filter((x) => x && x.length < 16).slice(0, 6);

  /* 图片候选：og / twitter / JSON-LD / 公众号 msg_cdn_url / 正文里的图 */
  const raw = [
    m['og:image'], m['og:image:url'], m['twitter:image'], m['twitter:image:src'],
    h.match(/var\s+msg_cdn_url\s*=\s*["']([^"']+)["']/), h.match(/var\s+cdn_url\s*=\s*["']([^"']+)["']/),
    typeof ld.image === 'string' ? ld.image : (Array.isArray(ld.image) ? ld.image[0] : (ld.image && ld.image.url))
  ].map((x) => (Array.isArray(x) ? x[1] : x));

  const contentHtml = pickBlockSource(h) || h;
  const inner = [...contentHtml.matchAll(/<img[^>]+?(?:data-src|data-original|src)\s*=\s*["']([^"']+)["']/gi)]
    .map((x) => x[1]).slice(0, 12);
  const images = [];
  for (const u of raw.concat(inner)) {
    const a = absUrl(u, base);
    if (!a) continue;
    if (/logo|avatar|icon|qrcode|erweima|blank|spacer|pixel|1x1|sprite|emoji|placeholder/i.test(a)) continue;
    if (/\/t\.(png|jpg|gif)$|\/default\.(png|jpg)$|\/loading[^/]*\.(gif|png)$/i.test(a)) continue;
    if (/\.(svg|ico)(\?|$)/i.test(a)) continue;
    /* 同一张图常被 CDN 用两个域名各给一份，按文件名去重 */
    var baseName = a.split('?')[0].split('/').pop().toLowerCase();
    if (images.indexOf(a) < 0 && !images.some(function (x) { return x.split('?')[0].split('/').pop().toLowerCase() === baseName; })) {
      images.push(a);
    }
    if (images.length >= 8) break;
  }

  const titlePlain = tidyText(stripTags(title)).slice(0, 120);

  return {
    title: titlePlain,
    desc: tidyText(stripTags(desc)).slice(0, 260),
    site: String(site || '').slice(0, 40),
    author: String(author || '').slice(0, 40),
    published,
    section: String(section || '').slice(0, 20),
    category: classify(title, [desc, keywords.join(' '), section].join(' '), SOURCE_CAT[sourceId] || ''),
    keywords,
    images,
    head: images[0] || ''
  };
}

/* 找正文容器在 HTML 里的位置，供取图用 */
function pickBlockSource(h) {
  for (const re of BLOCK_MARKERS) {
    const m = h.match(re);
    if (!m || m.index === undefined) continue;
    const seg = h.slice(m.index, m.index + 120000);
    if (stripTags(seg).length > 200) return seg;
  }
  return '';
}


/* 抓下来的 HTML 缓存 10 分钟：先点「这条热榜」看头图，再点「解析正文」时不用重复抓一遍 */
const pageCache = new Map();
const PAGE_TTL = 10 * 60 * 1000;

function pageGet(url) {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit;
  if (hit) pageCache.delete(url);
  return null;
}

function pageSet(url, html) {
  if (pageCache.size > 40) pageCache.clear();
  pageCache.set(url, { at: Date.now(), html });
}

async function grabHtml(target, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const isWx = /mp\.weixin\.qq\.com$/.test(target.hostname);
  try {
    const res = await fetch(target.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: isWx ? 'https://mp.weixin.qq.com/' : target.origin + '/'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function parseUrl(url) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');

  const cached = pageGet(url);
  if (cached) {
    const hit = extract(cached.html);
    if (hit.text.length >= (/mp\.weixin\.qq\.com/.test(target.hostname) ? 90 : 120)) return hit;
  }

  const tries = [UA_MOBILE, UA_DESKTOP];
  let lastErr = '';
  for (const ua of tries) {
    try {
      const html = await grabHtml(target, ua);
      pageSet(url, html);
      if (/环境异常|去验证|该内容已被发布者删除|此内容因违规无法查看/.test(html) && !/id=["']js_content["']/.test(html)) {
        lastErr = '微信拦住了解析（文章要求微信内打开，或已被删除）';
        continue;
      }
      const out = extract(html);
      const need = /mp\.weixin\.qq\.com/.test(target.hostname) ? 90 : 120;
      if (out.text.length >= need) return out;
      lastErr = '正文只有 ' + out.text.length + ' 字';
    } catch (e) {
      lastErr = e.name === 'AbortError' ? '抓取超时' : e.message;
    }
  }
  throw new Error(lastErr || '解析失败');
}

async function metaFor(url) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');

  const cached = pageGet(url);
  if (cached) return metaOf(cached.html, target);

  let lastErr = '';
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    try {
      const html = await grabHtml(target, ua);
      pageSet(url, html);
      if (!/环境异常|去验证/.test(html) || /id=["']js_content["']/.test(html)) return metaOf(html, target);
      lastErr = '微信拦住了解析';
    } catch (e) {
      lastErr = e.name === 'AbortError' ? '抓取超时' : e.message;
    }
  }
  throw new Error(lastErr || '取不到页面信息');
}

/* ---------------- 服务 ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('hot.json') ? 'no-store' : 'public, max-age=60'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (u.pathname.startsWith('/api/')) {
    try {
      if (u.pathname === '/api/health') return send(res, 200, { ok: true, version: '2.0.0', runtime: 'node' });
      if (u.pathname === '/api/hot') {
        const d = await getHot(u.searchParams.get('src') || 'all');
        return send(res, 200, d);
      }
      if (u.pathname === '/api/parse') {
        const url = u.searchParams.get('url');
        if (!url) return send(res, 400, { ok: false, error: '缺少 url' });
        const out = await parseUrl(url);
        return send(res, 200, { ok: true, title: out.title, text: out.text.slice(0, 12000), chars: out.text.length });
      }
      if (u.pathname === '/api/meta') {
        const url = u.searchParams.get('url');
        if (!url) return send(res, 400, { ok: false, error: '缺少 url' });
        const meta = await metaFor(url);
        return send(res, 200, Object.assign({ ok: true }, meta));
      }
      return send(res, 404, { ok: false, error: '接口不存在' });
    } catch (e) {
      return send(res, 502, { ok: false, error: e.message || '服务异常' });
    }
  }

  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  serveFile(res, filePath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('文匠 AI 已启动: http://localhost:' + PORT);
  console.log('静态目录: ' + ROOT);
});
