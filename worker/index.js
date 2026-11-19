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

const VERSION = '3.0.0';
const MAX_BYTES = 12 * 1024 * 1024;
const TEXT_LIMIT = 12000;
const TIMEOUT = 13000;

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/* ---------------- 正文抽取 ---------------- */

const NOISE =
  /^(登录|注册|下载客户端|扫码|打开APP|广告|版权所有|免责声明|责任编辑|点击查看|上一篇|下一篇|相关阅读|热门推荐|分享到|阅读原文)/;

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

async function parseUrl(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');
  if (isPrivateHost(target.hostname)) throw new Error('不支持内网地址');

  const hit = cachedGet('p:' + target.href);
  if (hit) return hit;

  let lastErr = '';
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    try {
      const { html } = await grab(target, ua);
      if (/环境异常|去验证|该内容已被发布者删除|此内容因违规无法查看|该公众号已迁移/.test(html) &&
          !/id=["']js_content["']/.test(html)) {
        lastErr = '微信拦住了解析（文章可能已被删除，或只在微信内可看）';
        continue;
      }
      const isWx = /mp\.weixin\.qq\.com$/.test(target.hostname);
      const out = extract(html);
      const need = isWx ? 90 : 120;
      if (out.text.length >= need) {
        const value = { title: out.title, text: out.text.slice(0, TEXT_LIMIT), chars: out.text.length };
        cachedSet('p:' + target.href, value);
        return value;
      }
      lastErr = '正文只有 ' + out.text.length + ' 字（这个页面可能由脚本渲染，或要求登录）';
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? '抓取超时' : (e && e.message) || '抓取失败';
    }
  }
  throw new Error(lastErr || '解析失败');
}

/* ---------------- 元信息：分类 / 发布时间 / 头图 / 原图 ---------------- */

const CATS = [
  ['科技数码', /(手机|芯片|处理器|半导体|AI|人工智能|大模型|模型|苹果|iPhone|华为|小米|OPPO|vivo|荣耀|三星|特斯拉|SpaceX|机器人|算法|开源|软件|系统|鸿蒙|安卓|iOS|笔记本|显卡|GPU|算力|数据中心|卫星|火箭|量子|发布会|新品)/g],
  ['财经商业', /(股价|市值|营收|财报|融资|上市|IPO|收购|并购|裁员|降薪|涨价|降价|消费|电商|零售|品牌|市场|经济|投资|基金|利率|关税|供应链|工厂|产能)/g],
  ['汽车出行', /(汽车|车型|续航|试驾|新能源|电车|充电|智驾|自动驾驶|车企|比亚迪|理想|蔚来|小鹏|问界|油车)/g],
  ['娱乐影视', /(电影|剧集|电视剧|综艺|明星|演员|导演|票房|演唱会|音乐|专辑|番剧|动漫|二次元|红毯|官宣)/g],
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
  if (!s || /^data:|^javascript:/i.test(s)) return '';
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
  const d = new Date(s.replace(/\./g, '-'));
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return d.toISOString();
  return '';
}

function metaOf(html, target, srcId) {
  const h = String(html);
  const m = metaTags(h);
  const base = target.origin + '/';

  const ld = {};
  for (const b of h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(b[1].trim());
      for (const one of (Array.isArray(j) ? j : [j])) {
        if (!one || typeof one !== 'object') continue;
        if (one['@graph']) for (const g of one['@graph']) Object.assign(ld, g);
        else Object.assign(ld, one);
      }
    } catch (e) { /* 站点写坏的 JSON-LD 很常见 */ }
  }

  const title = m['og:title'] || m['twitter:title'] || ld.headline ||
    (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = m['og:description'] || m['description'] || m['twitter:description'] || ld.description || '';
  const wxCt = (h.match(/var\s+ct\s*=\s*["'](\d{9,13})["']/) || [])[1];
  const wxName = (h.match(/var\s+nickname\s*=\s*["']([^"']+)["']/) || [])[1];

  const published = normTime(
    m['article:published_time'] || m['og:release_date'] || m['pubdate'] ||
    ld.datePublished || ld.dateCreated || wxCt ||
    (h.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1] ||
    /* 国内站点大多把时间写在 span 里，没有 og / JSON-LD */
    (h.match(/(?:pubtime|publish[-_]?time|post[-_]?time|article[-_]?time|time[-_]?source)[^>]*>\s*([^<]{8,32})</i) || [])[1] ||
    (h.match(/(20\d{2}[-/年]\s?\d{1,2}[-/月]\s?\d{1,2}日?\s+\d{1,2}:\d{2})/) || [])[1]
  );

  const site = m['og:site_name'] || wxName || (ld.publisher && ld.publisher.name) ||
    target.hostname.replace(/^www\./, '');
  const author = m['article:author'] || m['author'] || wxName ||
    (ld.author && (ld.author.name || (Array.isArray(ld.author) ? ld.author[0].name : ''))) || '';
  const section = m['article:section'] || '';
  const keywords = (m['keywords'] || ld.keywords || '')
    .split(/[,，;；|]/).map((x) => x.trim()).filter((x) => x && x.length < 16).slice(0, 6);

  const raw = [
    m['og:image'], m['og:image:url'], m['twitter:image'], m['twitter:image:src'],
    (h.match(/var\s+msg_cdn_url\s*=\s*["']([^"']+)["']/) || [])[1],
    typeof ld.image === 'string' ? ld.image : (Array.isArray(ld.image) ? ld.image[0] : (ld.image && ld.image.url))
  ];
  const inner = [...h.matchAll(/<img[^>]+?(?:data-src|data-original|data-echo|src)\s*=\s*["']([^"']+)["']/gi)]
    .map((x) => x[1]).slice(0, 14);

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

  return {
    title: tidyText(stripTags(title)).slice(0, 120),
    desc: tidyText(stripTags(desc)).slice(0, 260),
    site: String(site || '').slice(0, 40),
    author: String(author || '').slice(0, 40),
    published,
    section: String(section || '').slice(0, 20),
    category: classify(title, [desc, keywords.join(' '), section].join(' '), SOURCE_CAT[srcId] || ''),
    keywords,
    images,
    head: images[0] || ''
  };
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
      const target = url.searchParams.get('url');
      if (!target) return json({ ok: false, error: '缺少 url 参数' }, 400);
      try {
        const out = await parseUrl(target);
        return json({ ok: true, title: out.title, text: out.text, chars: out.chars, via: 'worker' });
      } catch (e) {
        return json({ ok: false, error: (e && e.message) || '解析失败' }, 200);
      }
    }

    if (url.pathname === '/api/meta') {
      const target = url.searchParams.get('url');
      if (!target) return json({ ok: false, error: '缺少 url 参数' }, 400);
      try {
        const meta = await metaFor(target, url.searchParams.get('src') || '');
        return json(Object.assign({ ok: true }, meta));
      } catch (e) {
        return json({ ok: false, error: (e && e.message) || '取不到页面信息' }, 200);
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(LANDING, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    return json({ ok: false, error: '接口不存在' }, 404);
  }
};
