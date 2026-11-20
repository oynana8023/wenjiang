/**
 * 文匠 AI · 解析服务（Cloudflare Worker 版）
 * ------------------------------------------------------------
 * 一个文件、零依赖，免费额度 10 万次/天，地址永久稳定。
 *
 * 接口
 *   GET /                 说明页
 *   GET /api/health       { ok, version, runtime }
 *   GET /api/parse?url=   抓取网页正文 → { ok, title, text, chars }
 *
 * 可选环境变量（Worker → Settings → Variables）
 *   PARSE_KEY   设了就要求 &key=xxx，防止别人拿去当免费代理
 *
 * 部署方式见 README「三分钟上线自己的解析服务」。
 */

const VERSION = '3.1.0';
const MAX_BYTES = 12 * 1024 * 1024;
const TEXT_LIMIT = 12000;
const TIMEOUT = 13000;

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/* ---------------- 正文抽取 ---------------- */

const NOISE =
  /^(登录|注册|下载客户端|扫码|打开APP|广告|版权所有|免责声明|责任编辑|点击查看|上一篇|下一篇|相关阅读|热门推荐|分享到|阅读原文|收藏|播放列表|正在播放|热播榜|视频加载中)/;

function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(html) {
  return decode(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|h\d|li|blockquote|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

function tidyText(t) {
  return String(t)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*$/g, '') // 截断后残留的半截标签
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '<' && !/^<\/?[a-zA-Z][^>]*>?$/.test(l) && !NOISE.test(l.slice(0, 24)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 正文容器的开头标记，按优先级排列；公众号 #js_content 永远排第一 */
const BLOCK_MARKERS = [
  /<div[^>]*id=["']js_content["'][^>]*>/i,
  /<(?:div|section)[^>]*id=["']paragraph["'][^>]*>/i,
  /<(?:div|section|article)[^>]*class=["'][^"']*(?:rich_media_content|post_content|article-content|artical-content|article_content|entry-content|content-detail|article-body|post-body|post-article|news-content|main-content)[^"']*["'][^>]*>/i,
  /<article[^>]*>/i,
  /<(?:div|section)[^>]*class=["'][^"']*(?:content|article|post)[^"']*["'][^>]*>/i
];

/* 正文结束的常见标记，切掉评论、推荐、版权尾巴 */
const CUT_TAIL =
  /(?:class|id)=["'][^"']*(?:comment|footer|related|recommend|sidebar|share-bar|statement)[^"']*["']|相关阅读|免责声明|责任编辑|转载请注明|本文来自|举报|版权声明/;

/* 从标记处向后取一大段，再按尾部标记截断。
   不能写成非贪婪 <div>...</div>，那样遇到嵌套 div 只取到几十个字（IT之家的问题就出在这里）。 */
function pickBlock(h) {
  for (const re of BLOCK_MARKERS) {
    const m = h.match(re);
    if (!m || m.index === undefined) continue;
    let seg = h.slice(m.index, m.index + 160000);
    const tail = seg.slice(600).search(CUT_TAIL);
    if (tail > 0) seg = seg.slice(0, 600 + tail);
    const text = tidyText(stripTags(seg));
    if (text.length >= 120) return text;
  }
  return '';
}

function extract(html) {
  const h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const title =
    (h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (h.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
    '';

  let text = pickBlock(h);
  if (text.length < 120) {
    const ps = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    const alt = tidyText(stripTags(ps.join('\n')));
    if (alt.length > text.length) text = alt;
  }
  if (text.length < 120) {
    // 最后兜底：整页去标签，去掉导航噪声后保留成段落
    const body = (h.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || h;
    const alt = tidyText(stripTags(body));
    if (alt.length > text.length) text = alt;
  }

  return { title: tidyText(stripTags(title)).slice(0, 120), text };
}

/* ---------------- 抓取 ---------------- */

const CACHE = new Map(); // 单实例内的小缓存，省掉重复抓取
const CACHE_TTL = 10 * 60 * 1000;

function cachedGet(k) {
  const v = CACHE.get(k);
  if (v && Date.now() - v.at < CACHE_TTL) return v.value;
  CACHE.delete(k);
  return null;
}

function cachedSet(k, value) {
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(k, { at: Date.now(), value });
}

function isPrivateHost(host) {
  if (!host) return true;
  if (/^(localhost|0\.0\.0\.0|\[::1\])$/i.test(host)) return true;
  if (/^(10|127)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/\.(local|internal|localhost)$/i.test(host)) return true;
  return false;
}

async function grab(target, ua) {
  const isWx = /(^|\.)mp\.weixin\.qq\.com$/i.test(target.hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(target.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Referer: isWx ? 'https://mp.weixin.qq.com/' : target.origin + '/',
        'Cache-Control': 'no-cache'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error('页面太大');
    const html = await res.text();
    return { html, type: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

function guessTitle(url) {
  try {
    const t = new URL(url);
    if (/weibo\.(com|cn)$/i.test(t.hostname)) {
      return String(t.searchParams.get('q') || '').replace(/^#+|#+$/g, '').trim();
    }
    if (/douyin\.com$/i.test(t.hostname)) {
      const m = t.pathname.match(/\/search\/(.+)$/);
      if (m) return decodeURIComponent(m[1]).trim();
    }
  } catch (e) { /* ignore */ }
  return '';
}

async function weiboPosts(title, limit) {
  const t = String(title || '').replace(/^#+|#+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const cid = '100103type=1&t=10&q=#' + t + '#';
  const j = await wbJson('/api/container/getIndex?containerid=' + encodeURIComponent(cid) + '&page_type=searchall');
  const rows = [];
  for (const c of (j.data && j.data.cards) || []) {
    const mb = c && c.card_type === 9 && c.mblog;
    if (!mb) continue;
    const txt = tidyText(stripTags(String(mb.text || '')));
    if (txt.length < 20) continue;
    rows.push(((mb.user && mb.user.screen_name) ? mb.user.screen_name + '：' : '') + txt);
    if (rows.length >= (limit || 6)) break;
  }
  if (!rows.length) return null;
  const text = ('微博话题「' + t + '」下正在讨论的原文（按搜索结果顺序）\n\n' + rows.join('\n\n')).slice(0, TEXT_LIMIT);
  return { title: '#' + t + '#', text, chars: text.length, via: 'weibo', note: '话题页由脚本动态渲染，这里取的是该话题下微博正文' };
}

const NEWS_RE = /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>[\s\S]{0,600}?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

function newsQueries(title) {
  const base = String(title || '').replace(/[#【】\[\]「」“”"'!?！？,，、|/：:]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  if (base) out.push(base);
  const segs = base.split(' ').filter((x) => x.length >= 2);
  if (segs.length > 1) out.push(segs.slice(0, 2).join(' '));
  [12, 8, 5].forEach((n) => { if (base.length > n) out.push(base.slice(0, n)); });
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
  const { html } = await grab(new URL('https://cn.bing.com/search?q=' + encodeURIComponent(title) + '&setlang=zh-CN'), UA_DESKTOP);
  const out = [];
  BING_RE.lastIndex = 0;
  let m;
  while ((m = BING_RE.exec(html)) && out.length < (limit || 6)) {
    const link = m[1].replace(/&amp;/g, '&');
    const t2 = tidyText(stripTags(m[2]));
    if (!link || !t2 || skipHost(link)) continue;
    if (out.some((x) => x.url === link)) continue;
    out.push({ url: link, title: t2.slice(0, 80) });
  }
  return out;
}

async function baiduNews(title, limit) {
  const { html } = await grab(new URL('https://www.baidu.com/s?tn=news&word=' + encodeURIComponent(title)), UA_MOBILE);
  const out = [];
  NEWS_RE.lastIndex = 0;
  let m;
  while ((m = NEWS_RE.exec(html)) && out.length < (limit || 6)) {
    const link = m[1].replace(/&amp;/g, '&');
    const t2 = tidyText(stripTags(m[2]));
    if (!link || !t2 || /baidu\.com\/link/.test(link) || skipHost(link)) continue;
    if (out.some((x) => x.url === link)) continue;
    out.push({ url: link, title: t2.slice(0, 80) });
  }
  return out;
}

async function relatedParse(title) {
  for (const q of newsQueries(title).slice(0, 3)) {
    let news = [];
    try { news = await bingSearch(q, 6); } catch (e) { news = []; }
    if (!news.length) {
      try { news = await baiduNews(q, 6); } catch (e) { news = []; }
    }
    for (const n of news.slice(0, 3)) {
      if (skipHost(n.url)) continue;
      try {
        const { html } = await grab(new URL(n.url), UA_MOBILE);
        const out = extract(html);
        if (out.text.length < 180) continue;
        if (!titleMatch(out.text, title)) continue;
        return {
          title: out.title || n.title,
          text: out.text.slice(0, TEXT_LIMIT),
          chars: out.text.length,
          via: 'related',
          related: n,
          note: '原页面抓不到正文，这里是对同一事件的报道'
        };
      } catch (e) { /* next */ }
    }
  }
  return null;
}


const JUNK_RE = /(参数错误|请升级客户端|去验证|环境异常|开启JavaScript|访问过于频繁|页面不存在|内容不存在|该内容已被删除|404 Not Found)/;

function chineseRatio(t) {
  const cn = (String(t).match(/[\u4e00-\u9fa5]/g) || []).length;
  return cn / Math.max(1, String(t).length);
}

function usable(t, min) {
  const x = String(t || '').trim();
  if (x.length < (min || 120)) return false;
  if (JUNK_RE.test(x.slice(0, 240))) return false;
  if (chineseRatio(x) < 0.25) return false;
  return true;
}

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

async function weiboStatus(id) {
  const j = await wbJson('/statuses/show?id=' + encodeURIComponent(id));
  const d = j && j.data;
  if (!d || !d.text) return null;
  const body = tidyText(stripTags(String(d.text)));
  if (!body || body.length < 6) return null;
  const who = (d.user && d.user.screen_name) || '';
  let text = (who ? who + '：' : '') + body;
  const rt = d.retweeted_status;
  if (rt && rt.text) {
    const sub = tidyText(stripTags(String(rt.text)));
    if (sub) text += '\n\n// 转发自 ' + ((rt.user && rt.user.screen_name) || '') + '：' + sub;
  }
  if (!usable(text, 20)) return null;
  return {
    title: body.slice(0, 40),
    text: text.slice(0, TEXT_LIMIT),
    chars: text.length,
    via: 'weibo',
    note: '这是这条微博的原文',
    related: { url: 'https://m.weibo.cn/detail/' + id, title: '原微博' }
  };
}

function cleanShellTitle(t) {
  let x = String(t || '').replace(/\s+/g, ' ').trim();
  x = x.replace(/\s*[-_|｜]\s*(微博|新浪微博|抖音|抖音搜索|快手|小红书|知乎|百度|百度搜索|今日头条|头条|哔哩哔哩|bilibili).*$/i, '');
  x = x.replace(/^(微博|抖音|快手|小红书|知乎|百度|今日头条)[\-_|｜:：\s]*/i, '');
  if (/^(微博|抖音|快手|小红书|知乎|百度|头条|哔哩哔哩)$/i.test(x)) return '';
  if (x.length < 4) return '';
  return x.slice(0, 60);
}

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

async function parseUrl(raw, hintTitle) {
  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');
  if (isPrivateHost(target.hostname)) throw new Error('不支持内网地址');

  const isWx = /mp\.weixin\.qq\.com/.test(target.hostname);
  const need = isWx ? 90 : 120;

  const hit = cachedGet('p:' + target.href);
  if (hit && hit.text && hit.text.length >= need) return hit;

  let lastErr = '';
  let bestHtml = '';
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    try {
      const { html } = await grab(target, ua);
      if (html && html.length > bestHtml.length) bestHtml = html;
      if (/环境异常|去验证|该内容已被发布者删除|此内容因违规无法查看|该公众号已迁移/.test(html) &&
          !/id=["']js_content["']/.test(html)) {
        lastErr = '微信拦住了解析（文章可能已被删除，或只在微信内可看）';
        continue;
      }
      const out = extract(html);
      if (out.text.length >= need && usable(out.text, need)) {
        const value = { title: out.title, text: out.text.slice(0, TEXT_LIMIT), chars: out.text.length, via: 'direct' };
        cachedSet('p:' + target.href, value);
        return value;
      }
      if (JUNK_RE.test(out.text.slice(0, 120))) lastErr = isWx ? '这篇公众号文章打不开（链接可能已失效或被删除）' : '站点返回的是拦截页，不是正文';
      else lastErr = '正文只有 ' + out.text.length + ' 字';
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? '抓取超时' : (e && e.message) || '抓取失败';
    }
  }

  const wid = weiboIdOf(raw);
  if (wid) {
    try {
      const st = await weiboStatus(wid);
      if (st) return st;
    } catch (e) { /* 继续 */ }
  }

  const dig = bestHtml ? digestOf(bestHtml) : null;
  let title = String(hintTitle || '').trim() || guessTitle(raw);
  if (!title && dig && dig.title) title = cleanShellTitle(dig.title);

  if (title && /weibo\.(com|cn)$/i.test(target.hostname)) {
    try {
      const w = await weiboPosts(title);
      if (w) return w;
    } catch (e) { /* 继续兜底 */ }
  }
  if (title) {
    try {
      const rel = await relatedParse(title);
      if (rel) return rel;
    } catch (e) { /* 继续兜底 */ }
  }
  if (dig && usable(dig.text, 50)) {
    const t2 = cleanShellTitle(dig.title) || dig.title;
    return {
      title: t2,
      text: dig.text,
      chars: dig.text.length,
      via: 'digest',
      note: '这页正文由脚本渲染，这里是页面自带的标题与摘要',
      related: { url: target.href, title: t2 }
    };
  }
  const err = new Error(lastErr || '解析失败');
  err.title = title;
  throw err;
}

async function metaFor(url, srcId) {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');
  if (isPrivateHost(target.hostname)) throw new Error('不支持内网地址');

  const hit = cachedGet('h:' + target.href);
  if (hit) return metaOf(hit.html, target, srcId);

  let lastErr = '';
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    try {
      const { html } = await grab(target, ua);
      cachedSet('h:' + target.href, { html });
      return metaOf(html, target, srcId);
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? '抓取超时' : (e && e.message) || '抓取失败';
    }
  }
  throw new Error(lastErr || '取不到页面信息');
}

/* ---------------- 榜单封面：抖音 word_cover / 头条 Image / B站 pic ---------------- */
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
   m.weibo.cn 要求 .weibo.cn 的访客票（visitor.passport.weibo.cn 签），这里自己取一张并缓存。 */
let wbVisitor = { ck: '', at: 0 };
const wbCache = new Map();

async function wbCookie(force) {
  if (!force && wbVisitor.ck && Date.now() - wbVisitor.at < 30 * 60 * 1000) return wbVisitor.ck;
  const H = { 'User-Agent': UA_MOBILE, Referer: 'https://m.weibo.cn/' };
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
  } catch (e) { /* 这个源拿不到就当没有封面 */ }
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

/* ---------------- HTTP ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS
    }
  });
}

const LANDING = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>文匠解析服务</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#e7ecf3;
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
 .card{max-width:560px;padding:32px 28px;border-radius:20px;background:#161b23;border:1px solid #232a35}
 h1{font-size:19px;margin:0 0 6px} .ok{color:#4ade80} code{background:#0b0f14;padding:2px 6px;border-radius:6px;font-size:13px}
 p{color:#9aa7b8;margin:8px 0} a{color:#7dd3fc}
</style></head><body><div class="card">
<h1>文匠解析服务 <span class="ok">运行中</span></h1>
<p>把下面这个地址填进 App 的「我的 → 解析服务」即可：</p>
<p><code id="u"></code></p>
<p>接口：<code>GET /api/parse?url=</code> · <code>GET /api/meta?url=</code> · 健康检查 <code>GET /api/health</code></p>
<p>把 <code>/api/health</code> 这段去掉，剩下的就是根地址。</p>
<script>document.getElementById('u').textContent=location.origin;</script>
</div></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ ok: false, error: '只支持 GET' }, 405);
    }

    const key = env && env.PARSE_KEY;
    if (key && url.searchParams.get('key') !== key && url.pathname.startsWith('/api/')) {
      return json({ ok: false, error: '缺少访问口令' }, 401);
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, version: VERSION, runtime: 'worker' });
    }

    if (url.pathname === '/api/parse') {
      const target = readTarget(url);
      if (!target) return json({ ok: false, error: '缺少 url 参数' }, 400);
      try {
        const out = await parseUrl(target, url.searchParams.get('title') || '');
        return json({
          ok: true,
          title: out.title,
          text: out.text,
          chars: out.chars,
          via: out.via || 'direct',
          note: out.note || '',
          related: out.related || null
        });
      } catch (e) {
        return json({ ok: false, error: (e && e.message) || '解析失败', code: 'PARSE_FAIL' }, 200);
      }
    }

    if (url.pathname === '/api/meta') {
      const target = readTarget(url);
      if (!target) return json({ ok: false, error: '缺少 url 参数' }, 400);
      try {
        const meta = await metaFor(target, url.searchParams.get('src') || '');
        return json(Object.assign({ ok: true }, meta));
      } catch (e) {
        return json({ ok: false, error: (e && e.message) || '取不到页面信息' }, 200);
      }
    }

    if (url.pathname === '/api/img') {
      const target = url.searchParams.get('u') || '';
      let t;
      try { t = new URL(target); } catch (e) { return new Response('bad url', { status: 400 }); }
      if (!/^https?:$/.test(t.protocol) || !/(^|\.)(sinaimg\.cn|weibocdn\.com)$/i.test(t.hostname)) {
        return new Response('forbidden host', { status: 403 });
      }
      const r = await fetch(t.href, {
        headers: {
          'User-Agent': UA_DESKTOP,
          Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
          Referer: 'https://weibo.com/'
        }
      });
      if (!r.ok) return new Response('upstream ' + r.status, { status: 502 });
      const ct = r.headers.get('content-type') || '';
      if (!/^image\//i.test(ct)) return new Response('not image', { status: 502 });
      return new Response(r.body, {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    if (url.pathname === '/api/cover') {
      const src = url.searchParams.get('src') || '';
      const title = url.searchParams.get('title') || '';
      if (!src || !title) return json({ ok: false, error: '缺少参数' }, 400);
      return json(await coverFor(src, title));
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(LANDING, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    return json({ ok: false, error: '接口不存在' }, 404);
  }
};
