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

const NOISE = /^(登录|注册|下载客户端|扫码|打开APP|广告|版权所有|免责声明|责任编辑|点击查看|上一篇|下一篇|相关阅读|热门推荐|收藏|播放列表|正在播放|热播榜|来源\s*[:：]|视频加载中|超清|标清|倍速)/;

const ENT = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
  bull: '\u2022', times: '\u00d7', divide: '\u00f7', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', emsp: '\u2003', ensp: '\u2002', thinsp: '\u2009',
  rarr: '\u2192', larr: '\u2190', harr: '\u2194', laquo: '\u00ab', raquo: '\u00bb',
  deg: '\u00b0', plusmn: '\u00b1', frac12: '\u00bd', sup2: '\u00b2', sup3: '\u00b3'
};

/* 实体必须全部还原：只有 &amp; 那一版会把 &mdash; 原样留在正文里，
   用户看到的原文就是「&mdash;&mdash;」，直接毁掉可信度 */
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z][a-z0-9]{1,9});/gi, (m, n) => {
      const v = ENT[n.toLowerCase()];
      return v === undefined ? m : v;
    });
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
  /* 页面里的图片地址常被转义成 &amp; / &#x2F;，不还原就会 404 */
  s = s.replace(/&amp;/g, '&').replace(/&#x2[fF];|&#47;/g, '/').replace(/&quot;/g, '');
  if (s.startsWith('//')) s = 'https:' + s;
  if (/^https?:\/\//i.test(s)) return s;
  if (!base) return '';
  try { return new URL(s, base).href; } catch (e) { return ''; }
}

/* 图片地址和标题做「去标点、去空白」的归一化，用来判断哪张图配的是这条热搜 */
function imgKey(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/* 一堆候选中挑最像头图的那张：百度缩略图带 size=w931 / r1,1，图标是 size=f54_54 这种 */
function pickHead(list) {
  let best = '', score = -99;
  for (const u of list) {
    let s = 0;
    if (/[?&]size=w\d{3,}/.test(u)) s += 3;
    if (/[?&]size=r\d+,\d+/.test(u)) s += 2;
    const f = u.match(/[?&]size=f(\d+)_(\d+)/);
    if (f && Number(f[1]) < 320) s -= 6;
    if (/logo|avatar|icon|qrcode/i.test(u)) s -= 6;
    if (/^https?:\/\/gips\d?\.baidu\.com/i.test(u) && !/[?&]size=w\d{3,}/.test(u)) s -= 3;
    if (s > score) { score = s; best = u; }
  }
  return best;
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
    (h.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1] ||
    /* 国内站点大多把时间写在 span 里，没有 og / JSON-LD */
    (h.match(/(?:pubtime|publish[-_]?time|post[-_]?time|article[-_]?time|time[-_]?source)[^>]*>\s*([^<]{8,32})</i) || [])[1] ||
    (h.match(/(20\d{2}[-/年]\s?\d{1,2}[-/月]\s?\d{1,2}日?\s+\d{1,2}:\d{2})/) || [])[1]
  );

  const site = m['og:site_name'] || wxName || ld.publisher && ld.publisher.name ||
    target.hostname.replace(/^www\./, '');
  const author = m['article:author'] || m['author'] || wxName ||
    (ld.author && (ld.author.name || (Array.isArray(ld.author) ? ld.author[0].name : ''))) || '';
  const section = m['article:section'] || (Array.isArray(ld.articleSection) ? ld.articleSection[0] : ld.articleSection) || '';
  const keywords = (m['keywords'] || ld.keywords || '')
    .split(/[,，;；|]/).map((x) => x.trim()).filter((x) => x && x.length < 16).slice(0, 6);

  /* 图片候选：og / twitter / JSON-LD / 公众号 msg_cdn_url / 正文里的图 */
  /* 百度热搜这类「榜单页」没有 og:image，大图藏在内嵌 JSON 里：
     {"poster":"https://gips1.baidu.com/...size=w931...","title":"这条热搜的标题"} */
  const mediaPics = [];
  for (const mm of h.matchAll(/"poster"\s*:\s*"([^"]+)"[\s\S]{0,800}?"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    mediaPics.push({ u: mm[1].replace(/\\\//g, '/'), t: mm[2] });
    if (mediaPics.length >= 8) break;
  }
  const pageKey = imgKey(String(title).replace(/\s*[-_|]\s*百度.*$/, ''));
  const poster = (pageKey
    ? mediaPics.find((x) => {
        const k = imgKey(x.t);
        return k && (k.indexOf(pageKey.slice(0, 12)) >= 0 || pageKey.indexOf(k.slice(0, 12)) >= 0);
      })
    : null) || mediaPics[0];

  const raw = [
    poster && poster.u,
    m['og:image'], m['og:image:url'], m['twitter:image'], m['twitter:image:src'],
    h.match(/var\s+msg_cdn_url\s*=\s*["']([^"']+)["']/), h.match(/var\s+cdn_url\s*=\s*["']([^"']+)["']/),
    typeof ld.image === 'string' ? ld.image : (Array.isArray(ld.image) ? ld.image[0] : (ld.image && ld.image.url))
  ].map((x) => (Array.isArray(x) ? x[1] : x));

  const contentHtml = pickBlockSource(h) || h;
  /* 懒加载站点的 src 是一个 1px 占位图，真图在 data-original / data-src 里。
     以前按 `src|data-original` 的先后匹配，永远先命中占位图，结果一张图都取不到。 */
  const inner = [...contentHtml.matchAll(/<img\b[^>]*>/gi)].map((x) => {
    const tag = x[0];
    /* 必须分两步：标签里 src 在 data-original 前面，一把梭的交替永远先命中占位图 */
    const lazy = tag.match(/(?:data-original|data-src|data-lazy-src|data-actualsrc|data-echo|data-url)\s*=\s*["']([^"']+)["']/i);
    if (lazy) return lazy[1];
    const plain = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    return plain ? plain[1] : '';
  }).filter(Boolean).slice(0, 20);
  const images = [];
  for (const u of raw.concat(inner)) {
    const a = absUrl(u, base);
    if (!a) continue;
    if (/logo|avatar|icon|qrcode|erweima|blank|spacer|pixel|1x1|sprite|emoji|placeholder/i.test(a)) continue;
    if (/\/t\.(png|jpg|gif)$|\/default\.(png|jpg)$|\/loading[^/]*\.(gif|png)$/i.test(a)) continue;
    if (/\.(svg|ico)(\?|$)/i.test(a)) continue;
    /* 百度把图标、箭头都做成 gips 图，带 size=f54_54 / f186_48 这种小尺寸 */
    const small = a.match(/[?&]size=f(\d+)_(\d+)/);
    if (small && Number(small[1]) < 320) continue;
    /* 同一张图常被 CDN 用两个域名各给一份，按文件名去重 */
    var baseName = a.split('?')[0].split('/').pop().toLowerCase();
    if (images.indexOf(a) < 0 && !images.some(function (x) { return x.split('?')[0].split('/').pop().toLowerCase() === baseName; })) {
      images.push(a);
    }
    if (images.length >= 8) break;
  }

  const titlePlain = tidyText(stripTags(title)).slice(0, 120);

  /* 百度搜索页：标题尾巴挂「 - 百度」，描述是「来自百度的搜索结果」，都不能直接用；
     真正的摘要和来源（新华社这类）藏在内嵌 JSON 的 summary / sourceList 里 */
  const isBaiduSearch = /(^|\.)baidu\.com$/i.test(target.hostname) && /^\/s\b/.test(target.pathname);
  let titleOut = titlePlain;
  let descOut = tidyText(stripTags(desc)).slice(0, 260);
  let authorOut = String(author || '').trim().slice(0, 40);
  if (isBaiduSearch) {
    titleOut = titlePlain.replace(/\s*[-_|]\s*百度.*$/i, '').trim() || titlePlain;
    const sum = (h.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1];
    if (sum) descOut = tidyText(sum.replace(/\\"/g, '"').replace(/\\\//g, '/')).slice(0, 260);
    else if (/^来自百度的搜索结果$/.test(descOut)) descOut = '';
    if (!authorOut) {
      const src = (h.match(/"sourceList"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/) || [])[1];
      if (src) authorOut = String(src).trim();
    }
  }

  return {
    title: titleOut,
    desc: descOut,
    site: String(site || '').slice(0, 40),
    author: authorOut,
    published,
    section: String(section || '').slice(0, 20),
    category: classify(titleOut, [descOut, keywords.join(' '), section].join(' '), SOURCE_CAT[sourceId] || ''),
    keywords,
    images,
    head: pickHead(images)
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

async function grabHtml(target, ua, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 15000);
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
    /* 404/410 也把响应体带回去：站点自己的「内容不存在或已被删除」页
       能让我们判断这是死链，而不是笼统的「HTTP 404」。 */
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) return await res.text();
      throw new Error('HTTP ' + res.status);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* 从榜单链接里反推标题：微博 s.weibo.com/weibo?q=#话题#、抖音 /search/关键词 */
function guessTitle(url) {
  try {
    const t = new URL(url);
    if (/weibo\.(com|cn)$/i.test(t.hostname)) {
      return String(t.searchParams.get('q') || '').replace(/^#+|#+$/g, '').replace(/\s+/g, ' ').trim();
    }
    if (/douyin\.com$/i.test(t.hostname)) {
      const m = t.pathname.match(/\/search\/(.+)$/);
      if (m) return decodeURIComponent(m[1]).replace(/\s+/g, ' ').trim();
    }
    if (/toutiao\.com$/i.test(t.hostname) && t.searchParams.get('title')) {
      return String(t.searchParams.get('title')).trim();
    }
  } catch (e) { /* ignore */ }
  return '';
}

/* 微博话题页、抖音搜索页是 JS 渲染的空壳，直抓只能拿到 0 字。
   退一步取该话题下真实博文正文（和头图走的是同一条 m.weibo.cn 通道）。 */
async function weiboPosts(title, limit) {
  const t = String(title || '').replace(/^#+|#+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const cid = '100103type=1&t=10&q=#' + t + '#';
  const j = await wbJson('/api/container/getIndex?containerid=' + encodeURIComponent(cid) + '&page_type=searchall');
  const rows = [];
  const imgs = [];
  let first = null;
  for (const c of (j.data && j.data.cards) || []) {
    const mb = c && c.card_type === 9 && c.mblog;
    if (!mb) continue;
    const txt = tidyText(stripTags(String(mb.text || '')));
    if (txt.length < 20) continue;
    if (rows.some((r) => r.indexOf(txt.slice(0, 18)) > -1)) continue;
    const who = (mb.user && mb.user.screen_name) || '';
    rows.push((who ? who + '：' : '') + txt);
    for (const p of (mb.pics || [])) {
      const u = (p && (p.large && p.large.url || p.url)) || '';
      if (u && imgs.indexOf(u) < 0) imgs.push(u.replace(/^http:/, 'https:'));
    }
    if (!first && mb.id) first = { url: 'https://m.weibo.cn/detail/' + mb.id, title: '相关微博原文' };
    if (rows.length >= (limit || 6)) break;
  }
  if (!rows.length) return null;
  const text = ('微博话题「' + t + '」下正在讨论的原文（按搜索结果顺序）\n\n' + rows.join('\n\n')).slice(0, 12000);
  return {
    title: '#' + t + '#',
    text,
    chars: text.length,
    via: 'weibo',
    note: '话题页由脚本动态渲染，这里取的是该话题下微博正文',
    images: imgs.slice(0, 9),
    related: first
  };
}

/* 同题报道：知乎/抖音/头条这类站点对抓取有风控时，用标题去百度资讯搜真实报道，
   抓其中正文最完整的一篇。只做「同一件事」的报道，不改写、不编造。 */
const NEWS_RE = /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>[\s\S]{0,600}?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

async function baiduNews(title, limit) {
  const html = await grabHtml(new URL('https://www.baidu.com/s?tn=news&word=' + encodeURIComponent(title)), UA_MOBILE);
  const out = [];
  NEWS_RE.lastIndex = 0;
  let m;
  while ((m = NEWS_RE.exec(html)) && out.length < (limit || 6)) {
    const link = m[1].replace(/&amp;/g, '&');
    const t2 = tidyText(stripTags(m[2]));
    if (!link || !t2 || /baidu\.com\/link/.test(link)) continue;
    if (out.some((x) => x.url === link)) continue;
    out.push({ url: link, title: t2.slice(0, 80) });
  }
  return out;
}

function newsQueries(title) {
  const base = String(title || '')
    .replace(/[#【】\[\]「」“”"'!?！？,，、|/：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const out = [];
  if (base) out.push(base);
  const segs = base.split(' ').filter((x) => x.length >= 2);
  if (segs.length > 1) out.push(segs.slice(0, 2).join(' '));
  [12, 10, 8, 6, 5].forEach((n) => {
    if (base.length > n) out.push(base.slice(0, n));
  });
  return [...new Set(out)].filter(Boolean);
}

const BING_RE = /<li class="b_algo"[\s\S]{0,1500}?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
function skipHost(u) {
  try {
    const h = new URL(u).hostname;
    if (/^baike\.baidu\.com$/i.test(h)) return true;
    return /(^|\.)(douyin|bilibili|youtube|zhihu|weibo)\./i.test(h);
  } catch (e) {
    return true;
  }
}

async function bingSearch(title, limit) {
  const html = await grabHtml(new URL('https://cn.bing.com/search?q=' + encodeURIComponent(title) + '&setlang=zh-CN'), UA_DESKTOP);
  const out = [];
  BING_RE.lastIndex = 0;
  let m;
  while ((m = BING_RE.exec(html)) && out.length < (limit || 6)) {
    const link = m[1].replace(/&amp;/g, '&');
    const t2 = tidyText(stripTags(m[2]));
    if (!link || !t2) continue;
    if (skipHost(link)) continue;
    if (out.some((x) => x.url === link)) continue;
    out.push({ url: link, title: t2.slice(0, 80) });
  }
  return out;
}

/* 搜回来的报道必须真的在讲这件事。只对上一两个词就收，等于给用户一篇别的新闻。 */
function titleMatch(text, title) {
  const body = String(text || '').slice(0, 1200);
  const base = String(title || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
  const toks = new Set();
  base.split(/\s+/).forEach((w) => {
    if (w.length >= 2) toks.add(w);
    if (/[\u4e00-\u9fa5]/.test(w)) {
      for (let i = 0; i + 2 <= w.length; i += 1) toks.add(w.slice(i, i + 2));
    }
  });
  if (!toks.size) return true;
  let hit = 0, total = 0;
  toks.forEach((t) => {
    if (t.length < 2) return;
    total += 1;
    if (body.indexOf(t) > -1) hit += 1;
  });
  if (!total) return true;
  /* 命中不到一半就说明搜到的是另一件事，宁可不给也不能给错 */
  return hit >= 2 && hit / total >= 0.5;
}

async function relatedParse(title, deadline) {
  for (const q of newsQueries(title).slice(0, 4)) {
    if (deadline && Date.now() > deadline) return null;
    let news = [];
    try { news = await bingSearch(q, 6); } catch (e) { news = []; }
    if (!news.length) {
      try { news = await baiduNews(q, 6); } catch (e) { news = []; }
    }
    for (const n of news.slice(0, 4)) {
      if (skipHost(n.url)) continue;
      if (deadline && Date.now() > deadline) return null;
      try {
        const html = await grabHtml(new URL(n.url), UA_MOBILE, 7000);
        const out = extract(html);
        if (out.text.length < 180) continue;
        if (!titleMatch(out.title + ' ' + out.text, title)) continue;
        return {
          title: out.title || n.title,
          text: out.text.slice(0, 12000),
          chars: out.text.length,
          via: 'related',
          related: n,
          note: '原页面抓不到正文，这里是对同一事件的报道'
        };
      } catch (e) { /* 换下一篇 */ }
    }
  }
  return null;
}


/* 空壳页/错误页的识别：这些文字出现说明拿到的是「页面骨架」或者拦截页，不能当正文 */
const JUNK_RE = /(参数错误|请升级客户端|去验证|环境异常|开启JavaScript|访问过于频繁|页面不存在|内容不存在|该内容已被删除|404 Not Found)/;

function chineseRatio(t) {
  const cn = (String(t).match(/[\u4e00-\u9fa5]/g) || []).length;
  return cn / Math.max(1, String(t).length);
}

/* 一段文字能不能当素材用：够长、主体是中文、不是拦截页 */
function usable(t, min) {
  const x = String(t || '').trim();
  if (x.length < (min || 120)) return false;
  if (JUNK_RE.test(x.slice(0, 240))) return false;
  if (chineseRatio(x) < 0.25) return false;
  return true;
}

/* 从微博各种形态的链接里取出这条微博的 id / bid */
function weiboIdOf(u) {
  const s = String(u || '');
  let m = s.match(/m\.weibo\.cn\/(?:detail|status)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  m = s.match(/weibo\.(?:com|cn)\/detail\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  m = s.match(/weibo\.(?:com|cn)\/\d+\/([A-Za-z0-9]{6,})/);
  if (m) return m[1];
  return '';
}

/* 单条微博：m.weibo.cn 的 statuses/show 直接给原文，不需要登录 */
/* 长微博：正文只有一半，剩下在「全文」后面。statuses/extend 才给完整版。 */
async function weiboLong(id, body) {
  try {
    const e = await wbJson('/statuses/extend?id=' + encodeURIComponent(id));
    const d = e && e.data;
    const full = d && (d.longTextContent || (d.longText && d.longText.longContent) || '');
    const t = tidyText(stripTags(String(full || '')));
    /* 只有确实更长才用，别把被截断的版本当成全文 */
    if (t && t.length > String(body || '').length + 20) return t;
  } catch (e) { /* 拿不到就用原来的 */ }
  return '';
}

async function weiboStatus(id) {
  const j = await wbJson('/statuses/show?id=' + encodeURIComponent(id));
  const d = j && j.data;
  if (!d || !d.text) return null;
  let body = tidyText(stripTags(String(d.text)));
  if (!body || body.length < 6) return null;
  if (d.isLongText && /…全文|...全文/.test(body)) {
    const full = await weiboLong(id, body);
    if (full) body = full;
  }
  body = body.replace(/…全文$|...全文$/, '').trim();
  const who = (d.user && d.user.screen_name) || '';
  let text = (who ? who + '：' : '') + body;
  const rt = d.retweeted_status;
  if (rt && rt.text) {
    const sub = tidyText(stripTags(String(rt.text)));
    if (sub) text += '\n\n// 转发自 ' + ((rt.user && rt.user.screen_name) || '') + '：' + sub;
  }
  if (!usable(text, 20)) return null;
  const pics = [];
  for (const p of (d.pics || [])) {
    const u = (p && (p.large && p.large.url || p.url)) || '';
    if (u) pics.push(u.replace(/^http:/, 'https:'));
  }
  return {
    title: body.slice(0, 40),
    text: text.slice(0, 12000),
    chars: text.length,
    via: 'weibo',
    note: '这是这条微博的原文',
    images: pics,
    author: who,
    related: { url: 'https://m.weibo.cn/detail/' + id, title: '原微博' }
  };
}

/* 话题下的博文清单：二级页面用。每条都能单独解析，不再把几条半截内容拼一起。 */
async function weiboPostList(title, limit) {
  const t = String(title || '').replace(/^#+|#+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const cid = '100103type=1&t=10&q=#' + t + '#';
  const j = await wbJson('/api/container/getIndex?containerid=' + encodeURIComponent(cid) + '&page_type=searchall');
  const out = [];
  const seen = new Set();
  for (const c of (j.data && j.data.cards) || []) {
    const mb = c && c.card_type === 9 && c.mblog;
    if (!mb) continue;
    const rawTxt = tidyText(stripTags(String(mb.text || '')));
    let txt = rawTxt.replace(/…全文$|...全文$/, '').trim();
    if (txt.length < 12 || seen.has(txt.slice(0, 24))) continue;
    seen.add(txt.slice(0, 24));
    /* 搜索卡片里 isLongText 经常是空的，只能看结尾：没句号、带「全文」都算截断 */
    const cut = mb.isLongText || /…全文|...全文/.test(rawTxt) || !/[。！？…”』】)）!?]$/.test(txt);
    let long = false;
    if (cut && out.length < 6) {
      /* 先试 extend；还短就直接问单条接口，那条给的是完整原文 */
      let full = await weiboLong(mb.id, txt);
      if (!full) {
        try {
          const st = await weiboStatus(mb.id);
          if (st && st.text.length > txt.length + 10) {
            full = st.text.replace(/^[^：]{1,20}：/, '');
          }
        } catch (e) { /* 用原来的 */ }
      }
      if (full && full.length > txt.length) { txt = full; long = true; }
    }
    const pics = [];
    for (const p of (mb.pics || [])) {
      const u = (p && (p.large && p.large.url || p.url)) || '';
      if (u) pics.push(u.replace(/^http:/, 'https:'));
    }
    out.push({
      id: String(mb.id || ''),
      url: 'https://m.weibo.cn/detail/' + mb.id,
      author: (mb.user && mb.user.screen_name) || '',
      text: txt.slice(0, 4000),
      chars: txt.length,
      long: long,
      images: pics.slice(0, 9),
      at: mb.created_at || '',
      reposts: (mb.reposts_count || 0),
      comments: (mb.comments_count || 0),
      likes: (mb.attitudes_count || 0),
      source: (mb.source || '').replace(/<[^>]+>/g, '')
    });
    if (out.length >= (limit || 12)) break;
  }
  return out;
}

/* 站点名尾巴去掉，剩下的才有资格当标题去搜同题报道 */
function cleanShellTitle(t, host) {
  let x = String(t || '').replace(/\s+/g, ' ').trim();
  x = x.replace(/\s*[-_|｜]\s*(微博|新浪微博|抖音|抖音搜索|快手|小红书|知乎|百度|百度搜索|今日头条|头条|哔哩哔哩|bilibili).*$/i, '');
  x = x.replace(/^(微博|抖音|快手|小红书|知乎|百度|今日头条)[\-_|｜:：\s]*/i, '');
  if (/^(微博|抖音|快手|小红书|知乎|百度|头条|哔哩哔哩)$/i.test(x)) return '';
  if (x.length < 4) return '';
  return x.slice(0, 60);
}

/* 页面骨架兜底：正文拿不到，但标题、摘要、小标题通常在 HTML 里躺着。
   这些是页面自己写的元信息，属于真实内容，不是编的。 */
function digestOf(html) {
  const src = String(html || '');
  const out = extract(src);
  let title = (out && out.title) || '';
  if (!title) {
    const mt = src.match(/<title[^>]*>([\s\S]{1,120}?)<\/title>/i);
    if (mt) title = tidyText(stripTags(mt[1]));
  }
  let desc = '';
  const pats = [
    /<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*content=["']([^"']{10,400})["']/i,
    /<meta[^>]+content=["']([^"']{10,400})["'][^>]*(?:name|property)=["'](?:description|og:description|twitter:description)["']/i
  ];
  for (const re of pats) {
    const m = src.match(re);
    if (m) { desc = tidyText(stripTags(m[1])); break; }
  }
  const heads = [];
  const hre = /<h[12][^>]*>([\s\S]{2,80}?)<\/h[12]>/gi;
  let h;
  while ((h = hre.exec(src)) && heads.length < 8) {
    const t = tidyText(stripTags(h[1]));
    if (t && t.length >= 4 && t.length <= 50 && heads.indexOf(t) < 0) heads.push(t);
  }
  const body = (out && out.text && out.text.length > 40) ? out.text : '';
  const text = tidyText([desc || body].concat(heads).join('\n')).slice(0, 4000);
  return { title, desc, heads, text, chars: text.length };
}


/* ---------------- 平台专项：把页面自带的数据挖出来 ----------------
   小红书 / 抖音 / 小蜜蜂 / B 站这些站点的正文不在 <p> 里，而是塞在
   __INITIAL_STATE__ / _ROUTER_DATA 这类内嵌 JSON 中。通用正文抽取只能
   拿到空壳，于是这里按平台把 JSON 里的标题、正文、图片、视频文案取出来。 */

const DEAD_TITLE_RE = /(内容不存在|已被删除|内容已删除|笔记不存在|作品不存在|视频不存在|页面不存在|内容已下架|该内容已被发布者删除|内容无法查看|文章已删除)/;

/* 死链页：标题就是「内容不存在或已被删除」，正文只有一句提示。
   必须单独识别，否则会被当成「正文太短」，然后拿这个标题去搜同题报道。 */
function deadPage(html) {
  const h = String(html || '');
  const title = (h.match(/<title[^>]*>([\s\S]{0,80}?)<\/title>/i) || [])[1] || '';
  if (DEAD_TITLE_RE.test(title)) return title.trim();
  const body = stripTags(h.replace(/<script[\s\S]*?<\/script>/gi, ' ')).slice(0, 400);
  if (body.length < 260 && DEAD_TITLE_RE.test(body)) return title.trim() || '内容不存在或已被删除';
  return '';
}

function walkJson(v, fn, depth) {
  if (depth > 9 || !v || typeof v !== 'object') return null;
  let hit = null;
  try { hit = fn(v); } catch (e) { hit = null; }
  if (hit) return hit;
  const kids = Array.isArray(v) ? v : Object.keys(v).map((k) => v[k]);
  for (const x of kids) {
    const r = walkJson(x, fn, depth + 1);
    if (r) return r;
  }
  return null;
}

/* 页面里内嵌的 JSON：常见四种写法，能解析几个算几个 */
function embedJson(html) {
  const h = String(html || '');
  const out = [];
  const pats = [
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /window\.__DATA__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i
  ];
  for (const re of pats) {
    const m = h.match(re);
    if (!m) continue;
    let s = m[1].trim();
    /* XHS 的 state 里有裸 undefined，JSON.parse 会直接挂 */
    s = s.replace(/([:,\[])\s*undefined\s*([,}\]])/g, '$1null$2');
    try { out.push(JSON.parse(s)); } catch (e) { /* 跳过写坏的块 */ }
  }
  /* JSON-LD 里的 articleBody 也能当正文 */
  for (const m of h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      (Array.isArray(j) ? j : [j]).forEach((x) => {
        if (x && typeof x === 'object') out.push(x);
      });
    } catch (e) { /* ignore */ }
  }
  return out;
}

function pickStr(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    for (const x of v) { const s = pickStr(x); if (s) return s; }
  }
  if (v && typeof v === 'object') {
    for (const k of ['urlDefault', 'urlPre', 'url', 'masterUrl', 'src', 'originUrl']) {
      if (typeof v[k] === 'string' && v[k]) return v[k];
    }
    if (Array.isArray(v.infoList)) return pickStr(v.infoList);
  }
  return '';
}

/* 从内嵌 JSON 里找「一篇笔记/一条视频」：正文 + 图集 + 视频文案 */
function richFromJson(html) {
  const blobs = embedJson(html);
  if (!blobs.length) return null;
  let best = null;
  for (const b of blobs) {
    const note = walkJson(b, (o) => {
      if (Array.isArray(o) || !o || typeof o !== 'object') return null;
      const desc = typeof o.desc === 'string' ? o.desc : (typeof o.content === 'string' ? o.content : '');
      const title = typeof o.title === 'string' ? o.title : '';
      const body = typeof o.articleBody === 'string' ? o.articleBody : '';
      if (body && body.length > 80) return { title, text: body, images: [] };
      if (desc.length < 40 && !(title && desc)) return null;
      if (!/imageList|images|pics|video|cover|noteCard/i.test(Object.keys(o).join(','))) return null;
      const imgs = [];
      const pushImg = (v) => { const u = pickStr(v); if (u && imgs.indexOf(u) < 0) imgs.push(u); };
      if (Array.isArray(o.imageList)) o.imageList.forEach(pushImg);
      if (Array.isArray(o.images)) o.images.forEach(pushImg);
      if (Array.isArray(o.pics)) o.pics.forEach(pushImg);
      if (o.video && Array.isArray(o.video.urlList)) o.video.urlList.forEach(pushImg);
      return { title: title.slice(0, 100), text: (title ? title + '\n\n' : '') + desc, images: imgs };
    }, 0);
    if (note && (!best || note.text.length > best.text.length)) best = note;
  }
  return best;
}

/* 视频文案：抖音 / 快手的 desc、B 站的简介，以及能拿到的字幕 */
function videoMetaOf(html) {
  const blobs = embedJson(String(html || ''));
  let desc = '', cover = '', author = '';
  for (const b of blobs) {
    const v = walkJson(b, (o) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      const isVideo = o.video && (o.video.play_addr || o.video.playAddr || o.video.bit_rate || o.video.duration);
      if (!isVideo) return null;
      return o;
    }, 0);
    if (!v) continue;
    if (typeof v.desc === 'string' && v.desc.length > desc.length) desc = v.desc;
    if (v.video) {
      const c = pickStr(v.video.cover) || pickStr(v.video.origin_cover) || pickStr(v.video.dynamic_cover);
      if (c) cover = c;
    }
    if (v.author && (v.author.nickname || v.author.name)) author = v.author.nickname || v.author.name;
    if (desc) break;
  }
  if (!desc) {
    const m = String(html).match(/"desc"\s*:\s*"((?:[^"\\]|\\.){20,})"/);
    if (m) desc = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  return { desc: tidyText(desc).slice(0, 2000), cover, author };
}

/* 字幕：优先找 vtt / srt / 字幕 json 的地址，能把口播变成正文 */
function subtitleUrlOf(html) {
  const h = String(html || '');
  const cands = [];
  const re = /https?:\\?\/\\?\/[^"'\s\\]+?(?:\.vtt|\.srt|subtitle[^"'\s\\]*\.json|caption[^"'\s\\]*\.json)[^"'\s\\]*/gi;
  let m;
  while ((m = re.exec(h)) && cands.length < 6) {
    cands.push(m[0].replace(/\\\//g, '/'));
  }
  return cands[0] || '';
}

function vttToText(raw) {
  const s = String(raw || '');
  const t = s.replace(/\r/g, '').replace(/^WEBVTT.*$/m, '');
  if (/^\s*\{/.test(t)) {
    try {
      const j = JSON.parse(t);
      const arr = (j.body || j.subtitles || j.data || []);
      const lines = arr.map((x) => (x && (x.content || x.text)) || '').filter(Boolean);
      if (lines.length) return tidyText(lines.join('\n'));
    } catch (e) { /* 当普通文本处理 */ }
  }
  const lines = t.split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !/^\d+$/.test(x) && x.indexOf('-->') < 0 && !/^(NOTE|STYLE|REGION)\b/.test(x));
  const out = [];
  for (const l of lines) {
    const clean = tidyText(stripTags(l));
    if (!clean) continue;
    if (out.length && out[out.length - 1] === clean) continue;
    out.push(clean);
  }
  return tidyText(out.join('\n'));
}

async function videoText(html) {
  const meta = videoMetaOf(html);
  let text = meta.desc || '';
  let via = '';
  const sub = subtitleUrlOf(html);
  if (sub) {
    try {
      const raw = await getTextUrl(sub, 8000);
      const t = vttToText(raw);
      if (t && t.length > 40 && t.length > text.length) {
        text = t;
        via = 'subtitle';
      }
    } catch (e) { /* 字幕拿不到就用文案 */ }
  }
  return { text, cover: meta.cover, author: meta.author, via };
}

async function getTextUrl(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA_MOBILE, Accept: '*/*', Referer: 'https://www.douyin.com/' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

/* 页面里的图：og / 内嵌 JSON / 正文 img，统一走一遍过滤 */
function imagesOf(html, target, extra) {
  let list = [];
  try {
    list = (metaOf(String(html), target).images || []).slice();
  } catch (e) { list = []; }
  (extra || []).forEach((u) => {
    const a = absUrl(u, target.origin + '/');
    if (a && list.indexOf(a) < 0) list.unshift(a);
  });
  return list.slice(0, 12);
}

async function parseUrl(url, hintTitle) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');

  const host = target.hostname;
  const isWx = /mp\.weixin\.qq\.com/.test(host);
  const isXhs = /(^|\.)(xiaohongshu\.com|xhslink\.com)$/i.test(host);
  const isMf = /(^|\.)mifengs\.com$/i.test(host);
  const isVideo = /(^|\.)(douyin\.com|iesdouyin\.com|kuaishou\.com|bilibili\.com|b23\.tv|youtube\.com|youtu\.be)$/i.test(host);
  const need = isWx ? 90 : 120;

  const cached = pageGet(url);
  if (cached) {
    const hit = extract(cached.html);
    if (hit.text.length >= need && usable(hit.text, need)) {
      hit.images = imagesOf(cached.html, target);
      return hit;
    }
  }

  const tries = [UA_MOBILE, UA_DESKTOP];
  let lastErr = '';
  let bestHtml = '';
  let deadHtml = '';
  for (const ua of tries) {
    try {
      /* 站点活着的话 1 秒内就回来了；6 秒还没响应，多半是抓不通，别把时间全耗在等它 */
      const html = await grabHtml(target, ua, isWx ? 8000 : 6000);
      pageSet(url, html);
      if (html && html.length > bestHtml.length) bestHtml = html;
      const dead = deadPage(html);
      if (dead) { deadHtml = html; lastErr = dead; continue; }
      if (/环境异常|去验证|该内容已被发布者删除|此内容因违规无法查看/.test(html) && !/id=["']js_content["']/.test(html)) {
        lastErr = '微信拦住了解析（文章要求微信内打开，或已被删除）';
        continue;
      }
      const out = extract(html);
      if (out.text.length >= need && usable(out.text, need)) {
        out.images = imagesOf(html, target);
        out.head = pickHead(out.images);
        return out;
      }
      if (JUNK_RE.test(out.text.slice(0, 120))) lastErr = isWx ? '这篇公众号文章打不开（链接可能已失效或被删除）' : '站点返回的是拦截页，不是正文';
      else lastErr = out.text.length ? ('这一页只返回了 ' + out.text.length + ' 字，凑不成稿') : '这一页没返回正文';
    } catch (e) {
      lastErr = e.name === 'AbortError' ? '抓取超时' : e.message;
    }
  }

  /* 死链就地判定：两个 UA 都拿到「内容不存在」页，再花七秒搜同题报道纯属浪费，
     而且前端 9 秒就超时了，用户只会看到「超时没响应」。 */
  if (deadHtml) {
    const err = new Error(isMf
      ? '这条小蜜蜂链接已经失效：内容被作者删除，或分享链接过期（分享链接带时效，过期就打不开）。在 App 里重新分享一次再粘，或长按正文复制后走「直接粘全文」。'
      : '这条链接已经失效：内容被删除或仅限 App 内打开。换一条，或把正文复制出来走「直接粘全文」。');
    err.code = 'DEAD';
    err.title = '';
    throw err;
  }

  /* 兜底阶段总共只给 11 秒：宁可早点告诉用户「取不到」，也不让人盯着转圈 */
  const deadline = Date.now() + 7000;

  /* 平台一：页面自带 JSON（小红书笔记、抖音视频、B 站简介、小蜜蜂正文都在里面）。
     这一步必须排在同题报道前面——它取到的是这篇内容本身，而不是别人写的同题稿。 */
  if (bestHtml) {
    const rich = richFromJson(bestHtml);
    if (rich && usable(rich.text, 60)) {
      return {
        title: rich.title || String(rich.text).split('\n')[0].slice(0, 40),
        text: rich.text.slice(0, 12000),
        chars: rich.text.length,
        via: isXhs ? 'xhs' : isMf ? 'mifengs' : 'embed',
        note: '正文取自页面自带的数据',
        images: imagesOf(bestHtml, target, rich.images),
        related: { url, title: rich.title || '' }
      };
    }
    /* 平台二：视频页。口播没法凭空转写，但有字幕就用字幕，没有就用作者写的文案。 */
    if (isVideo) {
      const vt = await videoText(bestHtml);
      const desc = tidyText(vt.text || '');
      /* 视频常常只有一句文案。有一句就交出去，让用户补画面细节，比直接报「解析失败」有用。 */
      if (desc.length >= 12) {
        return {
          title: desc.split('\n')[0].slice(0, 40),
          text: desc.slice(0, 12000),
          chars: desc.length,
          via: vt.via === 'subtitle' ? 'subtitle' : 'video',
          note: vt.via === 'subtitle'
            ? '这是视频字幕转出来的文字，口播内容基本完整'
            : '这是视频作者写的文案。视频里的口播没有字幕文件，服务器转写不了；如果只有一句话，改写前最好补两句你看到的画面，不然容易写空。',
          images: imagesOf(bestHtml, target, vt.cover ? [vt.cover] : []),
          video: true,
          related: { url, title: desc.split('\n')[0].slice(0, 40) }
        };
      }
    }
  }

  /* 兜底一：微博单条。m.weibo.cn/detail 是纯脚本页，直抓必 0 字，
     但 statuses/show 接口给的是这条微博的原文，最准。 */
  const wid = weiboIdOf(url);
  if (wid) {
    try {
      const st = await weiboStatus(wid);
      if (st) return st;
    } catch (e) { /* 继续往下 */ }
  }

  const dig = bestHtml ? digestOf(bestHtml) : null;
  let title = String(hintTitle || '').trim() || guessTitle(url);
  if (!title && dig && dig.title) title = cleanShellTitle(dig.title, host);

  /* 兜底二：微博话题页取话题下的真实博文 */
  if (title && Date.now() < deadline && /weibo\.(com|cn)$/i.test(host)) {
    try {
      const w = await weiboPosts(title);
      if (w) return w;
    } catch (e) { /* 继续往下 */ }
  }

  /* 兜底三：同题报道 */
  if (title && Date.now() < deadline) {
    try {
      const rel = await relatedParse(title, deadline);
      if (rel) return rel;
    } catch (e) { /* 继续往下 */ }
  }

  /* 兜底四：标题 + 摘要 + 小标题。宁可短，也不假装有正文。 */
  if (dig && usable(dig.text, 50)) {
    return {
      title: cleanShellTitle(dig.title, host) || dig.title,
      text: dig.text,
      chars: dig.text.length,
      via: 'digest',
      note: '这页正文由脚本渲染，这里是页面自带的标题与摘要',
      images: bestHtml ? imagesOf(bestHtml, target) : [],
      related: { url, title: cleanShellTitle(dig.title, host) || dig.title }
    };
  }

  const err = new Error(lastErr || '解析失败');
  err.code = 'NO_TEXT';
  err.title = title;
  throw err;
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
      /* 站点活着的话 1 秒内就回来了；6 秒还没响应，多半是抓不通，别把时间全耗在等它 */
      const html = await grabHtml(target, ua, isWx ? 8000 : 6000);
      pageSet(url, html);
      if (!/环境异常|去验证/.test(html) || /id=["']js_content["']/.test(html)) return metaOf(html, target);
      lastErr = '微信拦住了解析';
    } catch (e) {
      lastErr = e.name === 'AbortError' ? '抓取超时' : e.message;
    }
  }
  throw new Error(lastErr || '取不到页面信息');
}

/* ---------------- 榜单封面：微博/抖音/头条这类「只有搜索页」的源 ----------------
   热搜条目本身没有文章页，图片在榜单接口里：头条 hot-board 的 Image、
   抖音热搜的 word_cover、B站排行榜的 pic。按标题精确匹配，宁可没有也不乱配。 */
const coverCache = new Map();
const COVER_TTL = 10 * 60 * 1000;

async function getJson(url, referer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA_DESKTOP,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: referer || url
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* 微博：热搜条目本身没有配图，但话题搜索结果里博主发的博文带真实图片。
   m.weibo.cn 要求访客 cookie（passport 的 genvisitor 流程），这里自己取一张并缓存 30 分钟。 */
let wbVisitor = { ck: '', at: 0 };
const wbCache = new Map();

async function wbCookie(force) {
  if (!force && wbVisitor.ck && Date.now() - wbVisitor.at < 30 * 60 * 1000) return wbVisitor.ck;
  const H = { 'User-Agent': UA_MOBILE, Referer: 'https://m.weibo.cn/' };
  /* 注意域名：m.weibo.cn 认的是 .weibo.cn 的访客票，走 visitor.passport.weibo.cn 才对，
     用 passport.weibo.com 签出来的票会被 302 到登录页 */
  const g = await fetch('https://visitor.passport.weibo.cn/visitor/genvisitor2', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      cb: 'visitor_gray_callback',
      ver: '20250916',
      request_id: 'd410864507027615f10f72d7165434e4',
      tid: '',
      from: 'weibo',
      webdriver: 'false',
      rid: String(Date.now()),
      return_url: 'https://m.weibo.cn/'
    }).toString()
  });
  const gt = await g.text();
  const tid = (gt.match(/"tid":"([^"]+)"/) || [])[1] || '';
  if (!tid) throw new Error('微博访客凭证获取失败');
  const inc = await fetch('https://visitor.passport.weibo.cn/visitor/visitor?a=incarnate&t=' +
    encodeURIComponent(tid) + '&w=2&c=095&gc=&cb=cross_domain&from=weibo&_rand=0.5', { headers: H });
  const it = await inc.text();
  const sub = (it.match(/"sub":"([^"]+)"/) || [])[1] || '';
  const subp = (it.match(/"subp":"([^"]+)"/) || [])[1] || '';
  if (!sub) throw new Error('微博访客凭证换取失败');
  const ck = 'SUB=' + sub + (subp ? '; SUBP=' + subp : '');
  wbVisitor = { ck, at: Date.now() };
  return ck;
}

async function wbJson(path) {
  let last = '';
  for (let i = 0; i < 2; i += 1) {
    const ck = await wbCookie(i > 0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch('https://m.weibo.cn' + path, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': UA_MOBILE,
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://m.weibo.cn/',
          Cookie: ck
        }
      });
      if (res.status === 200) return await res.json();
      last = 'HTTP ' + res.status;
    } catch (e) {
      last = e.message;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(last || '微博接口不可用');
}

/* 取该话题下第一条带图的博文；头像、表情、榜单角标这类小图直接跳过 */
async function weiboCover(title) {
  const t = String(title || '').replace(/^#+|#+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false };
  const hit = wbCache.get(t);
  if (hit && Date.now() - hit.at < COVER_TTL) return hit.v;
  let out = { ok: false };
  try {
    const cid = '100103type=1&t=10&q=#' + t + '#';
    const j = await wbJson('/api/container/getIndex?containerid=' + encodeURIComponent(cid) + '&page_type=searchall');
    const cands = [];
    for (const c of (j.data && j.data.cards) || []) {
      const mb = c && c.card_type === 9 && c.mblog;
      if (!mb) continue;
      const add = (u, w, h) => {
        const s = String(u || '').replace(/^http:/, 'https:');
        if (s) cands.push({ u: s, w: Number(w) || 0, h: Number(h) || 0 });
      };
      for (const p of mb.pics || []) {
        const lg = p.large || {};
        const geo = lg.geo || p.geo || {};
        add(lg.url || p.url, geo.width, geo.height);
      }
      if (mb.page_info && mb.page_info.page_pic && mb.page_info.page_pic.url) {
        const pp = mb.page_info.page_pic;
        add(String(pp.url).replace('/orj480/', '/large/'), pp.width, pp.height);
      }
      if (!(mb.pics || []).length && mb.original_pic) add(mb.original_pic, 0, 0);
      if (cands.length >= 30) break;
    }
    /* 横图优先：竖版截图裁成 16:9 会很难看，只有实在没有横图才用它 */
    let best = null;
    let bestScore = 0;
    for (const x of cands) {
      const ratio = x.h ? x.w / x.h : 1.6;
      let sc = 1;
      if (x.w >= 480 && x.h >= 260) sc = 2;
      if (x.w >= 640 && x.h >= 360 && ratio >= 1.1 && ratio <= 2.4) sc = 3;
      if (sc > bestScore) { bestScore = sc; best = x; }
    }
    if (best) out = { ok: true, head: best.u, proxy: true, matched: t, from: 'weibo' };
  } catch (e) { /* 微博接口拿不到就当没有，绝不编图 */ }
  wbCache.set(t, { at: Date.now(), v: out });
  return out;
}

async function coverList(src) {
  const hit = coverCache.get(src);
  if (hit && Date.now() - hit.at < COVER_TTL) return hit.list;
  let list = [];
  try {
    if (src === 'toutiao') {
      const j = await getJson('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc');
      list = (j.data || []).map((x) => ({
        t: x.Title,
        u: (x.Image && (x.Image.url || (x.Image.url_list && x.Image.url_list[0] && x.Image.url_list[0].url))) || ''
      }));
    } else if (src === 'douyin') {
      const j = await getJson('https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1', 'https://www.douyin.com/');
      const wl = (j.data && j.data.word_list) || j.word_list || [];
      list = wl.map((x) => ({
        t: x.word,
        u: (x.word_cover && ((x.word_cover.url_list && x.word_cover.url_list[0]) || x.word_cover.url)) || ''
      }));
    } else if (src === 'bilibili') {
      const j = await getJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', 'https://www.bilibili.com/');
      list = ((j.data && j.data.list) || []).map((x) => ({
        t: x.title,
        u: String(x.pic || '').replace(/^http:/, 'https:')
      }));
    }
  } catch (e) { /* 拿不到就当这个源没有封面 */ }
  list = list.filter((x) => x.u && x.t);
  coverCache.set(src, { at: Date.now(), list });
  return list;
}

async function coverFor(src, title) {
  const k = imgKey(title);
  if (!k) return { ok: false };
  /* 微博：走话题搜索，拿博主博文里的真实配图 */
  if (src === 'weibo') {
    const w = await weiboCover(title);
    if (w.ok) return w;
  }
  /* 其余榜单先在官方榜单接口里找；找不到再跨榜找「标题完全一致」的那条 */
  const chain = [src, 'toutiao', 'douyin'].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const s of chain) {
    const list = await coverList(s);
    if (!list.length) continue;
    let hit = list.find((x) => imgKey(x.t) === k);
    if (!hit && s === src) {
      hit = list.find((x) => {
        const k2 = imgKey(x.t);
        return k2 && ((k.length >= 8 && k2.indexOf(k) >= 0) || (k2.length >= 8 && k.indexOf(k2) >= 0));
      });
    }
    if (hit) return { ok: true, head: hit.u.replace(/&amp;/g, '&'), matched: hit.t, from: s };
  }
  if (src === 'zhihu') {
    const w = await weiboCover(title);
    if (w.ok) return w;
  }
  return { ok: false };
}

/* ---------------- 图床代理 ----------------
   新浪图床对「无 referer 的浏览器请求」返回 403，只认真 referer。
   浏览器侧改不了 img 的 Referer，于是图片经这里转发一次。 */
const IMG_HOSTS = /(^|\.)(sinaimg\.cn|weibocdn\.com|sina\.com\.cn)$/i;
const imgCache = new Map();

async function proxyImage(target) {
  let t;
  try {
    t = new URL(target);
  } catch (e) {
    return { code: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'bad url' };
  }
  if (!/^https?:$/.test(t.protocol) || !IMG_HOSTS.test(t.hostname)) {
    return { code: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'forbidden host' };
  }
  const key = t.href;
  const hit = imgCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) {
    return { code: 200, headers: hit.headers, body: hit.body };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(key, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA_DESKTOP,
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        Referer: /weibocdn/.test(t.hostname) ? 'https://weibo.com/' : 'https://weibo.com/'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const type = r.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error('不是图片');
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error('图片过大或为空');
    const headers = {
      'Content-Type': type,
      'Content-Length': String(buf.length),
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    };
    /* 只缓存 1.5MB 以内的图，最多 80 张，别把进程内存吃满 */
    if (buf.length <= 1.5 * 1024 * 1024) {
      if (imgCache.size > 80) imgCache.clear();
      imgCache.set(key, { at: Date.now(), headers, body: buf });
    }
    return { code: 200, headers, body: buf };
  } catch (e) {
    return { code: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'upstream ' + e.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 服务 ---------------- */

/* url= 明文；u= base64url（个别网关会拦查询串里的 http:// 字面量，留一条备用通道） */
function readTarget(u) {
  const plain = u.searchParams.get('url');
  if (plain) return plain;
  const b = u.searchParams.get('u') || '';
  if (!b) return '';
  try {
    return Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

/* ---------------- 模型接口中转 ----------------
   NVIDIA 等厂商不给浏览器发 CORS 头，页面直连一定失败；智谱 / 百炼这类
   地址规则又各不相同。这里按用户自己的 Key 代发一次，只放行模型接口的固定路径，
   不碰内网地址，避免被当成任意代理。 */
const LLM_PATHS = ['/models', '/chat/completions', '/images/generations', '/embeddings', '/responses', '/completions'];

function isPrivateHost(h) {
  const s = String(h || '').toLowerCase();
  if (!s) return true;
  if (/^(localhost|0\.0\.0\.0|\[?::1\]?)$/.test(s) || /\.local$|\.internal$/.test(s)) return true;
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const llmHits = new Map();
function llmAllowed(ip) {
  const now = Date.now();
  const rec = llmHits.get(ip) || { n: 0, at: now };
  if (now - rec.at > 60000) { rec.n = 0; rec.at = now; }
  rec.n += 1;
  llmHits.set(ip, rec);
  if (llmHits.size > 2000) llmHits.clear();
  return rec.n <= 300;
}

async function relayLLM(req, res, ip) {
  if (!llmAllowed(ip)) return send(res, 200, { ok: false, error: '请求太频繁，歇一分钟再试' });
  let p;
  try {
    p = JSON.parse((await readBody(req, 2 * 1024 * 1024)) || '{}');
  } catch (e) {
    return send(res, 200, { ok: false, error: '请求格式不对：' + e.message });
  }
  let base;
  try {
    base = new URL(String(p.base || ''));
  } catch (e) {
    return send(res, 200, { ok: false, error: 'Base URL 不是合法地址' });
  }
  if (!/^https?:$/.test(base.protocol)) return send(res, 200, { ok: false, error: '只支持 http/https' });
  if (isPrivateHost(base.hostname)) return send(res, 200, { ok: false, error: '不允许访问内网地址' });
  const pth = String(p.path || '');
  if (LLM_PATHS.indexOf(pth) < 0) return send(res, 200, { ok: false, error: '这个接口不支持中转' });

  const target = base.origin + base.pathname.replace(/\/+$/, '') + pth;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), pth === '/images/generations' ? 150000 : 100000);
  try {
    const init = {
      method: p.method === 'GET' ? 'GET' : 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    };
    if (p.key) init.headers.Authorization = 'Bearer ' + p.key;
    if (init.method === 'POST') init.body = JSON.stringify(p.body || {});
    const r = await fetch(target, init);
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 2000) }; }
    return send(res, 200, { ok: true, status: r.status, data });
  } catch (e) {
    return send(res, 200, { ok: false, error: e.name === 'AbortError' ? '上游超时' : (e.message || '转发失败') });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 网页检索（内容创作查资料） ---------------- */

const SEARCH_TTL = 8 * 60 * 1000;
const searchCache = new Map();

function decodeCk(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (!/bing\.com$/i.test(u.hostname)) return href;
    if (!/^\/ck\/a/.test(u.pathname)) return href;
    const b = u.searchParams.get('u') || '';
    if (!b.startsWith('a1')) return href;
    let s = b.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (e) {
    return href;
  }
}

function bingItems(html) {
  const out = [];
  const blocks = String(html).match(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/g) || [];
  for (const b of blocks) {
    const h2 = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (!h2) continue;
    const title = stripTags(h2[1]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const a = h2[1].match(/<a[^>]+href="([^"]+)"/i) || b.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const url = a ? decodeCk(decode(a[1])) : '';
    const citeM = b.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    const site = citeM ? stripTags(citeM[1]).replace(/\s+/g, ' ').trim().split(/[›>]/)[0].trim() : '';
    const rest = b.replace(h2[0], ' ').replace(/<cite[\s\S]*?<\/cite>/i, ' ');
    const snip = stripTags(rest)
      .replace(/\s+/g, ' ')
      .replace(/^(阅读更多|网页快照|·)+/g, '')
      .trim();
    const dm = b.match(/(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|(\d+)\s*(小时|分钟|天)前)/);
    out.push({
      title: title.slice(0, 160),
      url: /^https?:\/\//i.test(url) ? url : '',
      site: site.slice(0, 60),
      snippet: snip.slice(0, 320),
      date: dm ? dm[0] : ''
    });
  }
  return out;
}

function rssItems(xml) {
  const out = [];
  const blocks = String(xml).match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
      return m ? decode(m[1]).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : '';
    };
    const title = pick('title');
    if (!title) continue;
    const url = pick('link');
    let site = '';
    try { site = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { site = ''; }
    out.push({ title, url, site, snippet: pick('description').slice(0, 320), date: pick('pubDate') });
  }
  return out;
}

/* 搜狗微信：中文长尾词比必应准，且直接命中公众号原文 */
function sogouWxItems(html) {
  const out = [];
  const blocks = String(html).match(/<li id="sogou_vr_11002601_box_\d+"[\s\S]*?<\/li>/g) || [];
  for (const b of blocks) {
    const t = b.match(/<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!t) continue;
    const title = stripTags(t[2]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    let url = decode(t[1]).replace(/&amp;/g, '&');
    if (url.indexOf('http') !== 0) url = 'https://weixin.sogou.com' + url;
    const sn = b.match(/<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = sn ? stripTags(sn[1]).replace(/\s+/g, ' ').trim() : '';
    const acc = b.match(/<a[^>]*class="account"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({
      title: title.slice(0, 120),
      url,
      site: acc ? stripTags(acc[1]).trim() : '公众号',
      snippet: snippet.slice(0, 320),
      date: ''
    });
  }
  return out;
}

async function getPage(target, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 13000);
  try {
    const r = await fetch(target.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Referer: target.origin + '/'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(q, opts) {
  const query = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!query) throw new Error('缺少检索词');
  const n = Math.min(20, Math.max(5, Number(opts && opts.n) || 10));
  const fresh = String((opts && opts.fresh) || '');
  const ck = query + '|' + n + '|' + fresh;
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.data;

  const filters = { d: 'ex1:"ez1"', w: 'ex1:"ez2"', m: 'ex1:"ez3"', y: 'ex1:"ez4"' }[fresh] || '';
  const base = new URL('https://cn.bing.com/search');
  base.searchParams.set('q', query);
  base.searchParams.set('count', String(n));
  base.searchParams.set('setlang', 'zh-Hans');
  base.searchParams.set('ensearch', '0');
  if (filters) base.searchParams.set('filters', filters);

  let items = [];
  let engine = '';
  try {
    items = bingItems(await getPage(base, UA_DESKTOP));
    if (items.length) engine = 'bing';
  } catch (e) { /* 换 RSS */ }

  if (!items.length) {
    try {
      const ru = new URL('https://www.bing.com/search');
      ru.searchParams.set('q', query);
      ru.searchParams.set('format', 'rss');
      ru.searchParams.set('count', String(n));
      items = rssItems(await getPage(ru, UA_DESKTOP));
      if (items.length) engine = 'bing-rss';
    } catch (e) { /* 放弃 */ }
  }

  /* 中文长尾词：必应经常给"小/两"这类单字结果，补一路公众号搜索 */
  if (/[\u4e00-\u9fa5]/.test(query)) {
    try {
      const su = new URL('https://weixin.sogou.com/weixin');
      su.searchParams.set('type', '2');
      su.searchParams.set('query', query);
      const wx = sogouWxItems(await getPage(su, UA_MOBILE));
      if (wx.length) {
        items = items.concat(wx);
        engine = engine ? engine + '+sogou' : 'sogou';
      }
    } catch (e) { /* 忽略 */ }
  }

  /* 按「检索词二元组覆盖率」重排：必应对冷门中文词会返回单字结果，
     这些结果和 query 几乎不重合，排到最后就不会挤掉真正相关的条目。 */
  const gm = (function () {
    const s = String(query).replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  })();
  const rel = (it) => {
    if (!gm.size) return 0;
    const t = String(it.title || '') + ' ' + String(it.snippet || '');
    let n = 0;
    gm.forEach((g) => { if (t.indexOf(g) >= 0) n += 1; });
    return n / gm.size;
  };
  items.sort((a, b) => rel(b) - rel(a));

  const seen = new Set();
  items = items.filter((it) => {
    const k = (it.url || it.title).replace(/[#?].*$/, '');
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, n);

  const data = { q: query, engine, items, at: Date.now() };
  if (items.length) searchCache.set(ck, { at: Date.now(), data });
  return data;
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
      if (u.pathname === '/api/health') return send(res, 200, { ok: true, version: '3.5.0', runtime: 'node' });
      if (u.pathname === '/api/llm') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'POST, OPTIONS'
          });
          return res.end();
        }
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只支持 POST' });
        const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
        return relayLLM(req, res, ip);
      }
      if (u.pathname === '/api/hot') {
        const d = await getHot(u.searchParams.get('src') || 'all');
        return send(res, 200, d);
      }
      /* 网页检索：内容创作查最新资料用 */
      if (u.pathname === '/api/search') {
        try {
          const out = await searchWeb(u.searchParams.get('q') || '', {
            n: Number(u.searchParams.get('n') || 10),
            fresh: u.searchParams.get('fresh') || ''
          });
          return send(res, 200, Object.assign({ ok: out.items.length > 0 }, out));
        } catch (e) {
          return send(res, 200, { ok: false, error: e.message || '搜索失败', items: [] });
        }
      }
      if (u.pathname === '/api/parse') {
        const url = readTarget(u);
        if (!url) return send(res, 400, { ok: false, error: '缺少 url' });
        const title = u.searchParams.get('title') || '';
        /* 业务失败也回 200：让前端能看到「正文只有 0 字 / HTTP 403」这种真实原因，
           而不是被当成网关 502 显示「服务离线」。5xx 只留给真正的服务异常。 */
        try {
          const out = await parseUrl(url, title);
          return send(res, 200, {
            ok: true,
            title: out.title,
            text: out.text.slice(0, 12000),
            chars: out.text.length,
            via: out.via || 'direct',
            note: out.note || '',
            images: out.images || [],
            video: !!out.video,
            related: out.related || null
          });
        } catch (e) {
          return send(res, 200, {
            ok: false,
            error: e.message || '解析失败',
            code: e.code || 'PARSE_FAIL',
            title: e.title || title || ''
          });
        }
      }
      if (u.pathname === '/api/posts') {
        const src = u.searchParams.get('src') || 'weibo';
        const title = u.searchParams.get('title') || '';
        if (!title) return send(res, 400, { ok: false, error: '缺少 title' });
        if (src !== 'weibo') return send(res, 200, { ok: false, code: 'NO_LIST', error: '这个源没有公开的帖子列表' });
        try {
          const items = await weiboPostList(title, Number(u.searchParams.get('n') || 12));
          return send(res, 200, { ok: true, src, title, items, total: items.length });
        } catch (e) {
          return send(res, 200, { ok: false, code: 'POSTS_FAIL', error: e.message || '取不到话题下的帖子' });
        }
      }
      if (u.pathname === '/api/meta') {
        const url = readTarget(u);
        if (!url) return send(res, 400, { ok: false, error: '缺少 url' });
        try {
          const meta = await metaFor(url);
          return send(res, 200, Object.assign({ ok: true }, meta));
        } catch (e) {
          return send(res, 200, { ok: false, error: e.message || '取不到页面信息', code: 'META_FAIL' });
        }
      }
      if (u.pathname === '/api/img') {
        const target = u.searchParams.get('u') || '';
        const hit = await proxyImage(target);
        res.writeHead(hit.code, hit.headers);
        return res.end(hit.body);
      }
      if (u.pathname === '/api/cover') {
        const src = u.searchParams.get('src') || '';
        const title = u.searchParams.get('title') || '';
        if (!src || !title) return send(res, 400, { ok: false, error: '缺少参数' });
        const out = await coverFor(src, title);
        return send(res, 200, out);
      }
      return send(res, 404, { ok: false, error: '接口不存在' });
    } catch (e) {
      console.error('[api]', u.pathname, e && e.message);
      return send(res, 500, { ok: false, error: e.message || '服务异常', code: 'INTERNAL' });
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
